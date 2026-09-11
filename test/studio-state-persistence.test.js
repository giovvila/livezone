import test from "node:test";
import assert from "node:assert/strict";
import { StudioStateManager } from
    "../public/js/core/StudioStateManager.js";

const KEY = "livezone.studio.selection.v1";

function createStorage(seed = null) {
    const values = new Map(seed ? [[KEY, seed]] : []);
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        value: () => values.get(KEY) ?? null
    };
}

function register(manager, ...ids) {
    ids.forEach((id) => manager.registerScene({ id, name: id, type: "source" }));
}

test("Preview and Program survive a Control to Scheduler to Control navigation", () => {
    const storage = createStorage();
    const firstControl = new StudioStateManager({ storage, eventTarget: null });
    firstControl.initialize();
    register(firstControl, "scene-a", "scene-b");
    firstControl.setPreviewScene("scene-a", { source: "operator" });
    firstControl.take({ source: "operator" });
    firstControl.setPreviewScene("scene-b", { source: "operator" });

    const beforeNavigation = storage.value();
    const scheduler = new StudioStateManager({ storage, eventTarget: null });
    scheduler.initialize();
    register(scheduler, "scene-a", "scene-b");
    assert.equal(storage.value(), beforeNavigation,
        "Scheduler bootstrap must not rewrite Control selection");

    const returningControl = new StudioStateManager({ storage, eventTarget: null });
    returningControl.initialize();
    register(returningControl, "scene-a", "scene-b");
    assert.equal(returningControl.getPreviewSceneId(), "scene-b");
    assert.equal(returningControl.getProgramSceneId(), "scene-a");
});

test("selection restores only after matching catalog scenes register", () => {
    const storage = createStorage(JSON.stringify({ version: 1,
        previewSceneId: "scene-b", programSceneId: "scene-a" }));
    const manager = new StudioStateManager({ storage, eventTarget: null });
    manager.initialize();
    assert.equal(manager.getPreviewSceneId(), null);
    assert.equal(manager.getProgramSceneId(), null);
    register(manager, "scene-a");
    assert.equal(manager.getPreviewSceneId(), null);
    assert.equal(manager.getProgramSceneId(), "scene-a");
    register(manager, "scene-b");
    assert.equal(manager.getPreviewSceneId(), "scene-b");
});

test("invalid or stale persisted selections fail closed", () => {
    for (const value of ["not-json", JSON.stringify({ version: 2,
        previewSceneId: "scene-a", programSceneId: null }), JSON.stringify({
        version: 1, previewSceneId: " scene-a ", programSceneId: null })]) {
        const manager = new StudioStateManager({
            storage: createStorage(value), eventTarget: null
        });
        manager.initialize();
        register(manager, "scene-a");
        assert.equal(manager.getPreviewSceneId(), null);
        assert.equal(manager.getProgramSceneId(), null);
    }

    const stale = new StudioStateManager({ storage: createStorage(JSON.stringify({
        version: 1, previewSceneId: "removed", programSceneId: "missing"
    })), eventTarget: null });
    stale.initialize();
    register(stale, "scene-a");
    assert.equal(stale.getPreviewSceneId(), null);
    assert.equal(stale.getProgramSceneId(), null);
});

test("release and TAKE persist their atomic selection result", () => {
    const storage = createStorage();
    const manager = new StudioStateManager({ storage, eventTarget: null });
    manager.initialize();
    register(manager, "scene-a", "scene-b");
    manager.setPreviewScene("scene-a");
    manager.take();
    manager.setPreviewScene("scene-b");
    assert.deepEqual(JSON.parse(storage.value()), { version: 1,
        previewSceneId: "scene-b", programSceneId: "scene-a" });
    manager.releaseProgram();
    assert.deepEqual(JSON.parse(storage.value()), { version: 1,
        previewSceneId: "scene-b", programSceneId: null });
});

test("unavailable storage preserves in-memory behavior", () => {
    const storage = {
        getItem() { throw new Error("blocked"); },
        setItem() { throw new Error("blocked"); }
    };
    const manager = new StudioStateManager({ storage, eventTarget: null });
    manager.initialize();
    register(manager, "scene-a");
    assert.ok(manager.setPreviewScene("scene-a"));
    assert.ok(manager.take());
    assert.equal(manager.getProgramSceneId(), "scene-a");
});
