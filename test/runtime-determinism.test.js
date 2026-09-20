import OperatorAuth from '../server/auth/OperatorAuth.js';
import test from "node:test";
import assert from "node:assert/strict";
import PublicProgramController from "../public/js/public/PublicProgramController.js";
import { RuntimeTrace } from "../public/js/core/RuntimeTrace.js";
import NetworkProgramOutputTransport from "../public/js/program-output/NetworkProgramOutputTransport.js";
import { createProgramOutputEnvelope } from "../public/js/program-output/ProgramOutputEnvelope.js";
import ProgramOutputManager from "../public/js/program-output/ProgramOutputManager.js";
import { bootstrapPublicProgram } from "../public/js/public/PublicProgramBootstrap.js";
import { createProgramOutputServer } from '../test-support/ReferenceAuthorityTestServer.js';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";

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
    play() { return this.playResult || Promise.resolve(); }
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

for (const mode of ["public", "obs"]) {
    test(`${mode}: committed LIVE publication crosses real POST/store/SSE and promotes without refresh`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "livezone-continuity-"));
        const token = "isolated-test-publisher-token";
        const { server, store } = createProgramOutputServer({ publisherToken: token, operatorAuth:new OperatorAuth({disabled:true}),
            mediaLibraryRoot: join(directory, "media"), studioStatePath: join(directory, "state.json") });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const abort = new AbortController();
        let publisher;
        try { await harness(mode, async ({ controller, created }) => {
            const stream = new EventTarget(); stream.close = () => {};
            controller.transport = new NetworkProgramOutputTransport({ role: "subscriber",
                subscribeUrl: `${base}/api/program-output/events`, eventSourceFactory: () => stream });
            controller.start();
            const response = await fetch(`${base}/api/program-output/events`, { signal: abort.signal });
            const reader = response.body.getReader();
            let buffered = "";
            const receive = async () => {
                while (true) {
                    const end = buffered.indexOf("\n\n");
                    if (end >= 0) {
                        const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
                        const data = event.split("\n").find(line => line.startsWith("data: "))?.slice(6);
                        if (!data) continue;
                        stream.dispatchEvent(new MessageEvent("program", { data }));
                        return JSON.parse(data);
                    }
                    const chunk = await reader.read();
                    assert.equal(chunk.done, false);
                    buffered += new TextDecoder().decode(chunk.value);
                }
            };
            let program = snapshot(1, "media");
            const transport = new NetworkProgramOutputTransport({ role: "publisher",
                publishUrl: `${base}/api/program-output`, tokenProvider: () => token, eventSourceFactory: null,
                fetchImplementation:(url,options)=>fetch(url,{...options,headers:{...options.headers,"X-Livezone-Program-Manual":"1"}}) });
            publisher = new ProgramOutputManager({
                stateManager: { getProgramSceneId: () => program.scene.id, getScene: () => program.scene },
                catalog: { getDefinition: () => ({ renderer: { kind: "source", sourceId: program.source.id } }) },
                sourceManager: { getSource: () => program.source },
                renderer: { getProgramTransport: () => program.source.kind === "media" ? {
                    sourceId: "media", state: "playing", currentTime: program.playback.initialTime,
                    duration: 120, ended: false } : null,
                    subscribeProgramTransport(listener) {
                        listener(this.getProgramTransport()); return () => {};
                    } },
                graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
                transitionCoordinator: { getSnapshot: () => ({ state: "idle" }) }, transport });
            publisher.start(); await transport.publishQueue;
            await receive(); created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            const outgoing = controller.current;
            // Inject the committed identity at the manager boundary; media decoding is simulated.
            program = snapshot(2, "hls"); publisher.handleProgramChanged(); await transport.publishQueue;
            const liveEnvelope = await receive();
            assert.deepEqual(liveEnvelope, store.getCurrent());
            assert.equal(liveEnvelope.revision, 2);
            assert.equal(liveEnvelope.snapshot.source.kind, "hls");
            assert.equal(controller.pendingRender.snapshot.revision, 2);
            created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.revision, 2);
            assert.equal(outgoing.released, true);
            assert.equal(outgoing.layer.querySelector("video").src, "");
            const freshResponse = await fetch(`${base}/api/program-output/events`, { signal: abort.signal });
            const freshReader = freshResponse.body.getReader();
            let freshText = "";
            while (!freshText.includes("data: ")) {
                freshText += new TextDecoder().decode((await freshReader.read()).value);
            }
            assert.deepEqual(JSON.parse(freshText.split("\n").find(line => line.startsWith("data: ")).slice(6)), liveEnvelope);
            program = snapshot(3, "media"); program.playback.initialTime = 37;
            publisher.handleProgramChanged(); await transport.publishQueue;
            await receive(); created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.source.kind, "media");
            assert.ok(Math.abs(controller.getCurrentMedia().currentTime - 37) < 1);
        }); } finally {
            publisher?.destroy(); abort.abort();
            await new Promise(resolve => server.close(resolve));
            assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
            assert.ok(basename(directory).startsWith("livezone-continuity-"));
            await rm(directory, { recursive: true, force: true });
        }
    });
    test(`${mode}: superseded readiness cannot reset the latest cue or playback state`, async () => {
        await harness(mode, async ({ controller, created }) => {
            const now = Date.now(); controller.now = () => now;
            const first = snapshot(1, "media");
            controller.handleSnapshot(first, { livePublisher: true });
            const obsolete = created.at(-1);
            const next = snapshot(2, "media"); next.source = { ...next.source, id: "new-media" };
            next.playback = { ...next.playback, initialTime: 37, startedAt: new Date(now).toISOString(),
                playing: false, state: "paused" };
            controller.handleSnapshot(next, { livePublisher: true });
            const current = created.at(-1); current.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(obsolete.src, "");
            obsolete.dispatchEvent(new Event("canplay")); obsolete.dispatchEvent(new Event("error"));
            await flush();
            assert.equal(controller.current.snapshot.revision, 2);
            assert.equal(current.currentTime, 37);
        });
    });
    test(`${mode}: LIVE preparation timeout releases obsolete Program within 12 seconds`, async context => {
        context.mock.timers.enable({ apis: ["setTimeout"] });
        await harness(mode, async ({ controller, created }) => {
            controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true });
            const media = created.at(-1); media.dispatchEvent(new Event("canplay")); await flush();
            controller.handleSnapshot(snapshot(2, "hls"), { livePublisher: true });
            context.mock.timers.tick(12000); await flush();
            assert.equal(controller.current, null);
            assert.equal(media.src, "");
            assert.equal(controller.pendingRender, null);
        });
    });
    test(`${mode}: real SSE handler replaces stalled LIVE with cue A and ignores stale HLS callbacks`, async () => {
        const previousHls = globalThis.Hls;
        const native = Element.prototype.canPlayType;
        const hlsInstances = [];
        class Hls {
            static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
            static isSupported() { return true; }
            constructor() { this.handlers = new Map(); this.destroys = 0; hlsInstances.push(this); }
            on(event, handler) { this.handlers.set(event, handler); }
            loadSource() {} attachMedia(video) { this.video = video; }
            destroy() { this.destroys++; }
            emit(event, data) { this.handlers.get(event)?.(event, data); }
        }
        globalThis.Hls = Hls; Element.prototype.canPlayType = () => "";
        try { await harness(mode, async ({ controller, created }) => {
            const stream = new EventTarget(); stream.readyState = 1; stream.close = () => {};
            controller.transport = new NetworkProgramOutputTransport({ role: "subscriber",
                subscribeUrl: "http://example.test/events", eventSourceFactory: () => stream });
            controller.start();
            const send = value => stream.dispatchEvent(new MessageEvent("program", {
                data: JSON.stringify(createProgramOutputEnvelope(value)) }));
            let now = Date.now(); controller.now = () => now;
            send(snapshot(1, "media")); created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            send(snapshot(2, "hls")); const live = created.at(-1);
            live.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.source.kind, "hls");
            const returned = snapshot(3, "media"); returned.playback.initialTime = 37;
            returned.playback.startedAt = new Date(now).toISOString();
            send(returned); const restored = created.at(-1);
            live.dispatchEvent(new Event("waiting")); hlsInstances[0].emit("error", { fatal: true });
            restored.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.revision, 3);
            assert.equal(restored.currentTime, 37);
            assert.equal(hlsInstances[0].destroys, 1);
            hlsInstances[0].emit("manifest"); hlsInstances[0].emit("error", { fatal: true });
            live.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.revision, 3);
            assert.equal(live.src, "");
            const update = { ...returned, revision: 4,
                playback: { ...returned.playback, initialTime: 42 } };
            send(update); await flush();
            assert.equal(restored.currentTime, 42);
            now += 3000; restored.dispatchEvent(new Event("playing")); await flush();
            assert.equal(restored.currentTime, 45);
            const freshLayer = new Element("div");
            const fresh = controller.createSource(freshLayer, update);
            created.at(-1).dispatchEvent(new Event("canplay"));
            const cleanup = await fresh;
            assert.equal(freshLayer.querySelector("video").currentTime, restored.currentTime);
            cleanup();
        }); } finally { globalThis.Hls = previousHls; Element.prototype.canPlayType = native; }
    });
    test(`${mode}: delayed readiness applies newest cue rather than original prepared cue`, async () => {
        await harness(mode, async ({ controller, created }) => {
            const now = Date.now(); controller.now = () => now;
            const first = snapshot(1, "media");
            first.playback.initialTime = 20;
            first.playback.startedAt = new Date(now).toISOString();
            controller.handleSnapshot(first, { livePublisher: true });
            const media = created.at(-1);
            const latest = { ...first, revision: 2, playback: { ...first.playback, initialTime: 40 } };
            controller.handleSnapshot(latest, { livePublisher: true });
            media.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current.snapshot.revision, 2);
            assert.equal(media.currentTime, 40);
        });
    });
    test(`${mode}: enabling audio catches up to the Program timeline after playback was blocked`, async () => {
        await harness(mode, async ({ controller, created }) => {
            let now = Date.now(); controller.now = () => now;
            const value = snapshot(1, "media"); value.playback.initialTime = 20;
            value.playback.startedAt = new Date(now).toISOString();
            controller.handleSnapshot(value, { livePublisher: true });
            const media = created.at(-1); media.dispatchEvent(new Event("canplay")); await flush();
            media.paused = true; now += 10000;
            controller.enableAudio(); await flush();
            assert.equal(media.currentTime, 30);
        });
    });
    test(`${mode}: pending play cannot block promotion of a ready LIVE revision`, async () => {
        await harness(mode, async ({ controller, created }) => {
            controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true });
            const media = created.at(-1); media.dispatchEvent(new Event("loadeddata")); await flush();
            assert.equal(controller.current.snapshot.source.kind, "media");
            controller.handleSnapshot(snapshot(2, "hls"), { livePublisher: true });
            const live = created.at(-1);
            let resolvePlay;
            live.playResult = new Promise(resolve => { resolvePlay = resolve; });
            live.dispatchEvent(new Event("canplay")); await flush();
            try {
                assert.equal(controller.current.snapshot.source.kind, "hls");
                assert.equal(media.src, "");
            } finally { resolvePlay(); await flush(); }
        });
    });
    test(`${mode}: failed LIVE preparation cannot retain obsolete media indefinitely`, async () => {
        await harness(mode, async ({ controller, created, base }) => {
            controller.handleSnapshot(snapshot(1, "media"), { livePublisher: true });
            const media = created.at(-1); media.dispatchEvent(new Event("loadeddata")); await flush();
            controller.handleSnapshot(snapshot(2, "hls"), { livePublisher: true });
            created.at(-1).dispatchEvent(new Event("error")); await flush();
            assert.equal(controller.current, null);
            assert.equal(media.src, "");
            assert.equal(base.children.some(child => child.querySelector("video") === media), false);
        });
    });
}

test("runtime trace is bounded and excludes unapproved fields and URL-bearing values", () => {
    const trace = new RuntimeTrace({ enabled: true, capacity: 3, now: () => 100 });
    for (let i = 0; i < 10; i++) trace.record("test", "event", {
        revision: i, currentTime: 37, token: "SECRET", cookie: "SECRET",
        url: "https://example.test/?token=SECRET", sourceId: "https://SECRET",
        reason: "https://SECRET", state: "CHECKING" });
    assert.deepEqual(trace.snapshot().map(x => x.revision), [7, 8, 9]);
    assert.doesNotMatch(trace.exportJSON(), /SECRET|token|cookie|https/);
    assert.equal(Object.isFrozen(trace.snapshot()[0]), true);
    trace.clear(); assert.equal(trace.snapshot().length, 0);
    const disabled = new RuntimeTrace(); disabled.record("test", "event");
    assert.equal(disabled.snapshot().length, 0);
});

for (const scenario of ["retained-video", "open-before-video", "video-audio-video", "autoplay-rejection", "pending-play", "retry-without-refresh", "latest-revision"] ) {
    test(`Public visual convergence: ${scenario}`, async context => {
        await harness("public", async ({ controller, created, base }) => {
            const now = Date.now(); controller.now = () => now;
            const a = snapshot(1, "media"); a.committedAt = new Date(now).toISOString();
            if (scenario === "retry-without-refresh") context.mock.timers.enable({ apis: ["setTimeout"] });
            if (scenario === "retained-video") {
                controller.transport = { start() {}, destroy() {}, subscribe(fn) { fn(a); return () => {}; } };
                controller.start();
            } else controller.handleSnapshot(a, { livePublisher: true });
            let video = created.at(-1);
            if (scenario === "autoplay-rejection") {
                controller.audioEnabled = true; video.muted = false;
                video.play = () => video.muted ? Promise.resolve() : Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
            }
            if (scenario === "pending-play") video.playResult = new Promise(() => {});
            if (scenario === "retry-without-refresh") {
                video.dispatchEvent(new Event("error")); await flush();
                assert.equal(controller.current, null);
                context.mock.timers.tick(1000); await flush();
                video = created.at(-1);
            }
            video.dispatchEvent(new Event("canplay")); await flush();
            assert.equal(controller.current?.snapshot.revision, 1);
            assert.equal(video.muted, true);
            assert.equal(controller.current.layer.style.opacity, "");
            assert.equal(base.children.length, 1);
            if (scenario === "video-audio-video") {
                const b = snapshot(2, "audio"); b.source = { id: "audio", kind: "audio", audioUrl: "/audio.mp3" };
                controller.handleSnapshot(b, { livePublisher: true });
                const audio = created.findLast(el => el.tagName === "AUDIO");
                audio.playResult = new Promise(() => {});
                audio.dispatchEvent(new Event("canplay")); await flush();
                assert.equal(controller.current?.snapshot.revision, 2);
                assert.equal(audio.muted, true);
                const c = snapshot(3, "media"); controller.handleSnapshot(c, { livePublisher: true });
                created.at(-1).dispatchEvent(new Event("canplay")); await flush();
                assert.equal(controller.current.snapshot.revision, 3);
                assert.equal(audio.src, "");
            }
            if (["pending-play", "latest-revision", "open-before-video"].includes(scenario)) {
                const b = snapshot(2, "hls"); controller.handleSnapshot(b, { livePublisher: true });
                created.at(-1).dispatchEvent(new Event("canplay")); await flush();
                assert.equal(controller.current.snapshot.revision, 2);
                const c = snapshot(3, "media"); controller.handleSnapshot(c, { livePublisher: true });
                created.at(-1).dispatchEvent(new Event("canplay")); await flush();
                controller.handleSnapshot(a);
                assert.equal(controller.current.snapshot.revision, 3);
                assert.equal(controller.revisionBySession.get(c.publisherSessionId), 3);
            }
        });
    });
}

test("Public newer return to current activation cancels a pending LIVE promotion", async () => {
    await harness("public", async ({ controller, created }) => {
        const a = snapshot(1, "media");
        controller.handleSnapshot(a, { livePublisher: true });
        created.at(-1).dispatchEvent(new Event("canplay")); await flush();
        controller.handleSnapshot(snapshot(2, "hls"), { livePublisher: true });
        const old = created.at(-1);
        controller.handleSnapshot({ ...a, revision: 3 }, { livePublisher: true });
        old.dispatchEvent(new Event("canplay")); await flush();
        assert.equal(controller.current.snapshot.revision, 3);
        assert.equal(old.src, "");
        assert.equal(controller.pendingRender, null);
    });
});

test("Public config failure retries and retained SSE bootstrap selects the latest revision", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await harness("public", async ({ controller, created }) => {
        let attempts = 0;
        let retained = snapshot(1, "media");
        const stream = new EventTarget(); stream.close = () => {};
        const stop = bootstrapPublicProgram({
            createTransport: async () => {
                if (++attempts === 1) throw new Error("temporary config failure");
                return new NetworkProgramOutputTransport({ role: "subscriber", baseUrl: "http://localhost",
                    subscribeUrl: "/api/program-output/events", eventSourceFactory: () => {
                        queueMicrotask(() => stream.dispatchEvent(new MessageEvent("program", {
                            data: JSON.stringify(createProgramOutputEnvelope(retained)) })));
                        return stream;
                    } });
            },
            onConnected: transport => { controller.transport = transport; controller.start(); }
        });
        try {
            await flush();
            retained = snapshot(2, "media");
            context.mock.timers.tick(1000); await flush();
            created.at(-1).dispatchEvent(new Event("canplay")); await flush();
            assert.equal(attempts, 2);
            assert.equal(controller.current.snapshot.revision, 2);
            assert.equal(controller.current.snapshot.revision, retained.revision);
        } finally { stop(); }
    });
});

test("Public bootstrap timeout retries and page close aborts pending config", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const signals = []; let connected = false;
    const stop = bootstrapPublicProgram({ createTransport: signal => {
        signals.push(signal);
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }, onConnected: () => { connected = true; } });
    context.mock.timers.tick(8000); await flush();
    assert.equal(signals[0].aborted, true);
    context.mock.timers.tick(1000); await flush();
    assert.equal(signals.length, 2);
    stop(); await flush(); context.mock.timers.tick(10000); await flush();
    assert.equal(signals[1].aborted, true);
    assert.equal(signals.length, 2);
    assert.equal(connected, false);
});
