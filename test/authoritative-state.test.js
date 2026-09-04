import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AuthoritativeStateRepository from "../server/studio/AuthoritativeStateRepository.js";
import StudioStateCoordinator from "../server/studio/StudioStateCoordinator.js";
import { createInitializedState, createUninitializedState,
    validateAuthoritativeState } from "../server/studio/AuthoritativeStateContract.js";
import { createProgramOutputServer } from "../server/program-output-server.js";
import MediaAssetRepository from "../server/media-library/MediaAssetRepository.js";
import OperatorAuth from "../server/auth/OperatorAuth.js";

const NOW = "2026-09-04T10:00:00.000Z";
const ID = "state-00000000-0000-4000-8000-000000000001";
const TOKEN = "separate-publisher-token";

test("contract strictly validates the envelope and legacy relationships", () => {
    const state = createUninitializedState({ stateId: ID, updatedAt: NOW });
    assert.equal(state.revision, 0);
    assert.equal(Object.isFrozen(state.scheduler), true);
    assert.equal(validateAuthoritativeState({ ...state, unexpected: true }), null);
    assert.equal(validateAuthoritativeState({ ...state, schemaVersion: 2 }), null);
    assert.equal(validateAuthoritativeState({ ...state, revision: 1 }), null);
    const domains = initialDomains();
    const initialized = createInitializedState(domains,
        { stateId: ID, updatedAt: NOW, revision: 1 });
    assert.equal(initialized.sources[0].assetId, "asset-video");
    assert.equal(createInitializedState({ ...domains, scenes: [
        { id: "scene-missing", name: "Missing", type: "VIDEO",
            renderer: { kind: "source", sourceId: "missing" } }
    ] }, { stateId: ID, updatedAt: NOW }), null);
});

test("contract accepts every persisted legacy source authority shape", () => {
    const sources = [
        { id: "media-managed", name: "Managed video", kind: "media", assetId: "asset-video" },
        { id: "media-url", name: "URL video", kind: "media", url: "https://example.test/v.mp4" },
        { id: "image-managed", name: "Managed image", kind: "image", assetId: "asset-image" },
        { id: "image-url", name: "URL image", kind: "image", url: "https://example.test/i.png" },
        { id: "audio-managed", name: "Managed audio", kind: "audio", audioAssetId: "asset-audio" },
        { id: "audio-still", name: "Static", kind: "audio", audioAssetId: "asset-audio", stillAssetId: "asset-still" },
        { id: "audio-motion", name: "Motion", kind: "audio", audioAssetId: "asset-audio", motionAssetId: "asset-motion" },
        { id: "audio-both", name: "Both", kind: "audio", audioAssetId: "asset-audio", stillAssetId: "asset-still", motionAssetId: "asset-motion" },
        { id: "audio-url", name: "URL audio", kind: "audio", audioUrl: "https://example.test/a.mp3" },
        { id: "audio-url-still", name: "URL artwork", kind: "audio", audioUrl: "https://example.test/a.mp3", stillUrl: "https://example.test/i.png" },
        { id: "live-url", name: "Live URL", kind: "hls", url: "https://example.test/live.m3u8", enabled: true },
        { id: "live-config", name: "Live config", kind: "hls", configRef: "local-main", enabled: false }
    ];
    for (const source of sources) {
        assert.ok(stateWith({ sources: [source] }), `expected valid source ${source.id}`);
    }
    assert.ok(stateWith({ sources: [sources.at(-1)],
        dominantLive: { armed: true, authorizedSourceId: "live-config" } }));
});

test("contract rejects cross-kind, ambiguous, unknown and invalid artwork fields", () => {
    const invalid = [
        { id: "x", name: "X", kind: "hls", assetId: "asset-x", enabled: true },
        { id: "x", name: "X", kind: "hls", audioAssetId: "asset-x", enabled: true },
        { id: "x", name: "X", kind: "hls", stillAssetId: "asset-x", enabled: true },
        { id: "x", name: "X", kind: "hls", motionAssetId: "asset-x", enabled: true },
        { id: "x", name: "X", kind: "hls", url: "https://example.test/live.m3u8", configRef: "main", enabled: true },
        { id: "x", name: "X", kind: "media", assetId: "asset-x", audioAssetId: "asset-a" },
        { id: "x", name: "X", kind: "media", assetId: "asset-x", audioUrl: "https://example.test/a.mp3" },
        { id: "x", name: "X", kind: "media", assetId: "asset-x", configRef: "main" },
        { id: "x", name: "X", kind: "media", assetId: "asset-x", url: "https://example.test/v.mp4" },
        { id: "x", name: "X", kind: "image", assetId: "asset-x", audioUrl: "https://example.test/a.mp3" },
        { id: "x", name: "X", kind: "image", assetId: "asset-x", configRef: "main" },
        { id: "x", name: "X", kind: "image", assetId: "asset-x", url: "https://example.test/i.png" },
        { id: "x", name: "X", kind: "audio", assetId: "asset-x" },
        { id: "x", name: "X", kind: "audio", audioAssetId: "asset-a", configRef: "main" },
        { id: "x", name: "X", kind: "audio", audioAssetId: "asset-a", audioUrl: "https://example.test/a.mp3" },
        { id: "x", name: "X", kind: "audio", audioUrl: "https://example.test/a.mp3", stillAssetId: "asset-i" },
        { id: "x", name: "X", kind: "audio", audioUrl: "https://example.test/a.mp3", motionUrl: "https://example.test/m.mp4" },
        { id: "x", name: "X", kind: "unknown", url: "https://example.test/x" },
        { id: "x", name: "X", kind: "media", assetId: "asset-x", surprise: true }
    ];
    invalid.forEach((source) => assert.equal(stateWith({ sources: [source] }), null,
        `expected rejection for ${JSON.stringify(source)}`));
});

test("dominant LIVE accepts null or HLS only and permits configured disabled LIVE", () => {
    assert.ok(stateWith({ dominantLive: { armed: false, authorizedSourceId: null } }));
    const kinds = [
        { id: "media-x", name: "Media", kind: "media", assetId: "asset-x" },
        { id: "image-x", name: "Image", kind: "image", assetId: "asset-x" },
        { id: "audio-x", name: "Audio", kind: "audio", audioAssetId: "asset-x" }
    ];
    for (const source of kinds) assert.equal(stateWith({ sources: [source],
        dominantLive: { armed: true, authorizedSourceId: source.id } }), null);
    assert.equal(stateWith({ dominantLive: { armed: true,
        authorizedSourceId: "missing-live" } }), null);
    const disabled = { id: "live-disabled", name: "Live", kind: "hls",
        configRef: "local-main", enabled: false };
    assert.ok(stateWith({ sources: [disabled], dominantLive: { armed: true,
        authorizedSourceId: disabled.id } }));
});

test("repository reports missing, restores valid state, and preserves corrupt files", async () => {
    await withRoot(async ({ root, path }) => {
        const repository = makeRepository(path);
        const missing = await repository.initialize();
        assert.equal(repository.getStatus().status, "UNINITIALIZED");
        assert.equal(missing.initialized, false);
        await repository.commit(createInitializedState(initialDomains(),
            { stateId: missing.stateId, updatedAt: NOW, revision: 1 }));
        const restored = makeRepository(path);
        assert.equal((await restored.initialize()).revision, 1);
        assert.equal(restored.getStatus().status, "VALID");

        await writeFile(path, "{broken", "utf8");
        const corrupt = makeRepository(path);
        assert.equal(await corrupt.initialize(), null);
        assert.equal(corrupt.getStatus().status, "CORRUPT");
        await assert.rejects(() => corrupt.commit(restored.getSnapshot()),
            { code: "STATE_UNAVAILABLE" });
        assert.equal(await readFile(path, "utf8"), "{broken");
    });
});

test("invalid on-disk schema fails closed", async () => {
    await withRoot(async ({ path }) => {
        await writeFile(path, JSON.stringify({ schemaVersion: 99 }), "utf8");
        const repository = makeRepository(path);
        assert.equal(await repository.initialize(), null);
        assert.deepEqual(repository.getStatus(),
            { status: "CORRUPT", initialized: false, revision: null });
    });
});

test("coordinator serializes initialization and advances revision only after persistence", async () => {
    await withRoot(async ({ path }) => {
        const repository = makeRepository(path);
        const coordinator = new StudioStateCoordinator({ repository,
            clock: () => new Date(NOW) });
        await coordinator.initialize();
        const events = []; coordinator.subscribe((event) => events.push(event));
        const state = await coordinator.initializeState(initialDomains());
        assert.equal(state.revision, 1);
        assert.deepEqual(events[0].changedDomains,
            ["sources", "scenes", "scheduler", "globalOverlays", "dominantLive"]);
        await assert.rejects(() => coordinator.initializeState(initialDomains()),
            { code: "STATE_ALREADY_INITIALIZED" });
        assert.equal(coordinator.getSnapshot().revision, 1);
    });
});

test("write and rename failures leave revision uncommitted", async () => {
    for (const operation of ["writeFile", "rename"]) {
        const root = await mkdtemp(join(tmpdir(), "livezone-state-failure-"));
        const path = join(root, "state.json");
        const repository = makeRepository(path, { [operation]: async () => {
            const error = new Error("simulated"); error.code = "EIO"; throw error;
        } });
        const coordinator = new StudioStateCoordinator({ repository,
            clock: () => new Date(NOW) });
        try {
            await coordinator.initialize();
            await assert.rejects(() => coordinator.initializeState(initialDomains()),
                { code: "STATE_PERSISTENCE_FAILED" });
            assert.equal(coordinator.getSnapshot().revision, 0);
            assert.equal(coordinator.getSnapshot().initialized, false);
        }
        finally { await rm(root, { recursive: true, force: true }); }
    }
});

test("rename failure preserves an existing committed file and snapshot", async () => {
    await withRoot(async ({ path }) => {
        const original = makeRepository(path);
        const missing = await original.initialize();
        const revisionOne = createInitializedState(initialDomains(),
            { stateId: missing.stateId, updatedAt: NOW, revision: 1 });
        await original.commit(revisionOne);
        const before = await readFile(path, "utf8");
        const failing = makeRepository(path, { rename: async () => {
            const error = new Error("simulated"); error.code = "EIO"; throw error;
        } });
        await failing.initialize();
        const revisionTwo = createInitializedState(initialDomains(),
            { stateId: missing.stateId, updatedAt: "2026-09-04T10:01:00.000Z", revision: 2 });
        await assert.rejects(() => failing.commit(revisionTwo),
            { code: "STATE_PERSISTENCE_FAILED" });
        assert.equal(failing.getSnapshot().revision, 1);
        assert.equal(await readFile(path, "utf8"), before);
    });
});

test("subscriber failure cannot reject a committed initialization or skip peers", async () => {
    await withRoot(async ({ path }) => {
        const repository = makeRepository(path);
        const coordinator = new StudioStateCoordinator({ repository,
            clock: () => new Date(NOW) });
        await coordinator.initialize();
        let notified = 0;
        coordinator.subscribe(() => { throw new Error("listener failure"); });
        coordinator.subscribe(() => { notified += 1; });
        assert.equal((await coordinator.initializeState(initialDomains())).revision, 1);
        assert.equal(notified, 1);
    });
});

test("state API enforces operator boundary, initializes once, reports ETag and readiness", async () => {
    await withServer(async ({ base }) => {
        assert.equal((await fetch(`${base}/api/studio/state`)).status, 401);
        assert.equal((await fetch(`${base}/api/studio/state/events`)).status, 401);
        assert.equal((await fetch(`${base}/api/studio/state/initialize`,
            { method: "POST" })).status, 401);
        assert.equal((await fetch(`${base}/api/studio/state`, { headers: {
            Authorization: `Bearer ${TOKEN}` } })).status, 401);
        assert.equal((await fetch(`${base}/api/studio/state/initialize`, { method: "POST",
            headers: { Authorization: `Bearer ${TOKEN}` } })).status, 401);

        const session = await login(base);
        let response = await fetch(`${base}/api/studio/state`,
            { headers: { Cookie: session.cookie } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("etag"), '"studio-0"');
        assert.equal((await response.json()).state.initialized, false);

        const target = `${base}/api/studio/state/initialize`;
        assert.equal((await fetch(target, { method: "POST", headers: {
            Cookie: session.cookie, Origin: base,
            "X-Livezone-Operator-Request": "1", "Content-Type": "application/json"
        }, body: JSON.stringify(initialDomains()) })).status, 403);
        assert.equal((await fetch(target, { method: "POST", headers: {
            Cookie: session.cookie, Origin: base, "X-Livezone-Operator-Request": "1",
            "X-Livezone-CSRF": "invalid", "Content-Type": "application/json"
        }, body: JSON.stringify(initialDomains()) })).status, 403);
        assert.equal((await fetch(target, { method: "POST", headers: {
            Cookie: session.cookie, Origin: "https://attacker.example",
            "X-Livezone-Operator-Request": "1", "X-Livezone-CSRF": session.csrf,
            "Content-Type": "application/json"
        }, body: JSON.stringify(initialDomains()) })).status, 403);

        response = await fetch(target, { method: "POST", headers: mutationHeaders(base, session),
            body: JSON.stringify(initialDomains()) });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get("etag"), '"studio-1"');
        assert.equal((await response.json()).state.revision, 1);
        assert.equal((await fetch(target, { method: "POST", headers: mutationHeaders(base, session),
            body: JSON.stringify(initialDomains()) })).status, 409);

        response = await fetch(`${base}/readyz`);
        const readiness = await response.json();
        assert.equal(response.status, 200);
        assert.equal(readiness.checks.studioState, "valid");
    });
});

test("authenticated SSE emits only minimal current metadata", async () => {
    await withServer(async ({ base }) => {
        const session = await login(base);
        const controller = new AbortController();
        const response = await fetch(`${base}/api/studio/state/events`,
            { headers: { Cookie: session.cookie }, signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        controller.abort();
        assert.match(text, /event: studio-state/);
        assert.match(text, /"revision":0/);
        assert.doesNotMatch(text, /sources|scheduler|csrf|publisher/i);
    });
});

test("successful initialization emits a newer minimal SSE revision", async () => {
    await withServer(async ({ base }) => {
        const session = await login(base);
        const controller = new AbortController();
        const response = await fetch(`${base}/api/studio/state/events`,
            { headers: { Cookie: session.cookie }, signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        const initialized = await fetch(`${base}/api/studio/state/initialize`, {
            method: "POST", headers: mutationHeaders(base, session),
            body: JSON.stringify(initialDomains()) });
        assert.equal(initialized.status, 201);
        const { value } = await reader.read();
        controller.abort();
        const text = new TextDecoder().decode(value);
        assert.match(text, /"type":"initialized"/);
        assert.match(text, /"revision":1/);
        assert.doesNotMatch(text, /asset-video|correct horse|publisher-token/);
    });
});

test("corrupt Studio state is sanitized in health and readiness", async () => {
    const corrupt = "{private-path:C:/secret/operator-password";
    await withServer(async ({ base }) => {
        let response = await fetch(`${base}/healthz`);
        assert.deepEqual(await response.json(),
            { ok: true, service: "livezone", status: "alive" });
        response = await fetch(`${base}/readyz`);
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(text).checks.studioState, "corrupt");
        assert.equal(text.includes(corrupt), false);
        assert.doesNotMatch(text, /C:\/secret|operator-password|stack/i);
    }, { stateContent: corrupt });
});

test("mixed-case aliases are not routes and encoded paths retain authorization", async () => {
    await withServer(async ({ base }) => {
        for (const path of ["/API/STUDIO/STATE", "/api/Studio/state", "/api/studio/STATE"]) {
            assert.equal((await fetch(`${base}${path}`)).status, 404);
        }
        assert.equal((await fetch(`${base}/api/studio/state/INITIALIZE`,
            { method: "POST" })).status, 401);
        assert.equal((await fetch(`${base}/api/%73tudio/state`)).status, 401);
        assert.equal((await fetch(`${base}/api/studio/%2fstate`)).status, 400);
        const session = await login(base);
        assert.equal((await fetch(`${base}/api/studio/state/INITIALIZE`, { method: "POST",
            headers: mutationHeaders(base, session), body: JSON.stringify(initialDomains()) })).status, 404);
        assert.equal((await fetch(`${base}/api/%73tudio/state`,
            { headers: { Cookie: session.cookie } })).status, 200);
    });
});

test("configured Studio state path beneath public root is rejected", () => {
    assert.throws(() => createProgramOutputServer({ publisherToken: TOKEN,
        studioStatePath: join(process.cwd(), "public", "private-state.json") }),
    /outside the public web root/);
});

function initialDomains() {
    return { sources: [{ id: "source-video", name: "Video", kind: "media",
        assetId: "asset-video" }], scenes: [{ id: "scene-video", name: "Scene",
        type: "VIDEO", renderer: { kind: "source", sourceId: "source-video" } }],
    scheduler: { version: 1, timezone: "Europe/Rome", items: [], enabled: false },
    globalOverlays: { textCrawl: null },
    dominantLive: { armed: false, authorizedSourceId: null } };
}

function stateWith(overrides = {}) {
    const domains = { sources: [], scenes: [],
        scheduler: { version: 1, timezone: "Europe/Rome", items: [], enabled: false },
        globalOverlays: { textCrawl: null },
        dominantLive: { armed: false, authorizedSourceId: null }, ...overrides };
    return createInitializedState(domains, { stateId: ID, updatedAt: NOW, revision: 1 });
}

function makeRepository(path, fileOperations) {
    return new AuthoritativeStateRepository({ path, clock: () => new Date(NOW),
        uuid: () => ID, fileOperations });
}

async function withRoot(operation) {
    const root = await mkdtemp(join(tmpdir(), "livezone-authoritative-state-"));
    const path = join(root, "state.json");
    try { return await operation({ root, path }); }
    finally { await rm(root, { recursive: true, force: true }); }
}

async function withServer(operation, { stateContent } = {}) {
    const root = await mkdtemp(join(tmpdir(), "livezone-state-server-"));
    const statePath = join(root, "studio-state.json");
    if (stateContent !== undefined) await writeFile(statePath, stateContent, "utf8");
    const mediaAssetRepository = new MediaAssetRepository({ root: join(root, "media") });
    await mediaAssetRepository.initialize();
    const operatorAuth = new OperatorAuth({ username: "operator",
        password: "correct horse battery staple", secureCookie: false });
    const readiness = { evaluate: async () => ({ ok: true, service: "livezone",
        status: "ready", checks: { mediaLibrary: "ok", programOutput: "ok",
            mediaIngestControl: "ok" } }) };
    const { server } = createProgramOutputServer({ publisherToken: TOKEN,
        mediaAssetRepository, operatorAuth, studioStatePath: statePath, readiness });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { return await operation({ base, statePath }); }
    finally { await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true }); }
}

async function login(base) {
    const response = await fetch(`${base}/api/operator/login`, { method: "POST", headers: {
        Origin: base, "Content-Type": "application/json", "X-Livezone-Operator-Request": "1"
    }, body: JSON.stringify({ username: "operator",
        password: "correct horse battery staple", returnTo: "/control/" }) });
    assert.equal(response.status, 200); const payload = await response.json();
    return { cookie: response.headers.get("set-cookie").split(";", 1)[0],
        csrf: payload.csrfToken };
}

function mutationHeaders(base, session) { return { Cookie: session.cookie, Origin: base,
    "X-Livezone-Operator-Request": "1", "X-Livezone-CSRF": session.csrf,
    "Content-Type": "application/json" }; }
