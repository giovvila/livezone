import OperatorAuth from '../server/auth/OperatorAuth.js';
import { AUTO_LIVE_ENTRY_ID, AUTO_LIVE_ENTRY_TITLE, AUTO_LIVE_ENTRY_MESSAGE } from "../public/js/program-output/AutoLiveEntrySlate.js";
import { createProgramOutputServer } from '../test-support/ReferenceAuthorityTestServer.js';
import { AUTO_LIVE_LOSS_SLATE_ID, AUTO_LIVE_LOSS_TEXT } from "../public/js/program-output/AutoLiveLossSlate.js";
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


test("Public native LIVE starts muted playback before readiness without waiting for play promise", async () => {
    await harness("public", async ({ controller, created }) => {
        controller.audioEnabled = true;
        controller.handleSnapshot(snapshot(1, "hls"), { livePublisher: true });
        const video = created.at(-1);
        assert.equal(video.muted, true, "visual preparation must not depend on audio permission");
        assert.equal(video.playCalls > 0, true, "native HLS must request playback before readiness");
        video.playResult = new Promise(() => {});
        video.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.source.kind, "hls");
        assert.equal(video.muted, false, "saved audio preference is attempted after promotion");
    });
});

const connect = controller => {
    const stream = new EventTarget(); stream.readyState = 1; stream.close = () => {};
    controller.transport = new NetworkProgramOutputTransport({ role: "subscriber",
        subscribeUrl: "http://example.test/events", eventSourceFactory: () => stream });
    controller.start();
    return value => stream.dispatchEvent(new MessageEvent("program", {
        data: JSON.stringify(createProgramOutputEnvelope(value)) }));
};

test("same SSE LIVE revision promotes in open Public and OBS and returns to authoritative cue", async () => {
    const a = snapshot(1, "media"), live = snapshot(2, "hls"), returned = snapshot(3, "media");
    const now = Date.now(); returned.playback.initialTime = 37;
    returned.playback.startedAt = new Date(now).toISOString();
    const enabled = trace.enabled; trace.enabled = true; trace.clear();
    try {
        for (const mode of ["public", "obs"]) await harness(mode, async ({ controller, created }) => {
            controller.now = () => now; const send = connect(controller);
            send(a); created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            const outgoing = controller.current;
            send(live); const video = created.at(-1);
            video.playResult = new Promise(() => {});
            assert.equal(video.muted, mode === "public");
            video.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.revision, live.revision);
            assert.equal(outgoing.released, true);
            send(returned); created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.revision, 3);
            assert.equal(controller.getCurrentMedia().currentTime, 37);
        });
        for (const mode of ["public", "obs"]) {
            const events = trace.snapshot().filter(e => e.scope === mode && e.revision === 2).map(e => e.event);
            for (const edge of ["snapshot-received", "snapshot-accepted", "surface-created", "hls-ready", "surface-ready", "surface-promoted"])
                assert.ok(events.includes(edge), `${mode}: ${edge}`);
        }
        assert.ok(trace.snapshot().some(e => e.scope === "network" && e.event === "sse-revision" && e.revision === 2));
    } finally { trace.enabled = enabled; trace.clear(); }
});

test("fresh retained Public and open Public converge with delayed native canplay", async () => {
    const live = snapshot(2, "hls"); const accepted = [];
    for (const fresh of [false, true]) await harness("public", async ({ controller, created }) => {
        if (!fresh) {
            controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true });
            created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        }
        controller.handleSnapshot(live, { livePublisher: !fresh });
        await flush(); assert.ok(controller.pendingRender);
        const video = created.at(-1); video.dispatchEvent(new Event("canplay")); await flush();
        accepted.push(controller.current.snapshot);
    });
    assert.deepEqual(accepted[0], accepted[1]);
});

test("native readiness requiring an explicit play request cannot deadlock muted Public", async () => {
    const original = Element.prototype.play;
    Element.prototype.play = function () {
        this.playCalls = (this.playCalls || 0) + 1;
        this.readyState = 2; this.dispatchEvent(new Event("canplay"));
        return new Promise(() => {});
    };
    try { await harness("public", async ({ controller }) => {
        controller.handleSnapshot(snapshot(1, "hls"), { livePublisher: true }); await flush();
        assert.equal(controller.current.snapshot.source.kind, "hls");
        assert.equal(controller.getCurrentMedia().muted, true);
    }); } finally { Element.prototype.play = original; }
});

test("Public readiness timeout retries latest LIVE and cannot leave old A forever", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await harness("public", async ({ controller, created }) => {
        controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true });
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        const old = controller.current;
        const live = snapshot(2, "hls"); controller.handleSnapshot(live, { livePublisher: true });
        context.mock.timers.tick(12000); await flush();
        assert.equal(old.released, true); assert.equal(controller.current, null);
        context.mock.timers.tick(1000); await flush();
        assert.equal(controller.pendingRender.snapshot.revision, 2);
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.revision, 2);
    });
});

test("obsolete A readiness and errors cannot cancel or retain the latest LIVE preparation", async () => {
    await harness("public", async ({ controller, created }) => {
        controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true }); const stale = created.at(-1);
        controller.handleSnapshot(snapshot(2, "hls"), { livePublisher: true }); const live = created.at(-1);
        stale.dispatchEvent(new Event("canplay")); stale.dispatchEvent(new Event("error")); await flush();
        assert.equal(controller.pendingRender.snapshot.revision, 2);
        live.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.getCurrentMedia(), live); assert.equal(stale.src, "");
    });
});

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

test("fatal HLS preparation fails promptly and retries latest revision without waiting twelve seconds", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await withHls(async instances => harness("public", async ({ controller, created }) => {
        const live = snapshot(2, "hls"); controller.handleSnapshot(live, { livePublisher: true });
        instances[0].emit("error", { fatal: true }); await flush();
        assert.equal(controller.pendingRender, null); assert.equal(instances[0].destroyed, true);
        context.mock.timers.tick(1000); await flush();
        assert.equal(instances.length, 2);
        const newest = { ...live, revision: 3 }; controller.handleSnapshot(newest, { livePublisher: true });
        instances[0].emit("manifest"); instances[0].emit("error", { fatal: true });
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.revision, 3);
    }));
});

test("outgoing HLS errors cannot repeatedly replace a newer pending Public LIVE surface", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await withHls(async instances => harness("public", async ({ controller, created }) => {
        const old = snapshot(1, "hls"); controller.handleSnapshot(old, { livePublisher: true });
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        const latest = snapshot(2, "hls"); latest.source.id = "testlive"; latest.source.url = "https://example.test/testlive.m3u8";
        controller.handleSnapshot(latest, { livePublisher: true }); const pending = controller.pendingRender;
        instances[0].emit("error", { fatal: true });
        context.mock.timers.tick(1000); await flush();
        assert.equal(controller.pendingRender, pending); assert.equal(instances.length, 2);
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.source.id, "testlive");
    }));
});

test("HLS.js warnings and delayed manifest do not make audio permission a visual promotion gate", async () => {
    await withHls(async instances => harness("public", async ({ controller, created }) => {
        controller.audioEnabled = true;
        controller.handleSnapshot(snapshot(1, "hls"), { livePublisher: true });
        const video = created.at(-1); assert.equal(video.muted, true);
        video.play = () => video.muted ? new Promise(() => {}) : Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
        instances[0].emit("error", { fatal: false }); instances[0].emit("manifest");
        video.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.source.kind, "hls");
        assert.equal(video.muted, true); assert.equal(controller.audioBlockedElement, video);
    }));
});

for (const mode of ["public", "obs"]) test(mode + " renders authoritative loss slate without replacing LIVE and rejects stale recovery", async () => {
    await harness(mode, async ({ controller, created }) => {
        controller.renderGraphics = PublicProgramController.prototype.renderGraphics;
        const live = snapshot(1, "hls");
        controller.handleSnapshot(live, { livePublisher: true });
        created.find(e => e.tagName === "VIDEO").dispatchEvent(new Event("canplay")); await flush();
        const player = controller.current;
        const loss = { ...live, revision: 2, graphics: { items: [{ id: AUTO_LIVE_LOSS_SLATE_ID,
            kind: "image", position: "top-left", url: "https://example.test/logo.svg" }] } };
        controller.handleSnapshot(loss, { livePublisher: true });
        assert.equal(controller.current, player);
        assert.equal(controller.lossSlateElement.children[1].textContent, AUTO_LIVE_LOSS_TEXT);
        assert.equal(controller.lossSlateElement.style.inset, "0");
        assert.ok(controller.lossSlateElement.style.background.includes("#07090d"));
        controller.handleSnapshot({ ...live, revision: 3 }, { livePublisher: true });
        assert.equal(controller.lossSlateElement, null);
        assert.equal(controller.current, player);
        const operator = snapshot(4, "media");
        controller.handleSnapshot(operator, { livePublisher: true });
        created.filter(e => e.tagName === "VIDEO").at(-1).dispatchEvent(new Event("canplay")); await flush();
        controller.handleSnapshot({ ...live, revision: 3 }, { livePublisher: true });
        assert.equal(controller.current.snapshot.source.kind, "media");
        assert.equal(controller.lossSlateElement, null);
    });
});
for (const mode of ["public", "obs"]) test(mode + " fresh subscriber shows loss slate while HLS readiness is pending", async () => {
    await harness(mode, async ({ controller }) => {
        controller.renderGraphics = PublicProgramController.prototype.renderGraphics;
        const live = snapshot(1, "hls");
        live.graphics.items = [{ id: AUTO_LIVE_LOSS_SLATE_ID, kind: "image", position: "top-left", url: "https://example.test/logo.svg" }];
        controller.handleSnapshot(live, { livePublisher: true });
        assert.ok(controller.pendingRender);
        assert.equal(controller.lossSlateElement.children[1].textContent, AUTO_LIVE_LOSS_TEXT);
        controller.renderWaiting("PROGRAM UNAVAILABLE");
        assert.equal(controller.lossSlateElement.children[1].textContent, AUTO_LIVE_LOSS_TEXT);
    });
});

test("real HTTP retained loss slate reaches both Public and OBS late subscribers", async context => {
    const token = "loss-slate-test-publisher-token";
    const { server } = createProgramOutputServer({ publisherToken: token, operatorAuth:new OperatorAuth({disabled:true}) });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise(resolve => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port;
    const live = snapshot(1, "hls");
    live.graphics.items = [{ id: AUTO_LIVE_LOSS_SLATE_ID, kind: "image", position: "top-left", url: base + "/assets/logo/logo-lz.svg" }];
    const response = await fetch(base + "/api/program-output", { method: "POST",
        headers: { Authorization: "Bearer " + token, "X-Livezone-Program-Manual":"1", "Content-Type": "application/json" },
        body: JSON.stringify(createProgramOutputEnvelope(live)) });
    assert.equal(response.status, 202);
    for (const mode of ["public", "obs"]) {
        const abort = new AbortController();
        try {
            const stream = await fetch(base + "/api/program-output/events", { signal: abort.signal });
            const reader = stream.body.getReader(); let data = "";
            while (!data.includes("data: ")) data += new TextDecoder().decode((await reader.read()).value);
            const envelope = JSON.parse(data.split("\n").find(line => line.startsWith("data: ")).slice(6));
            await harness(mode, async ({ controller }) => {
                controller.renderGraphics = PublicProgramController.prototype.renderGraphics;
                controller.handleSnapshot(envelope.snapshot, { livePublisher: true });
                assert.equal(controller.lossSlateElement.children[1].textContent, AUTO_LIVE_LOSS_TEXT);
                assert.deepEqual(envelope.snapshot.graphics, live.graphics);
            });
        } finally { abort.abort(); }
    }
});

for (const mode of ["public", "obs"]) for (const abandon of [false, true]) test(mode + " open subscriber follows ENTRY to " + (abandon ? "captured A" : "LIVE") + " without refresh", async () => {
    await harness(mode, async ({ controller, created }) => {
        const send = connect(controller);
        const a = snapshot(1, "media");
        send(a); created.filter(e => e.tagName === "VIDEO").at(-1).dispatchEvent(new Event("canplay")); await flush();
        const oldVideo = controller.getCurrentMedia();
        const entry = { ...snapshot(2, "media"),
            scene: { id: "entry-session", name: "AutoLive entry", type: "SLATE" },
            source: { id: AUTO_LIVE_ENTRY_ID, kind: "break", title: AUTO_LIVE_ENTRY_TITLE,
                message: AUTO_LIVE_ENTRY_MESSAGE, logoUrl: "https://example.test/logo.svg" },
            playback: { initialTime: 0, duration: null, playing: false, ended: false, state: "ready", startedAt: new Date().toISOString() } };
        send(entry); await flush();
        assert.equal(controller.current.snapshot.source.id, AUTO_LIVE_ENTRY_ID);
        assert.equal(oldVideo.paused, true, "A cannot continue behind the entry slate");
        const slate = controller.current.layer.children[0];
        assert.equal(slate.children[1].textContent, AUTO_LIVE_ENTRY_TITLE);
        assert.equal(slate.children[2].textContent, AUTO_LIVE_ENTRY_MESSAGE);
        assert.deepEqual(Object.keys(entry.source).sort(), ["id", "kind", "title", "message", "logoUrl"].sort(),
            "public representation contains only broadcast-safe slate fields");
        const next = snapshot(3, abandon ? "media" : "hls");
        next.playback.initialTime = abandon ? 37 : 0;
        send(next); created.filter(e => e.tagName === "VIDEO").at(-1).dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.source.kind, abandon ? "media" : "hls");
        if (abandon) assert.ok(controller.getCurrentMedia().currentTime >= 37 && controller.getCurrentMedia().currentTime < 38);
        assert.equal(controller.current.snapshot.revision, 3);
    });
});

for (const mode of ['public', 'obs']) {
    for (const healthy of [true, false]) test(`${mode} same-session LOSS clear ${healthy ? 'reuses progressing' : 'rebuilds stalled'} HLS once`, async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        await harness(mode, async ({ controller, created }) => {
            const send = connect(controller), live = snapshot(1, 'hls');
            send(live); const video = created.at(-1);
            video.readyState = 2; video.dispatchEvent(new Event('canplay')); await flush();
            const loss = { ...live, revision: 2, graphics: { items: [{ id: AUTO_LIVE_LOSS_SLATE_ID, kind: "image", position: "top-left", url: "https://example.test/logo.svg" }] } };
            send(loss); context.mock.timers.tick(mode === 'public' ? 3000 : 5000);
            send({ ...live, revision: 3 });
            assert.equal(controller.current.snapshot.revision, 3);
            assert.deepEqual(controller.current.snapshot.playback, live.playback);
            if (healthy) { video.currentTime++; video.dispatchEvent(new Event('timeupdate')); }
            context.mock.timers.tick(5000); await flush();
            const videos = created.filter(el => el.tagName === 'VIDEO');
            assert.equal(videos.length, healthy ? 1 : 2);
            if (!healthy) { videos.at(-1).readyState = 2; videos.at(-1).dispatchEvent(new Event('canplay')); await flush(); }
            assert.equal(controller.current.snapshot.source.id, live.source.id);
            assert.equal(controller.current.snapshot.scene.id, live.scene.id);
            assert.equal(controller.getCurrentMedia().muted, mode === 'public');
            context.mock.timers.tick(10000); await flush();
            assert.equal(created.filter(el => el.tagName === 'VIDEO').length, healthy ? 1 : 2);
        });
    });
}
for (const mode of ['public', 'obs']) for (const override of ['operator', 'destroy', 'new-loss'])
    test(`${mode} loss recovery is retired by ${override}`, async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        await harness(mode, async ({ controller, created }) => {
            const live = snapshot(1, 'hls');
            controller.handleSnapshot(live, { livePublisher: true });
            const video = created.at(-1); video.readyState = 2;
            video.dispatchEvent(new Event('canplay')); await flush();
            const loss = { ...live, revision: 2, graphics: { items: [{ id: AUTO_LIVE_LOSS_SLATE_ID,
                kind: 'image', position: 'top-left', url: 'https://example.test/logo.svg' }] } };
            controller.handleSnapshot(loss, { livePublisher: true });
            controller.handleSnapshot({ ...live, revision: 3 }, { livePublisher: true });
            const stale = controller.lossRecovery.progress;
            if (override === 'operator') {
                controller.handleSnapshot(snapshot(4, 'media'), { livePublisher: true });
                created.at(-1).dispatchEvent(new Event('canplay')); await flush();
            } else if (override === 'destroy') controller.destroy();
            else controller.handleSnapshot({ ...loss, revision: 4 }, { livePublisher: true });
            const count = created.filter(el => el.tagName === 'VIDEO').length;
            video.currentTime++; stale(); context.mock.timers.tick(5000); await flush();
            assert.equal(controller.lossRecovery, null);
            assert.equal(created.filter(el => el.tagName === 'VIDEO').length, count);
            if (override === 'operator') assert.equal(controller.current.snapshot.source.kind, 'media');
        });
    });
