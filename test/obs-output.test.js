import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import PublicProgramController from
    "../public/js/public/PublicProgramController.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OBS output shell is broadcast-only and uses the shared subscriber renderer", async () => {
    const [html, entry] = await Promise.all([
        read("../public/output/obs/index.html"),
        read("../public/js/entries/obs-output-app.js")
    ]);
    assert.match(html, /id="obs-program"/);
    assert.match(html, /data-public-base/);
    assert.match(html, /data-public-graphics/);
    assert.match(html, /hls\.min\.js/);
    for (const forbidden of ["button", "ENABLE AUDIO", "public-program-status",
        "fullscreen", "login", "operator", "token"]) {
        assert.doesNotMatch(html, new RegExp(forbidden, "i"));
    }
    assert.match(entry, /createProgramOutputTransport\(\{ role: "subscriber" \}\)/);
    assert.match(entry, /PublicProgramController/);
    assert.match(entry, /outputMode: "obs"/);
    assert.doesNotMatch(entry, /publisher|token|localStorage|sessionStorage/);
});

test("OBS CSS maps a clean 16:9 canvas into the complete black viewport", async () => {
    const css = await read("../public/css/obs-output.css");
    assert.match(css, /html, body \{ width: 100%; height: 100%/);
    assert.match(css, /overflow: hidden/);
    assert.match(css, /background: #000/);
    assert.match(css, /pointer-events: none/);
    assert.match(css, /calc\(100vh \* 16 \/ 9\)/);
    assert.match(css, /calc\(100vw \* 9 \/ 16\)/);
});

test("OBS mode starts audio-enabled while Public Viewer retains its human gate", () => {
    const obs = controller("obs");
    const viewer = controller("public");
    assert.equal(obs.audioEnabled, true);
    assert.equal(viewer.audioEnabled, false);
    assert.throws(() => controller("unknown"), /Unknown Program output mode/);
});

test("OBS waiting and disconnected output stays empty and black-ready", () => {
    const base = new FakeElement("div");
    const graphics = new FakeElement("div");
    const root = { querySelector: (selector) => selector === "[data-public-base]"
        ? base : selector === "[data-public-graphics]" ? graphics : null };
    const obs = new PublicProgramController({ root, status: null, audioButton: null,
        transport: transportStub(), outputMode: "obs" });
    obs.renderWaiting();
    assert.deepEqual(base.children, []);
    assert.deepEqual(graphics.children, []);
});

test("OBS VIDEO and native LIVE request audible autoplay without changing Public", async () => {
    await withFakeDocument(async (created) => {
        const obs = controller("obs");
        const videoPending = obs.createSource(new FakeElement("div"),
            programSnapshot("media"));
        const video = created.at(-1);
        video.dispatchEvent(new Event("loadeddata"));
        const releaseVideo = await videoPending;
        assert.equal(video.muted, false);
        assert.equal(video.defaultMuted, false);
        assert.equal(video.autoplay, true);
        assert.equal(video.playCalls, 1);
        releaseVideo();
        assert.equal(video.src, "");

        const livePending = obs.createSource(new FakeElement("div"),
            programSnapshot("hls"));
        const live = created.at(-1);
        live.dispatchEvent(new Event("canplay"));
        const releaseLive = await livePending;
        assert.equal(live.muted, false);
        assert.equal(live.autoplay, true);
        assert.equal(live.playCalls, 1);
        releaseLive();

        const viewer = controller("public");
        const publicPending = viewer.createSource(new FakeElement("div"),
            programSnapshot("media"));
        const publicVideo = created.at(-1);
        publicVideo.dispatchEvent(new Event("loadeddata"));
        const releasePublic = await publicPending;
        assert.equal(publicVideo.muted, true);
        assert.equal(publicVideo.playCalls, 1);
        releasePublic();
    });
});

test("OBS AUDIO is audible while motion artwork is always muted and visual-only", async () => {
    await withFakeDocument(async (created) => {
        const obs = controller("obs");
        const pending = obs.createSource(new FakeElement("div"), programSnapshot("audio"));
        const audio = created.find(({ tagName }) => tagName === "AUDIO");
        const still = created.find(({ tagName }) => tagName === "IMG");
        const motion = created.find(({ tagName }) => tagName === "VIDEO");
        audio.dispatchEvent(new Event("loadeddata"));
        const cleanup = await pending;
        assert.equal(audio.muted, false);
        assert.equal(audio.playCalls, 1);
        assert.equal(still.src, "https://example.test/still.jpg");
        assert.equal(motion.muted, true);
        assert.equal(motion.defaultMuted, true);
        assert.equal(motion.loop, true);
        assert.equal(motion.autoplay, true);
        cleanup();
        assert.equal(audio.src, "");
        assert.equal(motion.src, "");
    });
});

test("OBS reuses IMAGE BREAK graphics crawl CUT and DISSOLVE rendering paths", async () => {
    const source = await read("../public/js/public/PublicProgramController.js");
    const entry = await read("../public/js/entries/obs-output-app.js");
    assert.match(source, /source\.kind === "image"/);
    assert.match(source, /source\.kind === "break"/);
    assert.match(source, /renderGraphics\(snapshot\.graphics\.items\)/);
    assert.match(source, /renderOverlays\(snapshot\.overlays\)/);
    assert.match(source, /snapshot\.transition\.type === "dissolve"/);
    assert.match(source, /replaceChildren\(layer\)/);
    assert.match(entry, /outputMode: "obs"/);
});

test("OBS boot retries invisibly and delegates SSE reconnect and validation", async () => {
    const [entry, transport] = await Promise.all([
        read("../public/js/entries/obs-output-app.js"),
        read("../public/js/program-output/NetworkProgramOutputTransport.js")
    ]);
    assert.match(entry, /catch \{[\s\S]*setTimeout\(boot, BOOT_RETRY_MS\)/);
    assert.match(entry, /pagehide/);
    assert.match(transport, /new globalThis\.EventSource/);
    assert.match(transport, /validateProgramOutputEnvelope/);
    assert.match(transport, /addEventListener\("program", this\.handleProgram\)/);
});

test("OBS documentation records local settings and the loopback-only security boundary", async () => {
    const documentation = await read("../docs/LOCAL-OBS-OUTPUT.md");
    assert.match(documentation, /http:\/\/127\.0\.0\.1:8080\/output\/obs\//);
    assert.match(documentation, /Width: `1920`/);
    assert.match(documentation, /Height: `1080`/);
    assert.match(documentation, /Control audio via OBS: enabled/);
    assert.match(documentation, /Actual playback[\s\S]*OBS\/CEF media policy/);
    assert.match(documentation, /native-HLS\/HLS\.js recovery behavior/);
    assert.match(documentation, /local build only[\s\S]*bound to[\s\S]*`127\.0\.0\.1`/);
    assert.match(documentation, /dedicated read capability|reverse-proxy access restriction/);
});

function controller(outputMode) {
    return new PublicProgramController({ root: null, status: null, audioButton: null,
        transport: transportStub(), outputMode,
        now: () => Date.parse("2026-09-07T10:00:00.000Z") });
}

function transportStub() {
    return { start() {}, subscribe: () => () => {}, destroy() {} };
}

function programSnapshot(kind) {
    const now = "2026-09-07T10:00:00.000Z";
    const source = kind === "audio"
        ? { id: "audio", kind, audioUrl: "https://example.test/audio.mp3",
            stillUrl: "https://example.test/still.jpg",
            motionUrl: "https://example.test/motion.mp4" }
        : { id: kind, kind, url: kind === "hls"
            ? "https://example.test/live.m3u8" : "https://example.test/video.mp4" };
    return { version: 1, revision: 1, publisherSessionId: "obs-test",
        publishedAt: now, committedAt: now,
        scene: { id: kind, name: kind.toUpperCase(), type: kind.toUpperCase() }, source,
        playback: { initialTime: 0, duration: 60, playing: true, ended: false,
            state: "playing", startedAt: now }, graphics: { items: [] },
        transition: { type: "cut", durationMs: 0 } };
}

async function withFakeDocument(callback) {
    const previous = globalThis.document;
    const created = [];
    globalThis.document = { createElement(tagName) {
        const element = new FakeElement(tagName); created.push(element); return element;
    } };
    try { await callback(created); }
    finally { globalThis.document = previous; }
}

class FakeElement extends EventTarget {
    constructor(tagName) {
        super();
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.hidden = false;
        this.currentTime = 0;
        this.duration = 60;
        this.paused = true;
        this.muted = false;
        this.playCalls = 0;
        this.loadCalls = 0;
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    canPlayType() { return "probably"; }
    setAttribute(name) { if (name === "muted") this.mutedAttribute = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    async play() { this.playCalls += 1; this.paused = false; }
    pause() { this.paused = true; }
    load() { this.loadCalls += 1; }
}
