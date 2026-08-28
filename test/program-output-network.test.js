import test from "node:test";
import assert from "node:assert/strict";
import ProgramOutputStore from "../server/program-output/ProgramOutputStore.js";
import { createProgramOutputServer } from "../server/program-output-server.js";
import { createProgramOutputEnvelope } from
    "../public/js/program-output/ProgramOutputEnvelope.js";
import NetworkProgramOutputTransport from
    "../public/js/program-output/NetworkProgramOutputTransport.js";
import LocalProgramOutputTransport from
    "../public/js/program-output/LocalProgramOutputTransport.js";
import { createProgramOutputTransport, PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY } from
    "../public/js/program-output/ProgramOutputTransportFactory.js";
import { storePublisherToken, clearPublisherToken } from
    "../public/js/ui/ProgramOutputSetupUI.js";
import ProgramOutputManager from
    "../public/js/program-output/ProgramOutputManager.js";
import PublicProgramController from
    "../public/js/public/PublicProgramController.js";
import { expectedPlaybackTime } from
    "../public/js/program-output/ProgramOutputContract.js";
import EventBus from "../public/js/core/EventBus.js";
import Events from "../public/js/core/Events.js";
import StudioMediaSurface from
    "../public/js/studio/renderers/StudioMediaSurface.js";
import StudioAudioSurface from
    "../public/js/studio/renderers/StudioAudioSurface.js";
import StudioRenderer from "../public/js/studio/StudioRenderer.js";

const TOKEN = "test-publisher-token-12345";

test("operator token helpers use canonical session-scoped key", () => {
    const values = new Map();
    const storage = {
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key)
    };
    assert.equal(storePublisherToken(storage, ` ${TOKEN} `), true);
    assert.equal(values.get(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY), TOKEN);
    clearPublisherToken(storage);
    assert.equal(values.has(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY), false);
});

test("recorded Program playback projects late-join time without polling", () => {
    const base = snapshot({ revision: 1, publishedAt: "2026-08-21T10:00:00.000Z" });
    const media = {
        ...base,
        scene: { id: "media-scene", name: "MEDIA", type: "MEDIA" },
        source: { id: "media-a", kind: "media",
            url: "https://example.test/media.mp4" },
        playback: { initialTime: 30, duration: 120, playing: true, ended: false,
            state: "playing", startedAt: "2026-08-21T10:00:00.000Z" }
    };
    assert.equal(expectedPlaybackTime(media,
        Date.parse("2026-08-21T10:00:05.000Z")), 35);
    assert.equal(expectedPlaybackTime(media,
        Date.parse("2026-08-21T10:00:30.000Z")), 60);
    assert.equal(expectedPlaybackTime({ ...media, source: { ...media.source,
        kind: "hls" } }, Date.parse("2026-08-21T10:00:30.000Z")), 0);
});

test("Public recorded source waits for projected seek before promotion", async () => {
    const element = new EventTarget();
    element.duration = 120;
    element.seeking = false;
    let position = 0;
    Object.defineProperty(element, "currentTime", {
        get: () => position,
        set: (value) => {
            position = value;
            element.seeking = true;
            queueMicrotask(() => {
                element.seeking = false;
                element.dispatchEvent(new Event("seeked"));
            });
        }
    });
    const controller = new PublicProgramController({
        root: null, status: null, audioButton: null, transport: {},
        now: () => Date.parse("2026-08-21T10:00:05.000Z")
    });
    const media = {
        ...snapshot(),
        scene: { id: "media-scene", name: "MEDIA", type: "MEDIA" },
        source: { id: "media-a", kind: "media",
            url: "https://example.test/media.mp4" },
        playback: { initialTime: 30, duration: 120, playing: true, ended: false,
            state: "playing", startedAt: "2026-08-21T10:00:00.000Z" }
    };
    await controller.seekRecordedMedia(element, media);
    assert.equal(position, 35);
    assert.equal(element.seeking, false);
});

test("graphics revision preserves recorded Program activation timeline", () => {
    let now = Date.parse("2026-08-21T10:00:00.000Z");
    let graphicsListener = null;
    const published = [];
    const manager = new ProgramOutputManager({
        stateManager: {
            getProgramSceneId: () => "media-scene",
            getScene: () => ({ id: "media-scene", name: "MEDIA", type: "MEDIA" })
        },
        catalog: { getDefinition: () => ({ id: "media-scene", name: "MEDIA",
            type: "MEDIA", renderer: { kind: "media", sourceId: "media-a" } }) },
        sourceManager: { getSource: () => ({ id: "media-a", kind: "media",
            url: "https://example.test/media.mp4" }) },
        renderer: {
            subscribeProgramTransport: (listener) => {
                listener({ sourceId: "media-a", instanceId: "instance-1",
                    consumer: "program", state: "playing", currentTime: 30,
                    duration: 120, paused: false, ended: false,
                    timestamp: new Date(now).toISOString() });
                return () => {};
            },
            getProgramTransport: () => ({ sourceId: "media-a", instanceId: "instance-1",
                consumer: "program", state: "playing", currentTime: 30,
                duration: 120, paused: false, ended: false,
                timestamp: new Date(now).toISOString() })
        },
        graphicsManager: {
            subscribe: (_scope, listener) => { graphicsListener = listener; return () => {}; },
            getVisibleGraphics: () => []
        },
        transitionCoordinator: { getSnapshot: () => ({ state: "idle", type: null }) },
        transport: { start() {}, publish: (value) => published.push(value), destroy() {} },
        now: () => now
    });
    manager.start();
    const activation = published[0];
    now += 5000;
    graphicsListener();
    const graphics = published[1];
    assert.equal(graphics.publishedAt, "2026-08-21T10:00:05.000Z");
    assert.equal(graphics.committedAt, activation.committedAt);
    assert.deepEqual(graphics.playback, activation.playback);
    assert.equal(expectedPlaybackTime(graphics,
        Date.parse("2026-08-21T10:00:30.000Z")), 60);
    manager.destroy();
});

test("Program lifecycle publishes an authoritative ENDED revision", () => {
    let transportListener = null;
    const published = [];
    const playingTransport = { sourceId: "media-a", instanceId: "instance-1",
        consumer: "program", state: "playing", currentTime: 20, duration: 30,
        paused: false, ended: false, timestamp: "2026-08-21T10:00:00.000Z" };
    const manager = new ProgramOutputManager({
        stateManager: { getProgramSceneId: () => "media-scene",
            getScene: () => ({ id: "media-scene", name: "MEDIA", type: "MEDIA" }) },
        catalog: { getDefinition: () => ({ id: "media-scene", renderer: {
            kind: "media", sourceId: "media-a" } }) },
        sourceManager: { getSource: () => ({ id: "media-a", kind: "media",
            url: "https://example.test/media.mp4" }) },
        renderer: {
            subscribeProgramTransport: (listener) => {
                transportListener = listener; listener(playingTransport); return () => {};
            },
            getProgramTransport: () => playingTransport
        },
        graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({ state: "idle", type: null }) },
        transport: { start() {}, publish: (value) => published.push(value), destroy() {} },
        now: () => Date.parse("2026-08-21T10:00:00.000Z")
    });
    manager.start();
    transportListener({ ...playingTransport, state: "ended", currentTime: 30,
        paused: true, ended: true, timestamp: "2026-08-21T10:00:10.000Z" });
    const ended = published.at(-1);
    assert.equal(ended.playback.initialTime, 30);
    assert.equal(ended.playback.playing, false);
    assert.equal(ended.playback.ended, true);
    assert.equal(ended.playback.state, "ended");
    manager.destroy();
});

test("same activation ENDED update reuses media and never plays", async () => {
    const media = new EventTarget();
    media.duration = 120;
    media.seeking = false;
    media.muted = true;
    media.pauseCalls = 0;
    media.playCalls = 0;
    media.pause = () => { media.pauseCalls += 1; };
    media.play = async () => { media.playCalls += 1; };
    let position = 25;
    Object.defineProperty(media, "currentTime", {
        get: () => position,
        set: (value) => {
            position = value; media.seeking = true;
            queueMicrotask(() => { media.seeking = false;
                media.dispatchEvent(new Event("seeked")); });
        }
    });
    const playing = { ...snapshot({ revision: 1 }),
        scene: { id: "media-scene", name: "MEDIA", type: "MEDIA" },
        source: { id: "media-a", kind: "media", url: "https://example.test/media.mp4" },
        playback: { initialTime: 0, duration: 120, playing: true, ended: false,
            state: "playing", startedAt: "2026-08-21T10:00:00.000Z" } };
    const ended = { ...playing, revision: 2,
        publishedAt: "2026-08-21T10:02:00.000Z",
        playback: { initialTime: 120, duration: 120, playing: false, ended: true,
            state: "ended", startedAt: "2026-08-21T10:02:00.000Z" } };
    const layer = { querySelector: () => media };
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton: { hidden: false }, transport: {},
        now: () => Date.parse("2026-08-21T10:02:00.000Z") });
    const entry = { snapshot: playing, layer, cleanup() {} };
    controller.current = entry;
    controller.activePublisherSessionId = playing.publisherSessionId;
    controller.revisionBySession.set(playing.publisherSessionId, 1);
    let recreated = 0;
    controller.renderSnapshot = async () => { recreated += 1; };
    controller.renderGraphics = () => {};
    controller.handleSnapshot(ended, { livePublisher: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(controller.current, entry);
    assert.equal(recreated, 0);
    assert.equal(media.playCalls, 0);
    assert.ok(media.pauseCalls >= 1);
    assert.ok(position > 119 && position < 120);
    controller.enableAudio();
    assert.equal(media.playCalls, 0);
    assert.equal(controller.current, entry);
    clearTimeout(controller.staleTimer);
});

test("Program media and audio recover unexpected pause without paused revision", async () => {
    for (const [Surface, property] of [
        [StudioMediaSurface, "video"], [StudioAudioSurface, "audio"]
    ]) {
        let resumeCalls = 0;
        let notifications = 0;
        const surface = {
            consumer: "program", initialPlayback: "playing", destroyed: false,
            transportEnded: false, transportError: false,
            [property]: { ended: false },
            startPlayback: async () => { resumeCalls += 1; return true; },
            notifyTransport: () => { notifications += 1; }
        };
        Surface.prototype.handlePause.call(surface);
        await Promise.resolve();
        assert.equal(resumeCalls, 1);
        assert.equal(notifications, 0);
    }
});

test("Preview pause remains authoritative and does not auto-resume", async () => {
    let resumeCalls = 0;
    let notifications = 0;
    const surface = {
        consumer: "preview", initialPlayback: "playing", destroyed: false,
        transportEnded: false, transportError: false, video: { ended: false },
        startPlayback: async () => { resumeCalls += 1; return true; },
        notifyTransport: () => { notifications += 1; }
    };
    StudioMediaSurface.prototype.handlePause.call(surface);
    await Promise.resolve();
    assert.equal(resumeCalls, 0);
    assert.equal(notifications, 1);
});

test("Public PLAYING reconciliation invokes play and exposes rejected autoplay", async () => {
    const media = new EventTarget();
    media.duration = 120;
    media.currentTime = 35;
    media.seeking = false;
    media.pause = () => {};
    let playCalls = 0;
    media.play = async () => { playCalls += 1; throw new Error("NotAllowedError"); };
    const snapshotValue = { ...snapshot(),
        scene: { id: "media-scene", name: "MEDIA", type: "MEDIA" },
        source: { id: "media-a", kind: "media", url: "https://example.test/media.mp4" },
        playback: { initialTime: 30, duration: 120, playing: true, ended: false,
            state: "playing", startedAt: "2026-08-21T10:00:00.000Z" } };
    const audioButton = { hidden: true };
    const entry = { snapshot: snapshotValue,
        layer: { querySelector: () => media }, cleanup() {} };
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton, transport: {},
        now: () => Date.parse("2026-08-21T10:00:05.000Z") });
    controller.current = entry;
    await controller.reconcilePlayback(snapshotValue, entry);
    assert.equal(playCalls, 1);
    assert.equal(audioButton.hidden, false);
    assert.equal(controller.current, entry);
});

test("ended Program handoff uses duration for every MEDIA currentTime behavior", () => {
    for (const sample of [
        { sourceId: "media-a", currentTime: 12.4, duration: 12.4 },
        { sourceId: "media-b", currentTime: 0, duration: 33.8 }
    ]) {
        const renderer = Object.create(StudioRenderer.prototype);
        renderer.previewHandoff = null;
        renderer.studioStateManager = { getProgramSceneId: () => "media-scene" };
        renderer.program = { sceneId: "media-scene", renderer: {
            getTransport: () => ({ ...sample, consumer: "program", state: "ended",
                paused: true, ended: true })
        } };
        const context = renderer.captureProgramPreviewHandoff(
            "media-scene", { generation: 7 }
        );
        assert.equal(context.transportInitialTime, sample.duration);
        assert.equal(context.transportInitialPlayback, "paused");
        assert.equal(context.transportInitialEnded, true);
    }
});

test("ended Preview initialization seeks safe end and explicit restart alone rewinds", () => {
    const surface = new StudioMediaSurface({ sourceId: "media-b",
        sourceUrl: "https://example.test/demo2.mp4", instanceId: "preview-1",
        consumer: "preview", initialTime: 33.8, initialPlayback: "paused",
        initialEnded: true });
    let position = 0;
    let pauseCalls = 0;
    surface.video = {
        duration: 33.8, paused: true, ended: false, readyState: 4,
        seekable: { length: 1, start: () => 0, end: () => 33.8 },
        seeking: false,
        get currentTime() { return position; },
        set currentTime(value) { position = value; },
        pause: () => { pauseCalls += 1; }
    };
    surface.notifyTransport = () => {};
    surface.handleLoadedMetadata();
    assert.ok(position > 33.7 && position < 33.8);
    surface.handleSeeked();
    assert.ok(pauseCalls >= 1);
    assert.ok(position > 33.7);
    surface.isControllable = () => true;
    assert.equal(surface.restart(), true);
    assert.equal(position, 0);
});

test("transferred cue waits for seekability and never falls back to zero", () => {
    const surface = new StudioMediaSurface({ sourceId: "media-b",
        sourceUrl: "https://example.test/demo2.mp4", instanceId: "preview-2",
        consumer: "preview", initialTime: 15, initialPlayback: "paused" });
    let position = 0;
    let seekable = false;
    surface.video = {
        duration: 33.8, paused: true, ended: false, readyState: 1, seeking: false,
        seekable: { get length() { return seekable ? 1 : 0; },
            start: () => 0, end: () => 33.8 },
        get currentTime() { return position; },
        set currentTime(value) { position = value; },
        pause() {}
    };
    surface.notifyTransport = () => {};
    surface.markReadyIfFrameAvailable = () => {};
    surface.handleLoadedMetadata();
    assert.equal(position, 0);
    assert.equal(surface.initialCueState, "pending");
    seekable = true;
    surface.video.readyState = 3;
    surface.handleLoadedData();
    assert.equal(position, 15);
    assert.equal(surface.initialCueState, "ready");
    surface.handleCanPlay();
    assert.equal(position, 15);
});

test("failed transferred cue reports failure without assigning zero", () => {
    const surface = new StudioMediaSurface({ sourceId: "media-b",
        sourceUrl: "https://example.test/demo2.mp4", instanceId: "preview-3",
        consumer: "preview", initialTime: 25, initialPlayback: "paused" });
    let assignments = 0;
    surface.video = {
        duration: 33.8, paused: true, ended: false, readyState: 3,
        seekable: { length: 1, start: () => 0, end: () => 33.8 },
        seeking: true,
        get currentTime() { return 0; },
        set currentTime(_value) { assignments += 1; },
        pause() {}
    };
    surface.notifyTransport = () => {};
    surface.failReadiness = () => {};
    surface.handleLoadedMetadata();
    surface.handleSeeked();
    surface.handleSeeked();
    assert.equal(assignments, 2);
    assert.equal(surface.initialCueState, "failed");
    assert.equal(surface.video.currentTime, 0);
});

function snapshot({ session = "session-a", revision = 1,
    publishedAt = "2026-08-21T10:00:00.000Z" } = {}) {
    return {
        version: 1, revision, publisherSessionId: session, publishedAt,
        committedAt: publishedAt,
        scene: { id: "break", name: "BREAK", type: "SLATE" },
        source: { id: "break", kind: "break", title: "LIVEZONE",
            message: "Back soon", logoUrl: "https://example.test/logo.svg" },
        playback: { initialTime: 0, duration: null, playing: false, ended: false,
            state: "ready", startedAt: publishedAt },
        graphics: { items: [] }, transition: { type: "cut", durationMs: 0 }
    };
}

function emptySnapshot({ session = "session-empty", revision = 1 } = {}) {
    const publishedAt = "2026-08-21T10:00:00.000Z";
    return {
        version: 1, revision, publisherSessionId: session, publishedAt,
        committedAt: publishedAt, scene: null, source: null,
        playback: { initialTime: 0, duration: null, playing: false, ended: false,
            state: "ready", startedAt: publishedAt },
        graphics: { items: [] }, transition: { type: "cut", durationMs: 0 }
    };
}

test("store retains newest revision and retires replaced sessions", () => {
    const store = new ProgramOutputStore();
    assert.equal(store.accept(createProgramOutputEnvelope(snapshot())).accepted, true);
    assert.equal(store.accept(createProgramOutputEnvelope(snapshot())).reason, "stale-revision");
    assert.equal(store.accept(createProgramOutputEnvelope(snapshot({ revision: 2,
        publishedAt: "2026-08-21T10:00:01.000Z" }))).accepted, true);
    assert.equal(store.getCurrent().revision, 2);
    assert.equal(store.accept(createProgramOutputEnvelope(snapshot({ session: "session-b",
        publishedAt: "2026-08-21T10:00:02.000Z" }))).accepted, true);
    assert.equal(store.accept(createProgramOutputEnvelope(snapshot({ session: "session-a",
        revision: 3, publishedAt: "2026-08-21T10:00:03.000Z" }))).reason,
    "retired-session");
    assert.equal(createProgramOutputEnvelope({ ...snapshot(), source: {
        id: "unsafe", kind: "media", url: "javascript:alert(1)"
    } }), null);
});

test("HTTP publisher auth, validation, retention and SSE late join", async (context) => {
    const { server } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const envelope = createProgramOutputEnvelope(snapshot());

    let response = await fetch(`${base}/api/program-output`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope)
    });
    assert.equal(response.status, 401);

    response = await fetch(`${base}/api/program-output`, {
        method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json" }, body: "{"
    });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/program-output`, {
        method: "POST", headers: { "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(envelope)
    });
    assert.equal(response.status, 415);

    response = await publish(base, { broken: true });
    assert.equal(response.status, 422);
    response = await publish(base, envelope);
    assert.equal(response.status, 202);
    response = await publish(base, envelope);
    assert.equal(response.status, 409);
    response = await fetch(`${base}/api/program-output`, {
        method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json" }, body: JSON.stringify({
            padding: "x".repeat(70 * 1024)
        })
    });
    assert.equal(response.status, 413);

    const abort = new AbortController();
    const stream = await fetch(`${base}/api/program-output/events`, {
        signal: abort.signal
    });
    assert.equal(stream.headers.get("content-type").startsWith("text/event-stream"), true);
    const reader = stream.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: program/);
    assert.match(first, /"publisherSessionId":"session-a"/);
    abort.abort();
});

test("publisher CORS is narrow and explicit", async (context) => {
    const allowed = "https://control.example.test";
    const { server } = createProgramOutputServer({
        publisherToken: TOKEN, allowedOrigins: new Set([allowed])
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    let response = await fetch(`${base}/api/program-output`, {
        method: "OPTIONS", headers: { Origin: allowed }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), allowed);
    response = await fetch(`${base}/api/program-output`, {
        method: "OPTIONS", headers: { Origin: "https://attacker.example" }
    });
    assert.equal(response.status, 403);
});

test("server serves Public and advertises explicit network mode", async (context) => {
    const { server } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /public-app\.js\?v=6l-network-subscriber/);
    const entry = await fetch(`${base}/js/entries/public-app.js`);
    assert.equal(entry.headers.get("cache-control"), "no-cache");
    const config = await fetch(`${base}/config/program-output.json`);
    assert.equal(config.headers.get("cache-control"), "no-store");
    assert.equal((await config.json()).mode, "network");
});

test("server provides byte ranges required for seekable MP4 preparation", async (context) => {
    const { server } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/media/demo2.mp4`, {
        headers: { Range: "bytes=1000-1999" }
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.match(response.headers.get("content-range"), /^bytes 1000-1999\/\d+$/);
    assert.equal(response.headers.get("content-length"), "1000");
    assert.equal((await response.arrayBuffer()).byteLength, 1000);
    const invalid = await fetch(`${base}/media/demo2.mp4`, {
        headers: { Range: "bytes=999999999999-1000000000000" }
    });
    assert.equal(invalid.status, 416);
    assert.match(invalid.headers.get("content-range"), /^bytes \*\/\d+$/);
});

test("network adapter publishes once and subscriber validates/cleans up", async () => {
    const sent = [];
    const publisher = new NetworkProgramOutputTransport({
        role: "publisher",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        tokenProvider: () => TOKEN,
        fetchImplementation: async (url, options) => {
            sent.push({ url, options }); return { ok: true };
        }
    });
    publisher.start();
    assert.equal(publisher.publish(snapshot()), true);
    await publisher.publishQueue;
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0].options.body).snapshot.revision, 1);
    publisher.destroy();

    const cancelled = [];
    const disposable = new NetworkProgramOutputTransport({
        role: "publisher",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        tokenProvider: () => TOKEN,
        fetchImplementation: async (...args) => { cancelled.push(args); return { ok: true }; }
    });
    disposable.start();
    disposable.publish(snapshot());
    disposable.destroy();
    await disposable.publishQueue;
    assert.equal(cancelled.length, 0);

    const eventSource = new FakeEventSource();
    const subscriber = new NetworkProgramOutputTransport({
        role: "subscriber",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        eventSourceFactory: () => eventSource
    });
    let received = null;
    subscriber.start();
    subscriber.subscribe((value) => { received = value; });
    eventSource.emit("program", { data: JSON.stringify(
        createProgramOutputEnvelope(snapshot())) });
    assert.equal(received.revision, 1);
    eventSource.emit("program", { data: "not-json" });
    assert.equal(received.revision, 1);
    subscriber.destroy();
    assert.equal(eventSource.closed, true);
});

test("factory preserves explicit local development mode", async () => {
    const config = encodeURIComponent(JSON.stringify({ version: 1, mode: "local",
        network: { publishUrl: "/api/program-output",
            subscribeUrl: "/api/program-output/events" } }));
    const transport = await createProgramOutputTransport({
        role: "subscriber", configUrl: `data:application/json,${config}`
    });
    assert.equal(transport instanceof LocalProgramOutputTransport, true);
});

test("network subscriber factory needs no token and opens exactly one root SSE", async () => {
    const config = encodeURIComponent(JSON.stringify({ version: 1, mode: "network",
        network: { publishUrl: "/api/program-output",
            subscribeUrl: "/api/program-output/events" } }));
    const sources = [];
    const transport = await createProgramOutputTransport({
        role: "subscriber",
        configUrl: `data:application/json,${config}`,
        baseUrl: "http://192.168.1.6:8080/",
        eventSourceFactory: (url) => {
            const source = new FakeEventSource();
            source.url = url; sources.push(source); return source;
        }
    });
    transport.start();
    const unsubscribe = transport.subscribe(() => {});
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url,
        "http://192.168.1.6:8080/api/program-output/events");
    assert.equal(transport.tokenProvider, null);
    unsubscribe();
    transport.destroy();
    assert.equal(sources[0].closed, true);
});

test("network manager publishes empty startup then one TAKE root POST", async () => {
    const config = encodeURIComponent(JSON.stringify({ version: 1, mode: "network",
        network: { publishUrl: "/api/program-output",
            subscribeUrl: "/api/program-output/events" } }));
    const requests = [];
    const transport = await createProgramOutputTransport({
        role: "publisher",
        configUrl: `data:application/json,${config}`,
        tokenProvider: () => TOKEN,
        baseUrl: "http://192.168.1.6:8080/control/",
        fetchImplementation: async (url, options) => {
            requests.push({ url, options }); return { ok: true };
        }
    });
    let sceneId = null;
    const definition = { id: "break", name: "BREAK", type: "SLATE",
        renderer: { kind: "slate", title: "LIVEZONE", message: "Back soon",
            logo: "https://example.test/logo.svg" } };
    const manager = new ProgramOutputManager({
        stateManager: { getProgramSceneId: () => sceneId,
            getScene: () => sceneId ? { id: "break", name: "BREAK", type: "SLATE" } : null },
        catalog: { getDefinition: () => definition },
        sourceManager: { getSource: () => null },
        renderer: { subscribeProgramTransport: () => () => {},
            getProgramTransport: () => null },
        graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({ state: "running", type: "cut" }) },
        transport,
        now: () => Date.parse("2026-08-21T10:00:00.000Z")
    });
    manager.start();
    sceneId = "break";
    EventBus.emit(Events.STUDIO_PROGRAM_CHANGED, { currentSceneId: sceneId });
    await transport.publishQueue;
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "http://192.168.1.6:8080/api/program-output");
    assert.equal(requests[1].url, "http://192.168.1.6:8080/api/program-output");
    assert.equal(JSON.parse(requests[0].options.body).snapshot.scene, null);
    assert.equal(JSON.parse(requests[1].options.body).snapshot.scene.id, "break");
    assert.equal(requests[1].options.method, "POST");
    manager.destroy();
});

test("ProgramOutputManager startup publishes explicit empty Program", () => {
    const published = [];
    const transport = { start() {}, publish: (value) => published.push(value),
        destroy() {} };
    const manager = new ProgramOutputManager({
        stateManager: { getProgramSceneId: () => null, getScene: () => null },
        catalog: { getDefinition: () => null },
        sourceManager: { getSource: () => null },
        renderer: { subscribeProgramTransport: () => () => {},
            getProgramTransport: () => null },
        graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({ state: "idle", type: null }) },
        transport,
        now: () => Date.parse("2026-08-21T10:00:00.000Z")
    });
    manager.start();
    assert.equal(published.length, 1);
    assert.equal(published[0].scene, null);
    assert.equal(published[0].source, null);
    assert.ok(createProgramOutputEnvelope(published[0]));
    manager.destroy();
});

test("subscriber accepts active sequence/new session and rejects retired session", () => {
    const eventSource = new FakeEventSource();
    const transport = new NetworkProgramOutputTransport({
        role: "subscriber",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        eventSourceFactory: () => eventSource
    });
    const controller = new PublicProgramController({
        root: null, status: null, audioButton: null, transport,
        now: () => Date.parse("2026-08-21T10:00:10.000Z")
    });
    const accepted = [];
    transport.start();
    transport.subscribe((value, meta) => {
        if (controller.acceptSnapshotRevision(value, meta)) {
            accepted.push(`${value.publisherSessionId}:${value.revision}:${value.source.kind}`);
        }
    });
    const variants = [
        { session: "session-a", revision: 1, kind: "hls" },
        { session: "session-a", revision: 2, kind: "break" },
        { session: "session-a", revision: 3, kind: "media" },
        { session: "session-b", revision: 1, kind: "break" },
        { session: "session-a", revision: 4, kind: "break" }
    ];
    variants.forEach((item, index) => {
        const publishedAt = `2026-08-21T10:00:0${index}.000Z`;
        const base = snapshot({ session: item.session, revision: item.revision,
            publishedAt });
        const source = item.kind === "hls"
            ? { id: "live", kind: "hls", url: "https://example.test/live.m3u8" }
            : item.kind === "media"
                ? { id: "media", kind: "media", url: "https://example.test/a.mp4" }
                : base.source;
        const scene = item.kind === "break" ? base.scene
            : { id: `${item.kind}-scene`, name: item.kind.toUpperCase(), type: "MEDIA" };
        eventSource.emit("program", { data: JSON.stringify(
            createProgramOutputEnvelope({ ...base, scene, source })) });
    });
    assert.deepEqual(accepted, [
        "session-a:1:hls", "session-a:2:break", "session-a:3:media",
        "session-b:1:break"
    ]);
    transport.destroy();
});

test("empty snapshot is valid and supersedes retained source in store", () => {
    const store = new ProgramOutputStore();
    assert.equal(store.accept(createProgramOutputEnvelope(snapshot())).accepted, true);
    const empty = createProgramOutputEnvelope(emptySnapshot({ session: "session-b" }));
    assert.ok(empty);
    assert.equal(store.accept(empty).accepted, true);
    assert.equal(store.getCurrent().snapshot.scene, null);
    assert.equal(store.getCurrent().snapshot.source, null);
});

test("missing publisher token reports controlled error and sends no request", async () => {
    const requests = [];
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
        const transport = new NetworkProgramOutputTransport({
            role: "publisher",
            publishUrl: "https://livezone.test/api/program-output",
            subscribeUrl: "https://livezone.test/api/program-output/events",
            tokenProvider: () => "",
            fetchImplementation: async (...args) => { requests.push(args); return { ok: true }; }
        });
        transport.start();
        transport.publish(snapshot());
        await transport.publishQueue;
        assert.equal(requests.length, 0);
        assert.equal(transport.status, "token-missing");
        assert.match(errors[0], /publisher token is missing/);
        transport.destroy();
    }
    finally { console.error = originalError; }
});

test("publisher token can be configured and cleared without recreating transport", async () => {
    let token = "";
    const requests = [];
    const transport = new NetworkProgramOutputTransport({
        role: "publisher",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        tokenProvider: () => token,
        fetchImplementation: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, status: 202 };
        }
    });
    transport.start();
    assert.equal(transport.status, "token-missing");
    token = TOKEN;
    transport.refreshPublisherCredential();
    assert.equal(transport.status, "token-ready");
    transport.publish(snapshot());
    await transport.publishQueue;
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(transport.status, "connected");
    token = "";
    transport.refreshPublisherCredential();
    transport.publish(snapshot({ revision: 2 }));
    await transport.publishQueue;
    assert.equal(requests.length, 1);
    assert.equal(transport.status, "token-missing");
    transport.destroy();
});

test("publisher surfaces authorization rejection distinctly", async () => {
    const transport = new NetworkProgramOutputTransport({
        role: "publisher",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        tokenProvider: () => "wrong-token-value",
        fetchImplementation: async () => ({ ok: false, status: 401 })
    });
    transport.start();
    transport.publish(snapshot());
    await transport.publishQueue;
    assert.equal(transport.status, "auth-error");
    transport.destroy();
});

test("one accepted publish broadcasts to multiple SSE clients", async (context) => {
    const { server, clients } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const responses = await Promise.all(controllers.map((controller) =>
        fetch(`${base}/api/program-output/events`, { signal: controller.signal })));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(clients.size, 3);
    const readers = responses.map((response) => response.body.getReader());
    await Promise.all(readers.map((reader) => reader.read()));
    const published = publish(base, createProgramOutputEnvelope(snapshot()));
    const messages = await Promise.all(readers.map(async (reader) =>
        new TextDecoder().decode((await reader.read()).value)));
    assert.equal((await published).status, 202);
    messages.forEach((message) => assert.match(message, /event: program/));
    controllers.forEach((controller) => controller.abort());
});

test("one SSE connection receives retained then multiple live revisions", async (context) => {
    const { server, clients } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await publish(base, createProgramOutputEnvelope(snapshot()))).status, 202);
    const abort = new AbortController();
    const response = await fetch(`${base}/api/program-output/events`, {
        signal: abort.signal
    });
    const reader = response.body.getReader();
    const retained = await readProgramEvent(reader);
    assert.match(retained, /"publisherSessionId":"session-a"/);
    assert.match(retained, /"revision":1/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(clients.size, 1);

    const revision2 = createProgramOutputEnvelope(snapshot({ revision: 2,
        publishedAt: "2026-08-21T10:00:01.000Z" }));
    assert.equal((await publish(base, revision2)).status, 202);
    const live2 = await readProgramEvent(reader);
    assert.match(live2, /"revision":2/);
    assert.equal(clients.size, 1);

    const revision3 = createProgramOutputEnvelope(snapshot({ revision: 3,
        publishedAt: "2026-08-21T10:00:02.000Z" }));
    assert.equal((await publish(base, revision3)).status, 202);
    const live3 = await readProgramEvent(reader);
    assert.match(live3, /"revision":3/);
    assert.equal(clients.size, 1);
    abort.abort();
});

test("connected SSE client receives explicit empty Program", async (context) => {
    const { server } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const abort = new AbortController();
    const response = await fetch(`${base}/api/program-output/events`, {
        signal: abort.signal
    });
    const reader = response.body.getReader();
    await reader.read();
    const envelope = createProgramOutputEnvelope(emptySnapshot());
    assert.equal((await publish(base, envelope)).status, 202);
    const event = await readProgramEvent(reader);
    assert.match(event, /"scene":null/);
    assert.match(event, /"source":null/);
    abort.abort();
});

function publish(base, body) {
    return fetch(`${base}/api/program-output`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

class FakeEventSource {
    constructor() { this.listeners = new Map(); this.closed = false; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    emit(type, event) { this.listeners.get(type)?.(event); }
    close() { this.closed = true; }
}

async function readProgramEvent(reader) {
    let text = "";
    while (!text.includes("event: program") || !text.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream closed before Program event");
        text += new TextDecoder().decode(value);
    }
    return text;
}
