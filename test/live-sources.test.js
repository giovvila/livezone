import test from "node:test";
import assert from "node:assert/strict";
import LiveSourceMonitor from "../public/js/studio/LiveSourceMonitor.js";
import StudioCatalogManager from "../public/js/studio/StudioCatalogManager.js";
import { readFile } from "node:fs/promises";

test("monitor publishes deterministic checking and online snapshots", () => {
    let handlers;
    const monitor = new LiveSourceMonitor({ consumerFactory: (_source, next) => {
        handlers = next; return { start() {}, destroy() {} };
    }, clock: () => 1000, setTimer: () => 1, clearTimer() {} });
    monitor.selectSource({ id: "live-a", kind: "hls", url: "https://example.test/a.m3u8", enabled: true });
    assert.equal(monitor.getSnapshot().state, "CHECKING");
    handlers.online({ width: 1920, height: 1080 });
    assert.deepEqual({ state: monitor.getSnapshot().state, width: monitor.getSnapshot().width,
        height: monitor.getSnapshot().height }, { state: "ONLINE", width: 1920, height: 1080 });
    assert.equal(monitor.getSnapshot().lastOnlineAt, new Date(1000).toISOString());
});

test("switch destroys exactly one old consumer and rejects late events", () => {
    const sessions = []; let destroys = 0;
    const monitor = new LiveSourceMonitor({ consumerFactory: (source, handlers) => {
        sessions.push({ source, handlers }); return { start() {}, destroy() { destroys += 1; } };
    }, setTimer: () => 1, clearTimer() {} });
    monitor.selectSource({ id: "live-a", kind: "hls", url: "https://example.test/a.m3u8", enabled: true });
    monitor.selectSource({ id: "live-b", kind: "hls", url: "https://example.test/b.m3u8", enabled: true });
    assert.equal(destroys, 1);
    sessions[0].handlers.online();
    assert.equal(monitor.getSnapshot().sourceId, "live-b");
    assert.equal(monitor.getSnapshot().state, "CHECKING");
});

test("readiness timeout maps a valid contribution to OFFLINE", () => {
    let timeout;
    const monitor = new LiveSourceMonitor({ consumerFactory: () => ({ start() {}, destroy() {} }),
        setTimer: (callback) => { timeout = callback; return 1; }, clearTimer() {} });
    monitor.selectSource({ id: "live-a", kind: "hls", url: "https://example.test/a.m3u8", enabled: true });
    timeout();
    assert.equal(monitor.getSnapshot().state, "OFFLINE");
});

test("invalid or disabled selections are configuration errors and stop is IDLE", () => {
    const monitor = new LiveSourceMonitor({ consumerFactory: () => { throw new Error("must not run"); } });
    monitor.selectSource({ id: "live-a", kind: "hls", url: "https://example.test/a.m3u8", enabled: false });
    assert.equal(monitor.getSnapshot().errorCategory, "CONFIGURATION");
    monitor.stop();
    assert.equal(monitor.getSnapshot().state, "IDLE");
});

test("browser timer functions are invoked without the monitor as receiver", () => {
    let cleared = false;
    function strictClearTimer() {
        assert.equal(this, undefined);
        cleared = true;
    }
    const monitor = new LiveSourceMonitor({ consumerFactory: () => ({
        start() {}, destroy() {}
    }), setTimer: () => 7, clearTimer: strictClearTimer });
    monitor.selectSource({ id: "live-a", kind: "hls",
        url: "https://example.test/a.m3u8", enabled: true });
    monitor.stop();
    assert.equal(cleared, true);
});

function createCatalog() {
    const values = new Map();
    const runtimeSources = new Map();
    const runtimeScenes = new Map();
    const storage = { getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, value) };
    const sourceManager = {
        registerSource(source) { if (runtimeSources.has(source.id)) return null;
            runtimeSources.set(source.id, source); return source; },
        replaceSource(source) { if (!runtimeSources.has(source.id)) return null;
            runtimeSources.set(source.id, source); return source; },
        unregisterSource(id) { const value = runtimeSources.get(id);
            if (!value) return null; runtimeSources.delete(id); return value; },
        getSource(id) { return runtimeSources.get(id) || null; }, getActiveInstances() { return []; }
    };
    const stateManager = {
        registerScene(scene) { if (runtimeScenes.has(scene.id)) return null;
            runtimeScenes.set(scene.id, scene); return scene; },
        unregisterScene(id) { const value = runtimeScenes.get(id);
            if (!value) return null; runtimeScenes.delete(id); return value; },
        getScene(id) { return runtimeScenes.get(id) || null; },
        getPreviewSceneId() { return null; }, getProgramSceneId() { return null; }
    };
    const catalog = new StudioCatalogManager({ studioStateManager: stateManager,
        studioSourceManager: sourceManager, storage, eventTarget: null,
        uuidFactory: () => "12345678-1234-4234-8234-123456789abc" });
    catalog.initialize();
    return { catalog, values, runtimeSources, runtimeScenes };
}

test("catalog creates stable LIVE source/scene IDs and edits in place", () => {
    const { catalog } = createCatalog();
    const added = catalog.addLiveSource({ name: "MAIN", url: "https://example.test/main.m3u8", enabled: true });
    assert.equal(added.ok, true);
    const edited = catalog.updateLiveSource(added.source.id,
        { name: "MAIN HD", url: "https://example.test/main-hd.m3u8", enabled: true });
    assert.equal(edited.ok, true);
    assert.equal(edited.source.id, added.source.id);
    assert.equal(edited.scene.id, added.scene.id);
});

test("disabled LIVE remains configured but is removed from operational definitions", () => {
    const { catalog, runtimeScenes } = createCatalog();
    const added = catalog.addLiveSource({ name: "BACKUP", url: "https://example.test/b.m3u8", enabled: true });
    catalog.updateLiveSource(added.source.id,
        { name: "BACKUP", url: "https://example.test/b.m3u8", enabled: false });
    assert.equal(catalog.getSources().find(({ id }) => id === added.source.id).enabled, false);
    assert.equal(catalog.getDefinition(added.scene.id), null);
    assert.equal(runtimeScenes.has(added.scene.id), false);
});

test("LIVE validation rejects unsafe protocols and removal requires disabled", () => {
    const { catalog } = createCatalog();
    assert.equal(catalog.addLiveSource({ name: "X", url: "javascript:alert(1)" }).reason, "invalid-url");
    const added = catalog.addLiveSource({ name: "X", url: "https://example.test/x.m3u8", enabled: true });
    assert.equal(catalog.removeSource(added.source.id).reason, "live-source-must-be-disabled");
});

test("monitor core has no Program, Preview, scheduler or StateManager dependency", async () => {
    const source = await readFile(new URL("../public/js/studio/LiveSourceMonitor.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /StudioProgramCommand|StudioTransitionCoordinator|StudioStateManager|SchedulerEngine|ProgramOutputManager/);
});
