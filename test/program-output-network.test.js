import OperatorAuth from '../server/auth/OperatorAuth.js';
const createProgramOutputServer=options=>createTestServer({operatorAuth:new OperatorAuth({disabled:true}),...options});
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ProgramOutputStore from "../server/program-output/ProgramOutputStore.js";
import { createProgramOutputServer as createTestServer } from '../test-support/ReferenceAuthorityTestServer.js';
import { createProgramOutputEnvelope } from
    "../public/js/program-output/ProgramOutputEnvelope.js";
import NetworkProgramOutputTransport from
    "../public/js/program-output/NetworkProgramOutputTransport.js";
import LocalProgramOutputTransport from
    "../public/js/program-output/LocalProgramOutputTransport.js";
import { createProgramOutputTransport, PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY,
    readPersistentPublisherToken } from
    "../public/js/program-output/ProgramOutputTransportFactory.js";
import { storePublisherToken, clearPublisherToken } from
    "../public/js/ui/ProgramOutputSetupUI.js";
import ProgramOutputManager from
    "../public/js/program-output/ProgramOutputManager.js";
import PublicProgramController from
    "../public/js/public/PublicProgramController.js";
import PublicShellController from
    "../public/js/public/PublicShellController.js";
import { expectedPlaybackTime, validateProgramOutputSnapshot } from
    "../public/js/program-output/ProgramOutputContract.js";
import EventBus from "../public/js/core/EventBus.js";
import Events from "../public/js/core/Events.js";
import StudioMediaSurface from
    "../public/js/studio/renderers/StudioMediaSurface.js";
import StudioAudioSurface from
    "../public/js/studio/renderers/StudioAudioSurface.js";
import StudioRenderer from "../public/js/studio/StudioRenderer.js";
import { StudioGraphicsManager } from
    "../public/js/studio/StudioGraphicsManager.js";
import StudioTextCrawlUI, { STUDIO_TEXT_CRAWL_STORAGE_KEY } from
    "../public/js/ui/StudioTextCrawlUI.js";

const TOKEN = "test-publisher-token-12345";

function memoryStorage() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    };
}

test("operator token helpers use canonical persistent key", () => {
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

test("persistent publisher token survives new reads and local storage wins", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    local.setItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY, TOKEN);
    session.setItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY, "legacy-token-value-12345");
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: session }), TOKEN);
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: session }), TOKEN);
    assert.equal(session.getItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY),
        "legacy-token-value-12345");
});

test("legacy session publisher token migrates once into persistent storage", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    session.setItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY, TOKEN);
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: session }), TOKEN);
    assert.equal(local.getItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY), TOKEN);
    assert.equal(session.getItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY), null);
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: session }), TOKEN);
});

test("persistent token update and clear retain explicit operator control", () => {
    const local = memoryStorage();
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: memoryStorage() }), "");
    assert.equal(storePublisherToken(local, TOKEN), true);
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: memoryStorage() }), TOKEN);
    const replacement = "replacement-token-value-12345";
    assert.equal(storePublisherToken(local, replacement), true);
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: memoryStorage() }), replacement);
    clearPublisherToken(local);
    assert.equal(readPersistentPublisherToken({ persistentStorage: local,
        legacyStorage: memoryStorage() }), "");
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
    media.play = async () => { playCalls += 1; const error = new Error("blocked");
        error.name = "NotAllowedError"; throw error; };
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
    assert.equal(playCalls, 2);
    assert.equal(media.muted, true);
    assert.equal(audioButton.hidden, false);
    assert.equal(controller.current, entry);
});

test("Public HLS uses the canonical audio gate and preserves permission across replacements", async () => {
    const previousDocument = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tagName) {
        const element = new FakePublicElement(tagName);
        element.canPlayType = () => "probably";
        created.push(element);
        return element;
    } };
    try {
        const audioButton = { hidden: true };
        const controller = new PublicProgramController({ root: null, status: null,
            audioButton, transport: {} });
        controller.waitForReady = async () => {};
        const hlsSnapshot = { ...snapshot(),
            scene: { id: "live", name: "LIVE", type: "LIVE" },
            source: { id: "live", kind: "hls", url: "https://example.test/live.m3u8" },
            playback: { initialTime: 0, duration: null, playing: true, ended: false,
                state: "playing", startedAt: "2026-08-21T10:00:00.000Z" } };
        const firstRoot = new FakePublicElement("div");
        const firstCleanup = await controller.createSource(firstRoot, hlsSnapshot);
        const first = created[0];
        assert.equal(controller.audioEnabled, false);
        assert.equal(first.muted, true);
        assert.equal(audioButton.hidden, false);

        controller.current = { snapshot: hlsSnapshot,
            layer: { querySelector: () => first } };
        controller.enableAudio();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(controller.audioEnabled, true);
        assert.equal(first.muted, false);
        assert.equal(audioButton.hidden, true);

        const secondRoot = new FakePublicElement("div");
        const secondCleanup = await controller.createSource(secondRoot, hlsSnapshot);
        const second = created[1];
        assert.notEqual(second, first);
        assert.equal(second.muted, true, "replacement preparation stays muted until visual promotion");
        assert.equal(controller.audioEnabled, true);
        firstCleanup(); secondCleanup();

        const fresh = new PublicProgramController({ root: null, status: null,
            audioButton: { hidden: true }, transport: {} });
        assert.equal(fresh.audioEnabled, false);
    }
    finally { globalThis.document = previousDocument; }
});

test("Public VIDEO exposes the page audio gate and unlocks the same element", async () => {
    const previousDocument = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tagName) {
        const element = new FakePublicElement(tagName);
        created.push(element);
        return element;
    } };
    try {
        const audioButton = { hidden: true };
        const controller = new PublicProgramController({ root: null, status: null,
            audioButton, transport: {}, now: () => Date.parse("2026-08-21T10:00:05Z") });
        controller.waitForReady = async () => {};
        controller.seekRecordedMedia = async () => {};
        const value = { ...snapshot(),
            scene: { id: "video", name: "VIDEO", type: "MEDIA" },
            source: { id: "video", kind: "media", url: "/video.mp4" },
            playback: { initialTime: 40, duration: 120, playing: true, ended: false,
                state: "playing", startedAt: "2026-08-21T10:00:00Z" } };
        const root = new FakePublicElement("div");
        const cleanup = await controller.createSource(root, value);
        const video = created[0];
        video.currentTime = 45;
        controller.current = { snapshot: value,
            layer: { querySelector: () => video }, cleanup };
        controller.syncCurrentAudioButton();
        assert.equal(video.muted, true);
        assert.equal(video.defaultMuted, true);
        assert.equal(audioButton.hidden, false,
            "visible VIDEO must not omit ENABLE AUDIO before authorization");

        controller.enableAudio();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(controller.current.layer.querySelector("video"), video);
        assert.equal(video.currentTime, 45);
        assert.equal(video.muted, false);
        assert.equal(video.defaultMuted, false);
        assert.equal(controller.audioEnabled, true);
        assert.equal(audioButton.hidden, true);
        cleanup();
    }
    finally { globalThis.document = previousDocument; }
});

test("Public VIDEO repeated NotAllowed recovery survives replacement and clears on end", async () => {
    const blocked = () => { const error = new Error("gesture required");
        error.name = "NotAllowedError"; return error; };
    const audioButton = { hidden: false };
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton, transport: {}, now: () => Date.parse("2026-08-21T10:01:01Z") });
    const first = new FakePublicElement("video");
    first.currentTime = 61;
    first.play = async () => { first.playCalls += 1; throw blocked(); };
    const firstSnapshot = { ...snapshot(), source: { id: "one", kind: "media", url: "/one.mp4" },
        playback: { initialTime: 0, duration: 120, playing: true, ended: false,
            state: "playing", startedAt: "2026-08-21T10:00:00Z" } };
    controller.current = { snapshot: firstSnapshot, layer: { querySelector: () => first } };
    controller.enableAudio();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(controller.audioEnabled, true);
    assert.equal(controller.audioBlockedElement, first);
    assert.equal(audioButton.hidden, false);
    assert.equal(first.currentTime, 61);
    controller.enableAudio();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(controller.audioBlockedElement, first);
    assert.equal(audioButton.hidden, false);

    const second = new FakePublicElement("video");
    second.play = async () => { second.playCalls += 1; throw blocked(); };
    const secondSnapshot = { ...firstSnapshot,
        source: { id: "two", kind: "media", url: "/two.mp4" } };
    controller.current = { snapshot: secondSnapshot, layer: { querySelector: () => second } };
    try { await second.play(); }
    catch (error) { controller.handleAutoplayRejection(error, second); }
    controller.syncCurrentAudioButton();
    assert.equal(second.playCalls, 2);
    assert.equal(controller.audioBlockedElement, second);
    assert.equal(audioButton.hidden, false);

    second.dispatchEvent(new Event("ended"));
    secondSnapshot.playback.ended = true;
    controller.syncCurrentAudioButton();
    assert.equal(audioButton.hidden, true);
});

test("Public HLS exposes only NotAllowedError and fullscreen does not unlock audio", async () => {
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton: { hidden: true }, transport: {} });
    assert.equal(controller.handleAutoplayRejection(new Error("network")), false);
    assert.equal(controller.audioButton.hidden, true);
    const blocked = new Error("gesture required"); blocked.name = "NotAllowedError";
    assert.equal(controller.handleAutoplayRejection(blocked), true);
    assert.equal(controller.audioButton.hidden, false);

    const previousDocument = globalThis.document;
    let fullscreenCalls = 0; let audioCalls = 0;
    globalThis.document = { fullscreenElement: null };
    try {
        const shell = new PublicShellController({ page: {},
            composition: { requestFullscreen() { fullscreenCalls += 1;
                return Promise.resolve(); }, querySelector() { return null; } }, fullscreenButton: {},
            audioUnlock() { audioCalls += 1; } });
        shell.handleFullscreenClick();
        assert.equal(fullscreenCalls, 1);
        assert.equal(audioCalls, 0);
    }
    finally { globalThis.document = previousDocument; }
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

class FakePublicElement extends EventTarget {
    querySelector(tag) { return this.children.find(child => child.tagName === tag.toUpperCase()) || null; }
    constructor(tagName, { rejectPlay = false } = {}) {
        super();
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.style = {};
        this.hidden = false;
        this.complete = false;
        this.naturalWidth = 0;
        this.currentTime = 0;
        this.duration = null;
        this.seeking = false;
        this.paused = true;
        this.rejectPlay = rejectPlay;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.loadCalls = 0;
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    remove() { this.removed = true; this.isConnected = false; }
    async play() {
        this.playCalls += 1;
        if (this.rejectPlay) throw new Error("autoplay-rejected");
        this.paused = false;
    }
    pause() { this.pauseCalls += 1; this.paused = true; }
    load() { this.loadCalls += 1; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
}

async function createPublicAudioHarness(source, { rejectMotion = false,
    snapshot = audioSnapshot() } = {}) {
    const previousDocument = globalThis.document;
    const elements = [];
    globalThis.document = { createElement(tagName) {
        const element = new FakePublicElement(tagName, {
            rejectPlay: tagName === "video" && rejectMotion
        });
        elements.push(element);
        return element;
    } };
    const root = new FakePublicElement("div");
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton: null, transport: {}, now: () => Date.parse(
            "2026-08-21T10:00:00.000Z") });
    const pending = controller.createAudio(root, { ...snapshot, source });
    const audio = elements.find((element) => element.tagName === "AUDIO");
    audio.dispatchEvent(new Event("loadeddata"));
    const cleanup = await pending;
    return { previousDocument, elements, root, cleanup, controller,
        audio, image: elements.find((element) => element.tagName === "IMG"),
        motion: elements.find((element) => element.tagName === "VIDEO"),
        placeholder: elements.find((element) => element.tagName === "DIV") };
}

test("Public AUDIO late join plays muted and unlocks the same timeline and surface", async () => {
    const playing = { ...audioSnapshot(), playback: { ...audioSnapshot().playback,
        initialTime: 1800, playing: true, ended: false, state: "playing",
        startedAt: "2026-08-21T10:00:00.000Z" } };
    const harness = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        motionUrl: "https://example.test/motion.mp4" }, { snapshot: playing });
    try {
        assert.equal(harness.audio.playCalls, 1);
        assert.equal(harness.audio.muted, true);
        assert.equal(harness.audio.currentTime, 1800);
        const motion = harness.motion;
        harness.controller.audioButton = { hidden: false };
        harness.controller.current = { snapshot: playing, layer: {
            querySelector: (selector) => selector === "audio" ? harness.audio : motion
        } };
        harness.controller.enableAudio();
        await Promise.resolve();
        assert.equal(harness.audio.playCalls, 2);
        assert.equal(harness.audio.currentTime, 1800);
        assert.equal(harness.controller.audioEnabled, true);
        assert.equal(harness.controller.audioButton.hidden, true);
        assert.equal(harness.motion, motion);
    }
    finally {
        harness.cleanup();
        globalThis.document = harness.previousDocument;
    }
});

test("Public AUDIO gives ready motion priority over still artwork", async () => {
    const harness = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" });
    try {
        harness.image.dispatchEvent(new Event("load"));
        assert.equal(harness.image.hidden, false);
        harness.motion.dispatchEvent(new Event("loadeddata"));
        await Promise.resolve();
        assert.equal(harness.motion.hidden, false);
        assert.equal(harness.image.hidden, true);
        assert.equal(harness.placeholder.hidden, true);
        assert.equal(harness.motion.muted, true);
        assert.equal(harness.motion.loop, true);
        assert.equal(harness.motion.autoplay, true);
        assert.equal(harness.motion.playsInline, true);
        assert.equal(harness.motion.controls, false);
        assert.notEqual(harness.motion, harness.audio);
    }
    finally {
        harness.cleanup();
        globalThis.document = harness.previousDocument;
    }
});

test("Public AUDIO stops motion at audio end and restarts it on replay", async () => {
    const harness = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" });
    try {
        harness.motion.dispatchEvent(new Event("loadeddata"));
        await Promise.resolve();
        harness.motion.currentTime = 14;
        const pauseCalls = harness.motion.pauseCalls;
        harness.audio.dispatchEvent(new Event("ended"));
        assert.equal(harness.motion.pauseCalls, pauseCalls + 1);
        assert.equal(harness.motion.currentTime, 0);
        assert.equal(harness.motion.hidden, false);

        const playCalls = harness.motion.playCalls;
        harness.audio.dispatchEvent(new Event("playing"));
        await Promise.resolve();
        assert.equal(harness.motion.playCalls, playCalls + 1);
        assert.equal(harness.motion.hidden, false);
    }
    finally {
        harness.cleanup();
        globalThis.document = harness.previousDocument;
    }
});

test("Public authoritative AUDIO ended update resets only the current visible motion", async () => {
    let publishCalls = 0;
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton: null, transport: { publish() { publishCalls += 1; } } });
    const currentAudio = new FakePublicElement("audio");
    const currentMotion = new FakePublicElement("video");
    currentMotion.currentTime = 24;
    const staleMotion = new FakePublicElement("video");
    staleMotion.currentTime = 12;
    const entry = { snapshot: audioSnapshot(), layer: { querySelector(selector) {
        return selector === "audio" ? currentAudio : currentMotion;
    } } };
    const stale = { snapshot: audioSnapshot(), layer: { querySelector(selector) {
        return selector === "audio" ? new FakePublicElement("audio") : staleMotion;
    } } };
    controller.current = entry;
    controller.seekRecordedMedia = async () => {};

    await controller.reconcilePlayback({ ...audioSnapshot(), playback: {
        ...audioSnapshot().playback, playing: false, ended: true, state: "ended"
    } }, stale);
    assert.equal(staleMotion.pauseCalls, 0);
    assert.equal(staleMotion.currentTime, 12);

    await controller.reconcilePlayback({ ...audioSnapshot(), playback: {
        ...audioSnapshot().playback, playing: false, ended: true, state: "ended"
    } }, entry);
    assert.equal(currentMotion.pauseCalls, 1);
    assert.equal(currentMotion.currentTime, 0);
    assert.equal(currentAudio.pauseCalls, 1);

    const noMotionEntry = { snapshot: audioSnapshot(), layer: {
        querySelector: (selector) => selector === "audio"
            ? new FakePublicElement("audio") : null
    } };
    controller.current = noMotionEntry;
    await assert.doesNotReject(controller.reconcilePlayback({ ...audioSnapshot(), playback: {
        ...audioSnapshot().playback, playing: false, ended: true, state: "ended"
    } }, noMotionEntry));
    assert.equal(publishCalls, 0);
});

test("Public AUDIO falls back through still to placeholder", async () => {
    const still = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg" });
    try {
        still.image.dispatchEvent(new Event("load"));
        assert.equal(still.image.hidden, false);
        assert.equal(still.placeholder.hidden, true);
    }
    finally { still.cleanup(); globalThis.document = still.previousDocument; }

    const plain = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3" });
    try {
        assert.equal(plain.image, undefined);
        assert.equal(plain.motion, undefined);
        assert.equal(plain.placeholder.hidden, false);
    }
    finally { plain.cleanup(); globalThis.document = plain.previousDocument; }
});

test("Public AUDIO motion failure preserves still fallback and cleanup", async () => {
    const harness = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" }, { rejectMotion: true });
    try {
        harness.image.dispatchEvent(new Event("load"));
        harness.motion.dispatchEvent(new Event("loadeddata"));
        await Promise.resolve(); await Promise.resolve();
        assert.equal(harness.motion.hidden, true);
        assert.equal(harness.image.hidden, false);
        harness.cleanup();
        assert.ok(harness.motion.pauseCalls >= 1);
        assert.equal(harness.motion.src, "");
        assert.ok(harness.motion.loadCalls >= 2);
        assert.equal(harness.audio.src, "");
    }
    finally { harness.cleanup(); globalThis.document = harness.previousDocument; }

    const plain = await createPublicAudioHarness({ id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        motionUrl: "https://example.test/motion.mp4" }, { rejectMotion: true });
    try {
        plain.motion.dispatchEvent(new Event("loadeddata"));
        await Promise.resolve(); await Promise.resolve();
        assert.equal(plain.motion.hidden, true);
        assert.equal(plain.placeholder.hidden, false);
    }
    finally { plain.cleanup(); globalThis.document = plain.previousDocument; }
});

test("same Program activation rerenders when AUDIO artwork URL changes", () => {
    const controller = new PublicProgramController({ root: null, status: null,
        audioButton: null, transport: {} });
    const first = audioSnapshot({ motionUrl: "https://example.test/m1.mp4" });
    const second = { ...audioSnapshot({ motionUrl: "https://example.test/m2.mp4",
        revision: 2 }), committedAt: first.committedAt };
    controller.current = { snapshot: first, cleanup() {}, layer: { remove() {} } };
    controller.scheduleStaleState = () => {};
    let rendered = null;
    controller.renderSnapshot = (value) => { rendered = value; };
    controller.handleSnapshot(second, { livePublisher: true });
    assert.equal(rendered.source.motionUrl, "https://example.test/m2.mp4");
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

function audioSnapshot({ stillUrl, motionUrl, revision = 1 } = {}) {
    const base = snapshot({ revision });
    return { ...base,
        scene: { id: "audio-scene", name: "AUDIO", type: "AUDIO" },
        source: { id: "audio-source", kind: "audio",
            audioUrl: "https://example.test/audio.mp3",
            ...(stillUrl ? { stillUrl } : {}),
            ...(motionUrl ? { motionUrl } : {}) },
        playback: { ...base.playback, state: "paused" }
    };
}

function imageSnapshot({ url = "https://example.test/image.jpg", revision = 1 } = {}) {
    const base = snapshot({ revision });
    return { ...base,
        scene: { id: "image-scene", name: "IMAGE", type: "IMAGE" },
        source: { id: "image-source", kind: "image", url },
        overlays: { textCrawl: { enabled: true, mode: "fixed", text: "IMAGE",
            direction: "rtl", speed: "slow", position: "bottom", background: true } },
        transition: { type: "dissolve", durationMs: 400 }
    };
}

test("Program Output v1 accepts strict resolved IMAGE snapshots and envelopes", () => {
    for (const url of ["https://example.test/image.jpg", "http://127.0.0.1/image.jpg"]) {
        const valid = validateProgramOutputSnapshot(imageSnapshot({ url }));
        assert.equal(valid.source.kind, "image");
        assert.equal(valid.source.url, url);
        assert.equal(valid.playback.playing, false);
        assert.equal(valid.transition.type, "dissolve");
        assert.equal(valid.overlays.textCrawl.text, "IMAGE");
        assert.ok(createProgramOutputEnvelope(valid));
    }
});

test("Program Output v1 rejects malformed and cross-kind IMAGE snapshots", () => {
    assert.equal(validateProgramOutputSnapshot(imageSnapshot({ url: "file:///private.jpg" })), null);
    assert.equal(validateProgramOutputSnapshot({ ...imageSnapshot(), source: {
        id: "image-source", kind: "image" } }), null);
    for (const extra of [
        { audioUrl: "https://example.test/audio.mp3" },
        { title: "wrong-kind" }, { enabled: true }, { assetId: "private-asset" }
    ]) assert.equal(validateProgramOutputSnapshot({ ...imageSnapshot(), source: {
        ...imageSnapshot().source, ...extra } }), null);
});

test("Program Output store retains an IMAGE envelope without local asset provenance", () => {
    const store = new ProgramOutputStore();
    const envelope = createProgramOutputEnvelope(imageSnapshot());
    assert.equal(store.accept(envelope).accepted, true);
    assert.deepEqual(store.getCurrent(), envelope);
    assert.deepEqual(Object.keys(store.getCurrent().snapshot.source).sort(),
        ["id", "kind", "url"]);
});

test("ProgramOutputManager projects managed and legacy IMAGE sources as resolved URLs", () => {
    for (const source of [
        { id: "managed-image", kind: "image", assetId: "asset-image",
            url: "http://127.0.0.1:8080/media-library/files/image/managed.jpg" },
        { id: "legacy-image", kind: "image", url: "https://example.test/legacy.jpg" }
    ]) {
        const published = [];
        const manager = new ProgramOutputManager({
            stateManager: { getProgramSceneId: () => "image-scene",
                getScene: () => ({ id: "image-scene", name: "IMAGE", type: "IMAGE" }) },
            catalog: { getDefinition: () => ({ id: "image-scene", name: "IMAGE", type: "IMAGE",
                renderer: { kind: "source", sourceId: source.id } }), subscribe: () => () => {} },
            sourceManager: { getSource: () => source },
            renderer: { subscribeProgramTransport: () => () => {},
                getProgramTransport: () => null },
            graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
            transitionCoordinator: { getSnapshot: () => ({ state: "idle", type: null }) },
            transport: { start() {}, publish: (value) => published.push(value), destroy() {} },
            now: () => Date.parse("2026-08-21T10:00:00.000Z")
        });
        manager.start();
        assert.deepEqual(published[0].source, { id: source.id, kind: "image", url: source.url });
        manager.destroy();
    }
});

test("Public renderer selects a silent contained IMAGE surface", async () => {
    const previousDocument = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tagName) {
        const element = new FakePublicElement(tagName); created.push(element); return element;
    } };
    try {
        const root = new FakePublicElement("div");
        const controller = new PublicProgramController({ root: null, status: null,
            audioButton: null, transport: {} });
        const pending = controller.createSource(root, imageSnapshot());
        const image = created[0];
        image.dispatchEvent(new Event("load"));
        const cleanup = await pending;
        assert.equal(image.tagName, "IMG");
        assert.equal(image.className, "public-program__media");
        assert.equal(image.alt, "");
        assert.equal(created.some(({ tagName }) => ["AUDIO", "VIDEO"].includes(tagName)), false);
        cleanup();
        assert.equal(image.src, "");
    }
    finally { globalThis.document = previousDocument; }
});

test("Public IMAGE load failure clears its resource", async () => {
    const previousDocument = globalThis.document;
    const image = new FakePublicElement("img");
    globalThis.document = { createElement: () => image };
    try {
        const controller = new PublicProgramController({ root: null, status: null,
            audioButton: null, transport: {} });
        const pending = controller.createImage(new FakePublicElement("div"),
            imageSnapshot().source);
        image.dispatchEvent(new Event("error"));
        await assert.rejects(pending, /unavailable/);
        assert.equal(image.src, "");
    }
    finally { globalThis.document = previousDocument; }
});

test("Public rapid IMAGE IMAGE VIDEO preparation owns independent cleanup", async () => {
    const previousDocument = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tagName) {
        const element = new FakePublicElement(tagName); created.push(element); return element;
    } };
    try {
        const controller = new PublicProgramController({ root: null, status: null,
            audioButton: null, transport: {} });
        const rootA = new FakePublicElement("div");
        const rootB = new FakePublicElement("div");
        const rootVideo = new FakePublicElement("div");
        const pendingA = controller.createSource(rootA, imageSnapshot({
            url: "https://example.test/a.jpg", revision: 1 }));
        const pendingB = controller.createSource(rootB, imageSnapshot({
            url: "https://example.test/b.jpg", revision: 2 }));
        const videoSnapshot = { ...snapshot({ revision: 3 }),
            scene: { id: "video-scene", name: "VIDEO", type: "VIDEO" },
            source: { id: "video", kind: "media", url: "https://example.test/video.mp4" } };
        const pendingVideo = controller.createSource(rootVideo, videoSnapshot);
        const [imageA, imageB, video] = created;
        imageA.dispatchEvent(new Event("load"));
        imageB.dispatchEvent(new Event("load"));
        video.dispatchEvent(new Event("loadeddata"));
        const cleanups = await Promise.all([pendingA, pendingB, pendingVideo]);
        cleanups.forEach((cleanup) => cleanup());
        assert.equal(imageA.src, "");
        assert.equal(imageB.src, "");
        assert.equal(video.src, "");
    }
    finally { globalThis.document = previousDocument; }
});

test("Public and OBS keep the newest A LIVE A LIVE revision under async supersession", async () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: (tagName) => new FakePublicElement(tagName) };
    try {
        for (const outputMode of ["public", "obs"]) {
            const baseRoot = new FakePublicElement("div");
            const root = { querySelector: (selector) => selector === "[data-public-base]"
                ? baseRoot : null };
            const controller = new PublicProgramController({ root, status: null,
                audioButton: null, transport: {}, outputMode });
            controller.renderGraphics = () => {};
            controller.renderOverlays = () => {};
            controller.syncCurrentAudioButton = () => {};
            const pending = new Map();
            const cleaned = [];
            controller.createSource = (layer, value) => new Promise((resolve) => {
                pending.set(value.revision, () => resolve(() => cleaned.push(value.revision)));
                layer.revision = value.revision;
            });
            const media = (revision) => ({ ...snapshot({ revision }),
                scene: { id: "program-a", name: "A", type: "MEDIA" },
                source: { id: "media-a", kind: "media",
                    url: "https://example.test/a.mp4" } });
            const live = (revision) => ({ ...snapshot({ revision }),
                scene: { id: "auto-live", name: "LIVE", type: "LIVE" },
                source: { id: "live-a", kind: "hls",
                    url: "https://example.test/live.m3u8" } });
            [media(1), live(2), media(3), live(4)].forEach((value) =>
                controller.handleSnapshot(value, { livePublisher: true }));
            pending.get(4)(); await Promise.resolve(); await Promise.resolve();
            pending.get(2)(); pending.get(1)(); pending.get(3)();
            await Promise.resolve(); await Promise.resolve();
            assert.equal(controller.current.snapshot.revision, 4);
            assert.equal(controller.current.snapshot.source.kind, "hls");
            assert.deepEqual(cleaned.sort(), [1, 2, 3]);
            assert.equal(controller.revisionBySession.get("session-a"), 4);
            assert.equal(baseRoot.children.at(-1).revision, 4);
            clearTimeout(controller.staleTimer);
            controller.releaseCurrent();
        }
    }
    finally { globalThis.document = previousDocument; }
});

test("already-open Public and OBS coalesce LIVE playback revisions into one HLS preparation", async () => {
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: (tagName) => new FakePublicElement(tagName) };
    try {
        for (const outputMode of ["public", "obs"]) {
            const baseRoot = new FakePublicElement("div");
            const root = { querySelector: (selector) => selector === "[data-public-base]"
                ? baseRoot : null };
            const controller = new PublicProgramController({ root, status: null,
                audioButton: null, transport: {}, outputMode });
            controller.renderGraphics = () => {};
            controller.renderOverlays = () => {};
            controller.syncCurrentAudioButton = () => {};
            const mediaA = { ...snapshot({ revision: 1 }),
                scene: { id: "program-a", name: "A", type: "MEDIA" },
                source: { id: "media-a", kind: "media", url: "/a.mp4" } };
            controller.current = { snapshot: mediaA, layer: new FakePublicElement("div"),
                cleanup() {} };
            let resolveLive;
            let preparations = 0;
            controller.createSource = () => { preparations += 1;
                return new Promise((resolve) => { resolveLive = resolve; }); };
            const live = (revision) => ({ ...snapshot({ revision }),
                scene: { id: "auto-live", name: "LIVE", type: "LIVE" },
                source: { id: "live-a", kind: "hls", url: "/live.m3u8" },
                playback: { ...snapshot().playback, playing: true, state: "playing" } });
            controller.handleSnapshot(live(2), { livePublisher: true });
            controller.handleSnapshot(live(3), { livePublisher: true });
            controller.handleSnapshot(live(4), { livePublisher: true });
            assert.equal(preparations, 1);
            resolveLive(() => {});
            await Promise.resolve(); await Promise.resolve();
            assert.equal(controller.current.snapshot.revision, 4);
            assert.equal(controller.current.snapshot.source.kind, "hls");
            clearTimeout(controller.staleTimer);
            controller.releaseCurrent();
        }
    }
    finally { globalThis.document = previousDocument; }
});

test("ProgramOutputStore retains final LIVE in the exact A LIVE A LIVE sequence", () => {
    const store = new ProgramOutputStore();
    const values = [
        { kind: "media", id: "media-a", url: "https://example.test/a.mp4" },
        { kind: "hls", id: "live-a", url: "https://example.test/live.m3u8" },
        { kind: "media", id: "media-a", url: "https://example.test/a.mp4" },
        { kind: "hls", id: "live-a", url: "https://example.test/live.m3u8" }
    ];
    values.forEach((source, index) => {
        const value = { ...snapshot({ revision: index + 1 }), source,
            scene: { id: source.id, name: source.id, type: source.kind === "hls"
                ? "LIVE" : "MEDIA" } };
        assert.equal(store.accept(createProgramOutputEnvelope(value)).accepted, true);
    });
    assert.equal(store.getCurrent().snapshot.revision, 4);
    assert.equal(store.getCurrent().snapshot.source.kind, "hls");
});

test("public AUDIO contract accepts every optional artwork combination", () => {
    const audioOnly = validateProgramOutputSnapshot(audioSnapshot());
    const still = validateProgramOutputSnapshot(audioSnapshot({
        stillUrl: "https://example.test/still.jpg" }));
    const motion = validateProgramOutputSnapshot(audioSnapshot({
        motionUrl: "https://example.test/motion.mp4" }));
    const both = validateProgramOutputSnapshot(audioSnapshot({
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" }));
    assert.equal(audioOnly.source.stillUrl, undefined);
    assert.equal(still.source.stillUrl, "https://example.test/still.jpg");
    assert.equal(motion.source.motionUrl, "https://example.test/motion.mp4");
    assert.equal(both.source.motionUrl, "https://example.test/motion.mp4");
    assert.equal(validateProgramOutputSnapshot({ ...audioSnapshot(), source: {
        id: "audio-source", kind: "audio" } }), null);
    assert.equal(validateProgramOutputSnapshot(audioSnapshot({
        stillUrl: "https://example.test/legacy.jpg" })).source.kind, "audio");
});

test("Program Output text crawl contract is optional, canonical and strict", () => {
    const legacy = validateProgramOutputSnapshot(snapshot());
    assert.ok(legacy);
    assert.equal(legacy.overlays, undefined);
    const textCrawl = { enabled: true, mode: "crawl", text: "  LIVE NEWS  ",
        direction: "rtl", speed: "medium", position: "bottom", background: true };
    const valid = validateProgramOutputSnapshot({ ...snapshot(), overlays: { textCrawl } });
    assert.deepEqual(valid.overlays.textCrawl, { ...textCrawl, text: "LIVE NEWS" });
    assert.equal(validateProgramOutputSnapshot({ ...snapshot(), overlays: {
        textCrawl: { ...textCrawl, speed: "instant" }
    } }), null);
    assert.equal(validateProgramOutputSnapshot({ ...snapshot(), overlays: {
        textCrawl: { ...textCrawl, text: "   " }
    } }), null);
});

test("Program Output store retains text crawl for a new Public subscriber", () => {
    const store = new ProgramOutputStore();
    const textCrawl = { enabled: true, mode: "fixed", text: "Retained headline",
        direction: "rtl", speed: "slow", position: "top", background: false };
    const envelope = createProgramOutputEnvelope({ ...snapshot(),
        overlays: { textCrawl } });
    assert.equal(store.accept(envelope).accepted, true);
    assert.deepEqual(store.getCurrent().snapshot.overlays.textCrawl, textCrawl);
});

test("text crawl SHOW HIDE UPDATE publish once and survive Program TAKE", () => {
    const graphicsManager = new StudioGraphicsManager();
    graphicsManager.initialize();
    graphicsManager.registerGraphic({ id: "program-text-crawl", kind: "text-crawl",
        position: "bottom", defaultVisible: false });
    let sceneId = "break-a";
    const published = [];
    const definitions = new Map([
        ["break-a", { id: "break-a", name: "BREAK A", type: "SLATE",
            renderer: { kind: "slate", title: "A", message: "A",
                logo: "https://example.test/logo.svg" } }],
        ["break-b", { id: "break-b", name: "BREAK B", type: "SLATE",
            renderer: { kind: "slate", title: "B", message: "B",
                logo: "https://example.test/logo.svg" } }]
    ]);
    const manager = new ProgramOutputManager({
        stateManager: { getProgramSceneId: () => sceneId,
            getScene: (id) => definitions.get(id) },
        catalog: { getDefinition: (id) => definitions.get(id), subscribe: () => () => {} },
        sourceManager: { getSource: () => null },
        renderer: { subscribeProgramTransport: () => () => {},
            getProgramTransport: () => null },
        graphicsManager,
        transitionCoordinator: { getSnapshot: () => ({ state: "idle", type: null }) },
        transport: { start() {}, publish: (value) => published.push(value), destroy() {} },
        now: () => Date.parse("2026-08-31T10:00:00.000Z")
    });
    manager.start();
    published.length = 0;
    const payload = { enabled: true, mode: "crawl", text: "First",
        direction: "rtl", speed: "medium", position: "bottom", background: true };
    graphicsManager.show("program-text-crawl", { consumer: "program", payload });
    assert.equal(published.length, 1);
    assert.equal(published[0].overlays.textCrawl.enabled, true);
    published.length = 0;
    graphicsManager.show("program-text-crawl", { consumer: "program",
        payload: { ...payload, text: "Updated", direction: "ltr", position: "top" } });
    assert.equal(published.length, 1);
    assert.equal(published[0].overlays.textCrawl.text, "Updated");
    published.length = 0;
    graphicsManager.show("program-text-crawl", { consumer: "program",
        payload: { ...payload, text: "Updated", direction: "ltr", position: "top",
            enabled: false } });
    assert.equal(published.length, 1);
    assert.equal(published[0].overlays.textCrawl.enabled, false);
    published.length = 0;
    graphicsManager.show("program-text-crawl", { consumer: "program",
        payload: { ...payload, text: "Persistent" } });
    published.length = 0;
    sceneId = "break-b";
    manager.handleProgramChanged();
    assert.equal(published.length, 1);
    assert.equal(published[0].scene.id, "break-b");
    assert.equal(published[0].overlays.textCrawl.text, "Persistent");
    manager.destroy();
});

test("text crawl operator state persists versioned configuration and enabled state", () => {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, value) };
    const actions = [];
    const ui = new StudioTextCrawlUI({ storage, graphicsManager: {
        show: (_id, options) => { actions.push(options.payload); return {}; }
    } });
    ui.text = { value: "Operator crawl" };
    ui.mode = { value: "crawl" };
    ui.direction = { value: "rtl" };
    ui.speed = { value: "fast" };
    ui.position = { value: "bottom" };
    ui.background = { checked: true };
    ui.status = { textContent: "" };
    ui.handleShow();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].enabled, true);
    ui.text.value = "Updated crawl";
    ui.handleUpdate();
    assert.equal(actions.length, 2);
    assert.equal(actions[1].text, "Updated crawl");
    ui.text.value = "";
    ui.handleHide();
    assert.equal(actions.length, 3);
    assert.equal(actions[2].enabled, false);
    assert.equal(actions[2].text, "Updated crawl");
    const persisted = JSON.parse(values.get(STUDIO_TEXT_CRAWL_STORAGE_KEY));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.textCrawl.enabled, false);
    assert.equal(persisted.textCrawl.text, "Updated crawl");
    const restored = new StudioTextCrawlUI({ storage }).readState();
    assert.deepEqual(restored, persisted.textCrawl);
});

test("Public text crawl reconciles safely without replacing Program media", () => {
    const previousDocument = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tagName) {
        const element = { tagName: tagName.toUpperCase(), className: "", textContent: "",
            children: [], appendChild(child) { this.children.push(child); },
            replaceChildren(...children) { this.children = children; },
            setAttribute() {} };
        created.push(element);
        return element;
    } };
    try {
        const overlayLayer = { children: [], replaceChildren(...children) {
            this.children = children;
        } };
        const media = { id: "program-media" };
        const controller = new PublicProgramController({ transport: {} });
        controller.current = { snapshot: { source: { kind: "media" } },
            layer: { children: [media] } };
        controller.getGraphicsLayer = () => overlayLayer;
        const textCrawl = { enabled: true, mode: "crawl",
            text: "<script>alert(1)</script>", direction: "ltr", speed: "fast",
            position: "top", background: false };
        controller.renderOverlays({ textCrawl });
        const overlay = overlayLayer.children[0];
        assert.match(overlay.className, /public-text-crawl--crawl/);
        assert.match(overlay.className, /public-text-crawl--ltr/);
        assert.match(overlay.className, /public-text-crawl--top/);
        assert.doesNotMatch(overlay.className, /background/);
        assert.equal(overlay.children[0].textContent, "<script>alert(1)</script>");
        assert.equal(controller.current.layer.children[0], media);
        controller.current.snapshot = { source: { kind: "audio" } };
        controller.renderOverlays({ textCrawl: { ...textCrawl, mode: "fixed",
            position: "bottom", background: true, text: "Fixed" } });
        assert.match(overlayLayer.children[0].className, /public-text-crawl--fixed/);
        assert.match(overlayLayer.children[0].className, /public-text-crawl--bottom/);
        assert.match(overlayLayer.children[0].className, /background/);
        assert.equal(controller.current.layer.children[0], media);
        controller.renderOverlays({ textCrawl: { ...textCrawl, enabled: false } });
        assert.equal(overlayLayer.children.length, 0);
        assert.equal(controller.current.layer.children[0], media);
    }
    finally { globalThis.document = previousDocument; }
});

test("Public reconciles an overlay-only revision with unchanged Program media", () => {
    const base = validateProgramOutputSnapshot(snapshot());
    const media = { id: "program-media" };
    const rendered = [];
    const controller = new PublicProgramController({ transport: {},
        now: () => Date.parse("2026-01-01T00:00:01.000Z") });
    controller.current = { snapshot: base, layer: { children: [media] } };
    controller.renderGraphics = () => {};
    controller.renderOverlays = (overlays) => rendered.push(overlays);
    controller.scheduleStaleState = () => {};
    controller.renderSnapshot = () => {
        throw new Error("overlay-only revision must not recreate Program media");
    };
    const textCrawl = { enabled: true, mode: "fixed", text: "Current headline",
        direction: "rtl", speed: "medium", position: "bottom", background: true };
    const update = validateProgramOutputSnapshot({ ...snapshot({ revision: 2 }),
        overlays: { textCrawl } });

    controller.handleSnapshot(update, { livePublisher: true });

    assert.deepEqual(rendered, [{ textCrawl }]);
    assert.equal(controller.current.snapshot, update);
    assert.equal(controller.current.layer.children[0], media);
});

test("Program snapshot projects AUDIO runtime URLs without managed asset IDs", () => {
    const manager = new ProgramOutputManager({ sourceManager: { getSource: () => ({
        id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4",
        audioAssetId: "A1", stillAssetId: "I1", motionAssetId: "M1"
    }) } });
    const source = manager.createSource({ renderer: { kind: "source",
        sourceId: "audio-source" } });
    assert.deepEqual(source, { id: "audio-source", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" });
});

test("active Program publishes updated AUDIO artwork without changing playback", () => {
    const published = [];
    const first = validateProgramOutputSnapshot(audioSnapshot({
        motionUrl: "https://example.test/m1.mp4" }));
    const manager = new ProgramOutputManager({
        stateManager: { getProgramSceneId: () => "audio-scene",
            getScene: () => first.scene },
        catalog: { getDefinition: () => ({ renderer: { kind: "source",
            sourceId: "audio-source" } }) },
        sourceManager: { getSource: () => ({ id: "audio-source", kind: "audio",
            audioUrl: "https://example.test/audio.mp3",
            motionUrl: "https://example.test/m2.mp4" }) },
        graphicsManager: { getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({ state: "idle" }) },
        transport: { publish: (value) => published.push(value) },
        now: () => Date.parse("2026-08-21T10:00:01.000Z")
    });
    manager.started = true;
    manager.snapshot = first;
    manager.revision = first.revision;
    manager.publisherSessionId = first.publisherSessionId;
    manager.handleCatalogChanged();
    assert.equal(published.length, 1);
    assert.equal(published[0].source.motionUrl, "https://example.test/m2.mp4");
    assert.deepEqual(published[0].playback, first.playback);
});

test("Program source promotion baselines transport before one authoritative publish", () => {
    let sceneId = "media-a-scene";
    let transition = { state: "running", type: "dissolve" };
    const published = [];
    const sources = new Map([
        ["media-a", { id: "media-a", kind: "media",
            url: "https://example.test/a.mp4" }],
        ["media-b", { id: "media-b", kind: "media",
            url: "https://example.test/b.mp4" }],
        ["audio-a", { id: "audio-a", kind: "audio",
            audioUrl: "https://example.test/audio.mp3",
            stillUrl: "https://example.test/still.jpg",
            motionUrl: "https://example.test/motion.mp4" }]
    ]);
    const definitions = new Map([
        ["media-a-scene", { id: "media-a-scene", name: "MEDIA A", type: "MEDIA",
            renderer: { kind: "source", sourceId: "media-a" } }],
        ["media-b-scene", { id: "media-b-scene", name: "MEDIA B", type: "MEDIA",
            renderer: { kind: "source", sourceId: "media-b" } }],
        ["audio-a-scene", { id: "audio-a-scene", name: "AUDIO A", type: "AUDIO",
            renderer: { kind: "source", sourceId: "audio-a" } }]
    ]);
    let programTransport = { sourceId: "media-a", state: "playing",
        currentTime: 1, duration: 60, ended: false };
    const manager = new ProgramOutputManager({
        stateManager: {
            getProgramSceneId: () => sceneId,
            getScene: (id) => definitions.get(id)
        },
        catalog: { getDefinition: (id) => definitions.get(id) },
        sourceManager: { getSource: (id) => sources.get(id) },
        renderer: { getProgramTransport: () => programTransport },
        graphicsManager: { getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => transition },
        transport: { publish: (value) => published.push(value) },
        now: () => Date.parse("2026-08-21T10:00:00.000Z")
    });
    manager.started = true;
    manager.handleProgramTransport(programTransport);
    manager.handleProgramChanged();
    published.length = 0;

    const take = (nextSceneId, nextTransport) => {
        sceneId = nextSceneId;
        programTransport = nextTransport;
        manager.handleProgramTransport(nextTransport);
        assert.equal(published.length, 0);
        manager.handleProgramChanged();
        assert.equal(published.length, 1);
        return published.pop();
    };

    const mediaB = take("media-b-scene", { sourceId: "media-b", state: "playing",
        currentTime: 2, duration: 60, ended: false });
    assert.deepEqual(mediaB.transition, { type: "dissolve", durationMs: 400 });

    const audio = take("audio-a-scene", { sourceId: "audio-a", state: "playing",
        currentTime: 3, duration: 90, ended: false });
    assert.equal(audio.source.audioUrl, "https://example.test/audio.mp3");
    assert.equal(audio.source.stillUrl, "https://example.test/still.jpg");
    assert.equal(audio.source.motionUrl, "https://example.test/motion.mp4");

    take("media-a-scene", { sourceId: "media-a", state: "playing",
        currentTime: 4, duration: 60, ended: false });

    transition = { state: "idle", type: null };
    programTransport = { ...programTransport, state: "paused" };
    manager.handleProgramTransport(programTransport);
    assert.equal(published.length, 1);
    assert.equal(published[0].playback.state, "paused");
});

test("ProgramOutputStore retains AUDIO motion artwork", () => {
    const store = new ProgramOutputStore();
    const envelope = createProgramOutputEnvelope(audioSnapshot({
        motionUrl: "https://example.test/motion.mp4" }));
    assert.equal(store.accept(envelope).accepted, true);
    assert.equal(store.getCurrent().snapshot.source.motionUrl,
        "https://example.test/motion.mp4");
});

test("Public AUDIO motion CSS fills composition and honors hidden", async () => {
    const css = await readFile(new URL("../public/css/public-viewer.css",
        import.meta.url), "utf8");
    assert.match(css, /\.public-program-audio-motion\s*\{/);
    assert.match(css, /\.public-program-audio-motion\[hidden\][^{]*\{[^}]*display:\s*none;/s);
});

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
        method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`, "X-Livezone-Program-Manual":"1",
            "Content-Type": "application/json" }, body: "{"
    });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/program-output`, {
        method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`, "X-Livezone-Program-Manual":"1" },
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
        method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`, "X-Livezone-Program-Manual":"1",
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

test("publisher retries one transient failure with conservative backoff", async () => {
    const timers = fakeTimers();
    const requests = [];
    const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) throw new Error("server unavailable");
        return { ok: true, status: 202 };
    } });
    transport.start();
    transport.publish(snapshot());
    await transport.publishQueue;
    assert.equal(transport.status, "publishing-error");
    assert.deepEqual(timers.delays, [8000, 1000]);
    timers.runNext();
    await transport.publishQueue;
    assert.equal(requests.length, 2);
    assert.equal(transport.status, "connected");
    transport.destroy();
});

test("publisher does not retry permanent client and protocol failures", async () => {
    for (const status of [400, 404, 405, 415, 422]) {
        const timers = fakeTimers(); let attempts = 0;
        const transport = recoveryTransport({ timers, fetchImplementation: async () => {
            attempts += 1; return { ok: false, status };
        } });
        transport.start(); transport.publish(snapshot()); await transport.publishQueue;
        assert.equal(attempts, 1, `status ${status}`);
        assert.equal(timers.pending(), 0, `status ${status}`);
        assert.equal(transport.status, "protocol-error", `status ${status}`);
        transport.destroy();
    }
});

test("publisher distinguishes stale retired and unknown 409 conflicts", async () => {
    for (const [reason, expectedStatus, synchronized] of [
        ["stale-revision", "connected", true],
        ["retired-session", "publisher-conflict", false],
        ["unexpected-conflict", "protocol-error", false],
        [null, "protocol-error", false]
    ]) {
        const timers = fakeTimers();
        const transport = recoveryTransport({ timers, fetchImplementation: async () => ({
            ok: false, status: 409,
            json: async () => reason === null ? Promise.reject(new Error("malformed"))
                : { ok: false, error: reason }
        }) });
        transport.start(); transport.publish(snapshot());
        const result = await transport.publishQueue;
        assert.equal(result, synchronized, String(reason));
        assert.equal(transport.status, expectedStatus, String(reason));
        assert.equal(timers.pending(), 0, String(reason));
        assert.equal(transport.latestEnvelope.revision, 1);
        transport.destroy();
    }
});

test("publisher retries only explicitly transient HTTP and network failures", async () => {
    for (const failure of [408, 429, 500, 502, 503, 504, "network"]) {
        const timers = fakeTimers();
        const transport = recoveryTransport({ timers, fetchImplementation: async () => {
            if (failure === "network") throw new Error("connection refused");
            return { ok: false, status: failure };
        } });
        transport.start(); transport.publish(snapshot()); await transport.publishQueue;
        assert.equal(transport.status, "publishing-error", String(failure));
        assert.deepEqual(timers.activeDelays(), [1000], String(failure));
        transport.destroy();
    }
});

test("publisher timeout releases the queue and newest Program eventually wins", async () => {
    const timers = fakeTimers(); const revisions = []; let first = true;
    const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
        const revision = JSON.parse(options.body).revision; revisions.push(revision);
        if (!first) return { ok: true, status: 202 };
        first = false;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("timeout"), { name: "AbortError" })), { once: true }));
    } });
    transport.start();
    transport.publish(snapshot({ revision: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    transport.publish(snapshot({ revision: 2 }));
    transport.publish(snapshot({ revision: 3 }));
    assert.deepEqual(revisions, [1]);
    timers.runDelay(8000);
    await transport.publishQueue;
    assert.deepEqual(revisions, [1, 2, 3]);
    assert.equal(revisions.at(-1), 3);
    assert.equal(transport.status, "connected");
    assert.equal(timers.pending(), 0);
    transport.publish(snapshot({ revision: 4 })); await transport.publishQueue;
    assert.equal(revisions.at(-1), 4);
    transport.destroy();
});

test("publisher timeout is transient and follows the configured backoff", async () => {
    const timers = fakeTimers(); let first = true; let attempts = 0;
    const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
        attempts += 1;
        if (!first) return { ok: true, status: 202 };
        first = false;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("timeout"), { name: "AbortError" })), { once: true }));
    } });
    transport.start(); transport.publish(snapshot());
    await new Promise((resolve) => setImmediate(resolve));
    timers.runDelay(8000); await transport.publishQueue;
    assert.equal(transport.status, "publishing-error");
    assert.deepEqual(timers.activeDelays(), [1000]);
    timers.runDelay(1000); await transport.publishQueue;
    assert.equal(attempts, 2);
    assert.equal(transport.status, "connected");
    assert.equal(timers.pending(), 0);
    transport.destroy();
});

test("failed in-flight and scheduled retry always select the newest envelope", async () => {
    const timers = fakeTimers(); const revisions = []; let rejectFirst;
    const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
        revisions.push(JSON.parse(options.body).revision);
        if (revisions.length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
        return { ok: true, status: 202 };
    } });
    transport.start(); transport.publish(snapshot({ revision: 1 }));
    await new Promise((resolve) => setImmediate(resolve));
    transport.publish(snapshot({ revision: 2 }));
    rejectFirst(new Error("offline"));
    await transport.publishQueue;
    assert.deepEqual(revisions, [1, 2]);
    assert.equal(timers.pending(), 0);
    transport.destroy();

    const retryTimers = fakeTimers(); const retried = []; let available = false;
    const retryTransport = recoveryTransport({ timers: retryTimers,
        fetchImplementation: async (_url, options) => {
            retried.push(JSON.parse(options.body).revision);
            if (!available) throw new Error("offline");
            return { ok: true, status: 202 };
        } });
    retryTransport.start(); retryTransport.publish(snapshot({ revision: 1 }));
    await retryTransport.publishQueue;
    retryTransport.publish(snapshot({ revision: 2 }));
    available = true; retryTimers.runDelay(1000); await retryTransport.publishQueue;
    assert.deepEqual(retried, [1, 2]);
    retryTransport.destroy();
});

test("retry and repeated false SSE reconnects remain bounded and latest-wins", async () => {
    const timers = fakeTimers(); const source = new FakeEventSource();
    const revisions = []; let available = false;
    const transport = recoveryTransport({ timers, eventSourceFactory: () => source,
        fetchImplementation: async (_url, options) => {
            revisions.push(JSON.parse(options.body).revision);
            if (!available) throw new Error("offline");
            return { ok: true, status: 202 };
        } });
    transport.start(); source.emit("open", {});
    transport.publish(snapshot({ revision: 1 })); await transport.publishQueue;
    transport.publish(snapshot({ revision: 2 })); available = true;
    timers.runDelay(1000); source.emit("error", {}); source.emit("open", {});
    await transport.publishQueue;
    assert.deepEqual(revisions, [1, 2, 2]);
    for (let index = 0; index < 3; index += 1) {
        source.emit("error", {}); source.emit("open", {}); await transport.publishQueue;
    }
    assert.deepEqual(revisions, [1, 2, 2, 2, 2, 2]);
    assert.equal(timers.pending(), 0);
    transport.destroy();
});

test("destroy aborts a hung publish and prevents queued or retry publication", async () => {
    const timers = fakeTimers(); let attempts = 0; let aborted = false;
    const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
        attempts += 1;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("destroyed"), { name: "AbortError" }));
        }, { once: true }));
    } });
    transport.start(); transport.publish(snapshot());
    await new Promise((resolve) => setImmediate(resolve));
    transport.destroy(); await transport.publishQueue;
    timers.runAll(); await transport.publishQueue;
    assert.equal(aborted, true);
    assert.equal(attempts, 1);
    assert.equal(timers.pending(), 0);
});

test("publisher recovery coalesces unavailable Program changes to the newest snapshot", async () => {
    const timers = fakeTimers();
    let available = false;
    const revisions = [];
    const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
        revisions.push(JSON.parse(options.body).revision);
        if (!available) throw new Error("server unavailable");
        return { ok: true, status: 202 };
    } });
    transport.start();
    transport.publish(snapshot({ revision: 1 }));
    await transport.publishQueue;
    transport.publish(snapshot({ revision: 2 }));
    transport.publish(snapshot({ revision: 3 }));
    transport.publish(imageSnapshot({ revision: 4 }));
    assert.deepEqual(revisions, [1]);
    available = true;
    timers.runNext();
    await transport.publishQueue;
    assert.deepEqual(revisions, [1, 4]);
    assert.equal(transport.latestEnvelope.snapshot.source.kind, "image");
    transport.destroy();
});

test("publisher SSE reconnection restores a Node store from the latest Program", async () => {
    const source = new FakeEventSource();
    const revisions = [];
    const transport = recoveryTransport({ eventSourceFactory: () => source,
        fetchImplementation: async (_url, options) => {
            revisions.push(JSON.parse(options.body).revision);
            return { ok: true, status: 202 };
        } });
    transport.start();
    transport.publish(snapshot({ revision: 1 }));
    await transport.publishQueue;
    source.emit("open", {});
    source.emit("error", {});
    source.emit("open", {});
    await transport.publishQueue;
    assert.deepEqual(revisions, [1, 1]);
    assert.equal(transport.status, "connected");
    transport.destroy();
    assert.equal(source.closed, true);
});

test("publisher recovery preserves BREAK VIDEO AUDIO IMAGE and LIVE payloads", async () => {
    const variants = [
        snapshot(),
        { ...snapshot(), scene: { id: "video-scene", name: "VIDEO", type: "VIDEO" },
            source: { id: "video", kind: "media", url: "https://example.test/video.mp4" } },
        audioSnapshot(), imageSnapshot(),
        { ...snapshot(), scene: { id: "live-scene", name: "LIVE", type: "LIVE" },
            source: { id: "live", kind: "hls", url: "https://example.test/live.m3u8" },
            playback: { ...snapshot().playback, playing: true, state: "playing" } }
    ];
    for (const [index, variant] of variants.entries()) {
        const timers = fakeTimers();
        let attempt = 0; let recovered = null;
        const candidate = { ...variant, revision: index + 1 };
        const transport = recoveryTransport({ timers, fetchImplementation: async (_url, options) => {
            attempt += 1;
            if (attempt === 1) throw new Error("offline");
            recovered = JSON.parse(options.body).snapshot;
            return { ok: true, status: 202 };
        } });
        transport.start(); transport.publish(candidate); await transport.publishQueue;
        timers.runNext(); await transport.publishQueue;
        assert.deepEqual(recovered.source, candidate.source);
        transport.destroy();
    }
});

test("publisher auth failures do not retry until an explicit credential refresh", async () => {
    const timers = fakeTimers();
    const source = new FakeEventSource();
    let token = TOKEN; let attempts = 0;
    const transport = recoveryTransport({ timers, tokenProvider: () => token,
        eventSourceFactory: () => source,
        fetchImplementation: async () => {
            attempts += 1;
            return attempts === 1 ? { ok: false, status: 401 } : { ok: true, status: 202 };
        } });
    transport.start(); transport.publish(snapshot()); await transport.publishQueue;
    assert.equal(transport.status, "auth-error");
    assert.equal(timers.pending(), 0);
    transport.publish(snapshot({ revision: 2 }));
    await transport.publishQueue;
    assert.equal(attempts, 1);
    source.emit("open", {});
    source.emit("error", {});
    assert.equal(transport.status, "auth-error");
    source.emit("open", {});
    await transport.publishQueue;
    assert.equal(attempts, 1);
    token = "replacement-test-token-12345";
    transport.refreshPublisherCredential();
    await transport.publishQueue;
    assert.equal(attempts, 2);
    assert.equal(transport.latestEnvelope.revision, 2);
    transport.destroy();
});

test("destroy cancels publisher recovery and prevents delayed publication", async () => {
    const timers = fakeTimers();
    let attempts = 0;
    const transport = recoveryTransport({ timers, fetchImplementation: async () => {
        attempts += 1; throw new Error("offline");
    } });
    transport.start(); transport.publish(snapshot()); await transport.publishQueue;
    assert.equal(timers.pending(), 1);
    transport.destroy();
    timers.runNext();
    await transport.publishQueue;
    assert.equal(attempts, 1);
    assert.equal(timers.pending(), 0);
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

test("rehydrated VIDEO waits for playing transport before publisher ownership", () => {
    let transportListener = null;
    const published = [];
    const state = { sceneId: "video-a-scene" };
    const sources = new Map([
        ["video-a", { id: "video-a", kind: "media",
            url: "https://example.test/a.mp4" }],
        ["video-b", { id: "video-b", kind: "media",
            url: "https://example.test/b.mp4" }]
    ]);
    const definitions = new Map(Array.from(sources, ([id]) => [
        `${id}-scene`, { id: `${id}-scene`, name: id, type: "MEDIA",
            renderer: { kind: "source", sourceId: id } }
    ]));
    let rendererTransport = null;
    const manager = new ProgramOutputManager({
        stateManager: {
            getProgramSceneId: () => state.sceneId,
            getScene: (id) => definitions.get(id)
        },
        catalog: { getDefinition: (id) => definitions.get(id),
            subscribe: () => () => {} },
        sourceManager: { getSource: (id) => sources.get(id) },
        renderer: {
            subscribeProgramTransport(listener) {
                transportListener = listener;
                listener(rendererTransport);
                return () => {};
            },
            getProgramTransport: () => rendererTransport
        },
        graphicsManager: { subscribe: () => () => {},
            getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({
            state: "running", type: "cut" }) },
        transport: { start() {}, publish: (value) => published.push(value),
            destroy() {} }
    });

    manager.start();
    assert.equal(published.length, 0,
        "a transient restored first frame must not replace retained Program");
    rendererTransport = { sourceId: "video-a", state: "paused",
        currentTime: 0, duration: 60, ended: false };
    transportListener(rendererTransport);
    assert.equal(published.length, 0);
    rendererTransport = { ...rendererTransport, state: "playing" };
    transportListener(rendererTransport);
    assert.equal(published.length, 1);
    assert.equal(published[0].source.id, "video-a");
    assert.equal(published[0].playback.playing, true);

    state.sceneId = "video-b-scene";
    rendererTransport = { sourceId: "video-b", state: "paused",
        currentTime: 0, duration: 90, ended: false };
    manager.handleProgramChanged();
    assert.equal(published.length, 1);
    rendererTransport = { ...rendererTransport, state: "playing" };
    transportListener(rendererTransport);
    assert.equal(published.length, 2);
    assert.equal(published[1].source.id, "video-b");
    assert.equal(published[1].playback.playing, true);
    assert.equal(published[1].transition.type, "cut");
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
    const local = memoryStorage();
    local.setItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY, "wrong-token-value");
    const transport = new NetworkProgramOutputTransport({
        role: "publisher",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        tokenProvider: () => readPersistentPublisherToken({
            persistentStorage: local, legacyStorage: memoryStorage() }),
        fetchImplementation: async () => ({ ok: false, status: 401 })
    });
    transport.start();
    transport.publish(snapshot());
    await transport.publishQueue;
    assert.equal(transport.status, "auth-error");
    assert.equal(local.getItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY),
        "wrong-token-value");
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

test("HTTP server retains and emits text crawl across active update hide and legacy input",
    async (context) => {
        const { server, store } = createProgramOutputServer({ publisherToken: TOKEN });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        context.after(() => new Promise((resolve) => server.close(resolve)));
        const base = `http://127.0.0.1:${server.address().port}`;
        const active = { enabled: true, mode: "crawl", text: "Breaking news",
            direction: "rtl", speed: "medium", position: "bottom", background: true };
        const activeEnvelope = createProgramOutputEnvelope({ ...snapshot(),
            overlays: { textCrawl: active } });

        assert.equal((await publish(base, activeEnvelope)).status, 202);
        assert.deepEqual(store.getCurrent().snapshot.overlays.textCrawl, active);

        const abort = new AbortController();
        const response = await fetch(`${base}/api/program-output/events`, {
            signal: abort.signal
        });
        const reader = response.body.getReader();
        const retained = await readProgramEvent(reader);
        assert.match(retained, /"textCrawl":\{"enabled":true/);
        assert.match(retained, /"text":"Breaking news"/);

        const updated = { ...active, text: "Updated headline", position: "top" };
        const updateEnvelope = createProgramOutputEnvelope({
            ...snapshot({ revision: 2, publishedAt: "2026-08-21T10:00:01.000Z" }),
            overlays: { textCrawl: updated }
        });
        assert.equal((await publish(base, updateEnvelope)).status, 202);
        assert.deepEqual(store.getCurrent().snapshot.overlays.textCrawl, updated);
        assert.match(await readProgramEvent(reader), /"text":"Updated headline"/);

        const hidden = { ...updated, enabled: false };
        const hideEnvelope = createProgramOutputEnvelope({
            ...snapshot({ revision: 3, publishedAt: "2026-08-21T10:00:02.000Z" }),
            overlays: { textCrawl: hidden }
        });
        assert.equal((await publish(base, hideEnvelope)).status, 202);
        assert.equal(store.getCurrent().snapshot.overlays.textCrawl.enabled, false);
        assert.match(await readProgramEvent(reader), /"enabled":false/);

        const legacyEnvelope = createProgramOutputEnvelope(snapshot({ revision: 4,
            publishedAt: "2026-08-21T10:00:03.000Z" }));
        assert.equal((await publish(base, legacyEnvelope)).status, 202);
        assert.equal(store.getCurrent().snapshot.overlays, undefined);
        assert.doesNotMatch(await readProgramEvent(reader), /"overlays"/);
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

test("late SSE subscriber receives retained AUDIO motion artwork", async (context) => {
    const { server } = createProgramOutputServer({ publisherToken: TOKEN });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const envelope = createProgramOutputEnvelope(audioSnapshot({
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" }));
    assert.equal((await publish(base, envelope)).status, 202);
    const abort = new AbortController();
    const response = await fetch(`${base}/api/program-output/events`, {
        signal: abort.signal
    });
    const event = await readProgramEvent(response.body.getReader());
    assert.match(event, /"motionUrl":"https:\/\/example\.test\/motion\.mp4"/);
    abort.abort();
});

function publish(base, body) {
    return fetch(`${base}/api/program-output`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${TOKEN}`, "X-Livezone-Program-Manual":"1", "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

function fakeTimers() {
    const timers = [];
    return {
        delays: [],
        set(callback, delay) {
            const timer = { callback, delay, cleared: false, unref() {} };
            timers.push(timer); this.delays.push(delay); return timer;
        },
        clear(timer) { timer.cleared = true; },
        runNext() {
            const timer = timers.find((candidate) => !candidate.cleared);
            if (timer) { timer.cleared = true; timer.callback(); }
        },
        runDelay(delay) {
            const timer = timers.find((candidate) => !candidate.cleared &&
                candidate.delay === delay);
            if (timer) { timer.cleared = true; timer.callback(); }
        },
        runAll() {
            for (const timer of timers.filter((candidate) => !candidate.cleared)) {
                timer.cleared = true; timer.callback();
            }
        },
        activeDelays() {
            return timers.filter((timer) => !timer.cleared).map(({ delay }) => delay);
        },
        pending() { return timers.filter((timer) => !timer.cleared).length; }
    };
}

function recoveryTransport({ timers = fakeTimers(), tokenProvider = () => TOKEN,
    fetchImplementation, eventSourceFactory = null } = {}) {
    return new NetworkProgramOutputTransport({
        role: "publisher",
        publishUrl: "https://livezone.test/api/program-output",
        subscribeUrl: "https://livezone.test/api/program-output/events",
        tokenProvider,
        fetchImplementation,
        eventSourceFactory,
        setTimer: timers.set.bind(timers),
        clearTimer: timers.clear.bind(timers)
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
