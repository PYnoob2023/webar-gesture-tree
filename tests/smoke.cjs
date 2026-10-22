// Offline behavior checks for the page; no webcam, browser or third-party test dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(source);

function page({ libraries = true, width = 1280, height = 720, error = null } = {}) {
    const elements = new Map();
    const events = {};
    const frames = new Map();
    let nextFrame = 0;
    const ctx = new Proxy({}, { get: (obj, key) => obj[key] || (() => {}), set: (obj, key, value) => (obj[key] = value, true) });
    function element(id) {
        if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: '', srcObject: null,
            videoWidth: 1280, videoHeight: 720, getContext: () => ctx,
            addEventListener(name, callback) { this[name] = callback; } });
        return elements.get(id);
    }
    const context = { console, now: 1000, innerWidth: width, innerHeight: height, devicePixelRatio: 2,
        isSecureContext: true, navigator: { mediaDevices: {} },
        document: { hidden: false, getElementById: element, body: { classList: { add() {}, remove() {} } },
            addEventListener(name, callback) { events[name] = callback; } },
        performance: { now: () => context.now }, matchMedia: () => ({ matches: false }),
        requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame(id) { frames.delete(id); },
        addEventListener(name, callback) { events[name] = callback; },
    };
    context.window = context;
    if (libraries) {
        context.Hands = class {
            constructor() { context.detector = this; }
            setOptions() {}
            onResults(callback) { this.result = callback; }
            async send() { if (context.frameError) throw context.frameError; }
            async close() { this.closed = true; }
        };
        context.Camera = class {
            constructor(video, options) { this.video = video; this.options = options; context.webcam = this; }
            async start() {
                if (error) throw error;
                const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
                context.track = track;
                this.video.srcObject = { getTracks: () => [track], getVideoTracks: () => [track] };
            }
            async stop() { this.stopped = true; }
        };
    }
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, elements, events, frames, eval: code => vm.runInContext(code, context) };
}

function hand(mode, scale = 1) {
    const points = Array.from({ length: 21 }, () => ({ x: .5, y: .8 }));
    const place = (id, dx, dy) => points[id] = { x: .5 + dx * scale, y: .8 + dy * scale };
    place(5, 0, -.1);
    place(3, -.04, -.07);
    place(4, -.12, -.12);
    const extended = mode === 'open' ? [8, 12, 16, 20] : mode === 'victory' ? [8, 12] : mode === 'point' ? [8] : [];
    for (const id of [8, 12, 16, 20]) place(id, 0, extended.includes(id) ? -.25 : -.05);
    return points;
}

test('scene initializes with 1501 particles and one independent render loop', () => {
    const p = page({ libraries: false });
    assert.equal(p.eval('particles.length'), 1501);
    assert.equal(p.frames.size, 1);
});
test('preview works even when MediaPipe is missing', async () => {
    const p = page({ libraries: false });
    p.eval('showPreview()');
    await p.eval('startCamera()');
    assert.equal(p.elements.get('loading').hidden, true);
    assert.match(p.elements.get('live-status').textContent, /资源尚未就绪/);
    assert.equal(p.eval('starting'), false);
});
test('portrait scene scales down and high-DPI canvas stays sharp', () => {
    const p = page({ width: 390, height: 844 });
    assert.equal(p.elements.get('output-canvas').width, 780);
    assert.ok(p.eval('sceneScale') < .6);
});
test('gesture classification is relative to hand size', () => {
    const p = page();
    for (const mode of ['open', 'victory', 'fist', 'point']) {
        for (const scale of [.4, 1, 1.5]) {
            p.context.points = hand(mode, scale);
            assert.equal(p.eval('classifyHand(points).mode'), mode);
        }
    }
});
test('invalid tracking is handled without throwing', () => {
    const p = page();
    p.context.points = Array(21).fill({ x: NaN, y: 0 });
    assert.equal(p.eval('classifyHand(points)'), null);
    p.eval('onHandResults({})');
    assert.equal(p.eval('tracking'), false);
});
test('shape changes only after three consecutive detections', () => {
    const p = page();
    p.context.points = hand('open');
    p.eval('onHandResults({multiHandLandmarks:[points]})');
    p.eval('onHandResults({multiHandLandmarks:[points]})');
    assert.equal(p.eval('targetShape'), 'tree');
    p.eval('onHandResults({multiHandLandmarks:[points]})');
    assert.equal(p.eval('targetShape'), 'sphere');
    assert.equal(p.frames.size, 1); // Results never start an extra animation loop.
});
test('losing a hand resets neon and movement history', () => {
    const p = page();
    p.context.points = hand('victory');
    p.eval('for(let n=0;n<3;n++) onHandResults({multiHandLandmarks:[points]})');
    assert.equal(p.eval('colorMode'), 'disco');
    p.eval('onHandResults({multiHandLandmarks:[]})');
    assert.equal(p.eval('colorMode'), 'normal');
    assert.equal(p.eval('lastIndex'), null);
});
test('video coordinates follow cover cropping and mirror', () => {
    const p = page({ width: 390, height: 844 });
    const middle = p.eval('videoPoint({x:.5,y:.5})');
    assert.equal(middle.x, 195);
    assert.equal(middle.y, 422);
    assert.ok(p.eval('videoPoint({x:.6,y:.5}).x') < 100);
});
test('finger displacement actually contributes to spark inertia', () => {
    const p = page();
    p.context.points = hand('point');
    p.eval('onHandResults({multiHandLandmarks:[points]})');
    p.context.points[8].x -= .02;
    p.eval('Math.random = () => 0');
    p.eval('onHandResults({multiHandLandmarks:[points]})');
    assert.ok(p.eval('sparks[sparks.length-1].vx') > 2);
});
test('particle emission has a hard cap', () => {
    const p = page();
    p.context.points = hand('point');
    p.eval('for(let n=0;n<1000;n++) onHandResults({multiHandLandmarks:[points]})');
    assert.ok(p.eval('sparks.length') <= 600);
});
test('permission denial recovers the start controls', async () => {
    const p = page({ error: { name: 'NotAllowedError' } });
    await p.eval('startCamera()');
    assert.equal(p.elements.get('start').disabled, false);
    assert.equal(p.eval('cameraOn'), false);
    assert.match(p.elements.get('status').textContent, /未获授权/);
});
test('camera is opt-in and stop releases its media track', async () => {
    const p = page();
    assert.equal(p.context.webcam, undefined);
    await p.eval('startCamera()');
    assert.equal(p.eval('cameraOn'), true);
    assert.equal(p.elements.get('loading').hidden, true);
    await p.eval('stopCamera()');
    assert.equal(p.context.track.stopped, true);
    assert.equal(p.eval('cameraOn'), false);
});
test('inference failure stops the camera and shows a recoverable error', async () => {
    const p = page();
    await p.eval('startCamera()');
    p.context.frameError = new Error('model unavailable');
    await p.context.webcam.options.onFrame();
    assert.equal(p.eval('cameraOn'), false);
    assert.equal(p.context.track.stopped, true);
    assert.match(p.elements.get('live-status').textContent, /未能启动/);
});
test('hidden page pauses render and resumes with one loop', () => {
    const p = page();
    p.context.document.hidden = true;
    p.events.visibilitychange();
    assert.equal(p.frames.size, 0);
    p.context.document.hidden = false;
    p.events.visibilitychange();
    assert.equal(p.frames.size, 1);
});
test('insecure camera access gives instructions instead of crashing', async () => {
    const p = page();
    p.context.isSecureContext = false;
    await p.eval('startCamera()');
    assert.match(p.elements.get('status').textContent, /HTTPS/);
    assert.equal(p.context.webcam, undefined);
});
test('back-forward restoration cannot create a second animation loop', () => {
    const p = page();
    p.events.pageshow({ persisted: true });
    p.events.visibilitychange();
    assert.equal(p.frames.size, 1);
});
