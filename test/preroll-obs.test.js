import test from "node:test";
import assert from "node:assert/strict";
import PublicProgramController from "../public/js/public/PublicProgramController.js";
import trace, { RuntimeTrace } from "../public/js/core/RuntimeTrace.js";
import NetworkProgramOutputTransport from "../public/js/program-output/NetworkProgramOutputTransport.js";
import { createProgramOutputEnvelope } from "../public/js/program-output/ProgramOutputEnvelope.js";

const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
class Element extends EventTarget {
    constructor(tag) { super(); Object.assign(this, { tagName: tag.toUpperCase(), children: [],
        parent: null, readyState: 0, currentTime: 0, duration: 60, paused: false,
        style: {}, dataset: {}, classList: { add() {}, remove() {} }, loads: 0 }); }
    appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children.forEach(child => { child.parent = null; });
        this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
        this.parent = null; }
    querySelector(tag) { return this.children.find(x => x.tagName === tag.toUpperCase()) || null; }
    setAttribute() {} removeAttribute(name) { if (name === "src") this.src = ""; }
    canPlayType() { return "probably"; }
    play() { this.playCalls = (this.playCalls || 0) + 1; return this.playResult || Promise.resolve(); }
    pause() { this.paused = true; } load() { this.loads++; }
}
const snapshot = (revision, kind) => ({ version: 1, revision, publisherSessionId: "test-session",
    publishedAt: new Date().toISOString(), committedAt: new Date().toISOString(),
    scene: { id: kind, name: kind, type: kind === "hls" ? "LIVE" : "MEDIA" },
    source: { id: kind, kind, url: `https://example.test/${kind}` },
    playback: { initialTime: 0, duration: null, playing: true, ended: false,
        state: "playing", startedAt: new Date().toISOString() },
    graphics: { items: [] }, overlays: {}, transition: { type: "cut", durationMs: 0 } });

async function harness(mode, run) {
    const previousDocument = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tag) { const el = new Element(tag); created.push(el); return el; } };
    const base = new Element("div"), graphics = new Element("div");
    const root = { querySelector: selector => selector === "[data-public-base]" ? base : graphics };
    const controller = new PublicProgramController({ root, outputMode: mode,
        transport: { destroy() {} }, audioButton: null, status: null });
    controller.renderGraphics = () => {}; controller.renderOverlays = () => {};
    try { await run({ controller, base, created }); }
    finally { controller.destroy(); globalThis.document = previousDocument; }
}


const connect = controller => {
    const stream = new EventTarget(); stream.readyState = 1; stream.close = () => {};
    controller.transport = new NetworkProgramOutputTransport({ role: "subscriber",
        subscribeUrl: "http://example.test/events", eventSourceFactory: () => stream });
    controller.start();
    return value => stream.dispatchEvent(new MessageEvent("program", {
        data: JSON.stringify(createProgramOutputEnvelope(value)) }));
};

async function withHls(run) {
    const previous = globalThis.Hls, native = Element.prototype.canPlayType; const instances = [];
    class Hls {
        static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
        static isSupported() { return true; }
        constructor() { this.handlers = new Map(); instances.push(this); }
        on(event, fn) { this.handlers.set(event, fn); }
        loadSource() {} attachMedia(video) { this.video = video; }
        destroy() { this.destroyed = true; }
        emit(event, data) { this.handlers.get(event)?.(event, data); }
    }
    globalThis.Hls = Hls; Element.prototype.canPlayType = () => "";
    try { await run(instances); }
    finally { globalThis.Hls = previous; Element.prototype.canPlayType = native; }
}

test("already-open OBS and Public accept and promote the same first LIVE SSE revision", async () => {
    const a = snapshot(1, "media"), live = snapshot(2, "hls"); const promoted = [];
    for (const mode of ["obs", "public"]) await harness(mode, async ({ controller, base, created }) => {
        const send = connect(controller); send(a);
        created.at(-1).dispatchEvent(new Event("canplay")); await flush(); const outgoing = controller.current;
        send(live); const video = created.at(-1);
        assert.equal(base.children.includes(video.parent), true, "HLS preparation must be connected in both modes");
        assert.ok(video.playCalls > 0, "playback requested before readiness");
        assert.equal(video.muted, mode === "public", "OBS retains audible autoplay");
        video.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(outgoing.released, true); promoted.push(controller.current.snapshot);
    });
    assert.deepEqual(promoted[0], promoted[1]);
});

test("delayed OBS readiness and pending play converge without refreshing", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await harness("obs", async ({ controller, created }) => {
        const send = connect(controller); send(snapshot(1, "media"));
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        send(snapshot(2, "hls")); const video = created.at(-1); video.playResult = new Promise(() => {});
        context.mock.timers.tick(6000); await flush();
        assert.equal(controller.current.snapshot.source.kind, "media");
        video.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.source.kind, "hls");
    });
});

test("OBS preparation timeout removes old A and retries retained LIVE without a new SSE revision", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await harness("obs", async ({ controller, created }) => {
        const send = connect(controller); send(snapshot(1, "media"));
        created.at(-1).dispatchEvent(new Event("canplay")); await flush(); const old = controller.current;
        send(snapshot(2, "hls")); context.mock.timers.tick(12000); await flush();
        assert.equal(old.released, true); assert.equal(controller.current, null);
        context.mock.timers.tick(1000); await flush();
        assert.equal(controller.pendingRender.snapshot.revision, 2);
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.revision, 2);
    });
});

test("fresh and long-open OBS converge to the same retained LIVE", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const live = snapshot(2, "hls"); const outputs = [];
    for (const fresh of [false, true]) await harness("obs", async ({ controller, created }) => {
        if (!fresh) {
            controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true });
            created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            context.mock.timers.tick(30 * 60 * 1000);
        }
        controller.handleSnapshot(live, { livePublisher: !fresh });
        created.at(-1).dispatchEvent(new Event("canplay")); await flush(); outputs.push(controller.current.snapshot);
    });
    assert.deepEqual(outputs[0], outputs[1]);
});

test("OBS HLS fatal preparation retries and stale A callbacks cannot cancel it", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await withHls(async instances => harness("obs", async ({ controller, created }) => {
        controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true }); const stale = created.at(-1);
        controller.handleSnapshot(snapshot(2, "hls"), { livePublisher: true });
        instances[0].emit("error", { fatal: true }); await flush();
        context.mock.timers.tick(1000); await flush();
        assert.equal(instances.length, 2);
        stale.dispatchEvent(new Event("canplay")); instances[0].emit("manifest");
        const current = created.at(-1); current.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.getCurrentMedia(), current);
        assert.equal(controller.current.snapshot.revision, 2);
    }));
});
