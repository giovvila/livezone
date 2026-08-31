import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import StudioCatalogManager from "../public/js/studio/StudioCatalogManager.js";
import StudioAudioSurface from "../public/js/studio/renderers/StudioAudioSurface.js";
import StudioSourceManager from "../public/js/studio/StudioSourceManager.js";
import StudioOperationalSourcesUI from "../public/js/ui/StudioOperationalSourcesUI.js";
import StudioUI from "../public/js/ui/StudioUI.js";
import StudioAssetResolver from "../public/js/studio/StudioAssetResolver.js";
import createStudioRemovalGuard from "../public/js/studio/StudioRemovalGuard.js";

const KEY = "livezone.studio.mediaCatalog.overlay.v1";

function harness(seed = null, assetResolver = null) {
    const values = new Map(seed ? [[KEY, seed]] : []);
    const sources = new Map();
    const scenes = new Map();
    let activeInstances = [];
    let serial = 0;
    const sourceManager = {
        registerSource(value) { if (sources.has(value.id)) return null; sources.set(value.id, value); return value; },
        replaceSource(value) { if (!sources.has(value.id)) return null;
            const matching = activeInstances.filter((item) => item.sourceId === value.id);
            if (matching.some((item) => typeof item.updateSourceDefinition !== "function" ||
                item.updateSourceDefinition(value) !== true)) return null;
            sources.set(value.id, value); return value; },
        unregisterSource(id) { const value = sources.get(id); if (!value) return null; sources.delete(id); return value; },
        getSource(id) { return sources.get(id) || null; },
        getActiveInstances() { return activeInstances; }
    };
    let previewSceneId = null;
    let programSceneId = null;
    const stateManager = {
        registerScene(value) { if (scenes.has(value.id)) return null; scenes.set(value.id, value); return value; },
        replaceScene(value) { if (!scenes.has(value.id)) return null; scenes.set(value.id, value); return value; },
        unregisterScene(id) { const value = scenes.get(id); if (!value) return null; scenes.delete(id); return value; },
        getScene(id) { return scenes.get(id) || null; },
        getPreviewSceneId() { return previewSceneId; }, getProgramSceneId() { return programSceneId; }
    };
    const catalog = new StudioCatalogManager({ studioStateManager: stateManager,
        studioSourceManager: sourceManager, eventTarget: null, assetResolver,
        storage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
        baseUrl: "https://studio.test/control/", uuidFactory: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}` });
    return { catalog, values, sources, scenes,
        setPreview: (id) => { previewSceneId = id; },
        setProgram: (id) => { programSceneId = id; },
        setActiveSource: (id, updateSourceDefinition = null) => { activeInstances = id
            ? [{ sourceId: id, ...(updateSourceDefinition ? { updateSourceDefinition } : {}) }]
            : []; } };
}

test("managed asset resolver validates kinds and rejects legacy collisions", () => {
    const legacy = { getAsset: (id) => id === "asset-shared"
        ? { id, name: "Legacy", kind: "video", url: "/legacy.mp4" } : null };
    const managed = { getAsset: (id) => ({
        "asset-video": { id, originalName: "clip.mp4", kind: "video", url: "/media-library/files/video/a.mp4" },
        "asset-image": { id, originalName: "still.png", kind: "image", url: "/media-library/files/image/a.png" },
        "asset-shared": { id, originalName: "managed.mp4", kind: "video", url: "/managed.mp4" }
    })[id] || null };
    const previousDocument = globalThis.document;
    globalThis.document = { baseURI: "https://studio.test/control/" };
    try {
        const resolver = new StudioAssetResolver({ legacyLibrary: legacy, mediaLibraryManager: managed });
        assert.equal(resolver.resolve("asset-video", { expectedKind: "video" }).asset.origin, "managed");
        assert.equal(resolver.resolve("asset-image", { expectedKind: "image" }).ok, true);
        assert.equal(resolver.resolve("asset-image", { expectedKind: "audio" }).reason, "asset-kind-mismatch");
        assert.equal(resolver.resolve("missing").reason, "asset-not-found");
        assert.equal(resolver.resolve("asset-shared").reason, "asset-id-ambiguous");
    } finally { globalThis.document = previousDocument; }
});

test("scene removal guard distinguishes live, scheduler and runtime references without null collision", () => {
    let authorizedSourceId = null;
    let scheduledSceneIds = [];
    let runtimeSceneIds = [];
    let busy = false;
    const guard = createStudioRemovalGuard({
        dominantLiveConfig: { getSnapshot: () => ({ authorizedSourceId }) },
        transitionCoordinator: { isBusy: () => busy },
        studioRenderer: { isSceneInUse: (id) => runtimeSceneIds.includes(id) },
        scheduleStore: { getSnapshot: () => ({ schedule: { items:
            scheduledSceneIds.map((sceneId) => ({ sceneId })) } }) }
    });
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), null);
    runtimeSceneIds = ["S1"];
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), "active-runtime-reference");
    runtimeSceneIds = [];
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), null);
    scheduledSceneIds = ["S1"];
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), "scheduler-reference");
    scheduledSceneIds = [];
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), null);
    busy = true;
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), "active-runtime-reference");
    busy = false;
    authorizedSourceId = "S1";
    assert.equal(guard({ sourceId: null, sceneId: "S1" }), null,
        "sceneId must never be compared with authorizedSourceId");
    assert.equal(guard({ sourceId: "S1", sceneId: null }), "source-authorized");
    assert.equal(guard({ sourceId: "different", sceneId: "S1" }), null);
});

test("scene deletion becomes available after Preview and Program references move", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "image", name: "Still", url: "/still.png" }).source;
    const scene = h.catalog.createSceneForSource(source.id, { name: "Scene" }).scene;
    h.setPreview(scene.id);
    assert.equal(h.catalog.removeScene(scene.id).reason, "scene-in-preview");
    h.setPreview("other");
    h.setProgram(scene.id);
    assert.equal(h.catalog.removeScene(scene.id).reason, "scene-in-program");
    h.setProgram("other");
    assert.equal(h.catalog.removeScene(scene.id).ok, true);
});

test("scene deletion becomes available after Scheduler reference is removed", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "image", name: "Still", url: "/still.png" }).source;
    const scene = h.catalog.createSceneForSource(source.id, { name: "Scene" }).scene;
    let items = [{ sceneId: scene.id }];
    h.catalog.setRemovalGuard(createStudioRemovalGuard({
        dominantLiveConfig: { getSnapshot: () => ({ authorizedSourceId: null }) },
        transitionCoordinator: { isBusy: () => false },
        studioRenderer: { isSceneInUse: () => false },
        scheduleStore: { getSnapshot: () => ({ schedule: { items } }) }
    }));
    assert.equal(h.catalog.removeScene(scene.id).reason, "scheduler-reference");
    items = [];
    assert.equal(h.catalog.removeScene(scene.id).ok, true);
});

test("schema v3 persists managed VIDEO IMAGE and AUDIO references without scenes", () => {
    const assets = new Map([
        ["v", { id: "v", kind: "video", url: "https://studio.test/v.mp4" }],
        ["i", { id: "i", kind: "image", url: "https://studio.test/i.png" }],
        ["a", { id: "a", kind: "audio", url: "https://studio.test/a.mp3" }]
    ]);
    const resolver = { resolve(id, { expectedKind }) { const asset = assets.get(id);
        return asset && asset.kind === expectedKind ? { ok: true, asset }
            : { ok: false, reason: asset ? "asset-kind-mismatch" : "asset-not-found" }; } };
    const h = harness(null, resolver); h.catalog.initialize();
    assert.equal(h.catalog.addSource({ kind: "video", name: "V", assetId: "v" }).ok, true);
    assert.equal(h.catalog.addSource({ kind: "image", name: "I", assetId: "i" }).ok, true);
    assert.equal(h.catalog.addSource({ kind: "audio", name: "A", audioAssetId: "a" }).ok, true);
    const stored = JSON.parse(h.values.get(KEY));
    assert.equal(stored.version, 3);
    assert.equal(stored.scenes.length, 0);
    assert.deepEqual(stored.sources.map(({ kind, assetId, audioAssetId, stillAssetId }) =>
        ({ kind, assetId, audioAssetId, stillAssetId })), [
        { kind: "media", assetId: "v", audioAssetId: undefined, stillAssetId: undefined },
        { kind: "image", assetId: "i", audioAssetId: undefined, stillAssetId: undefined },
        { kind: "audio", assetId: undefined, audioAssetId: "a", stillAssetId: undefined }
    ]);
});

test("missing authoritative asset remains visible and blocks runtime definition", () => {
    const seed = JSON.stringify({ version: 3, sources: [
        { id: "video-00000000-0000-4000-8000-000000000001", name: "Missing", kind: "media", assetId: "gone" }
    ], scenes: [], sourceOverrides: [], sceneOverrides: [],
    deletedBootstrapSourceIds: [], deletedBootstrapSceneIds: [] });
    const resolver = { resolve: () => ({ ok: false, reason: "asset-not-found" }) };
    const h = harness(seed, resolver); h.catalog.initialize();
    const source = h.catalog.getSources()[0];
    assert.equal(source.available, false);
    assert.equal(source.unavailableReason, "asset-not-found");
    assert.equal(h.sources.size, 0);
});

test("asset reference inspection returns source names and matching fields", () => {
    const asset = { id: "a", kind: "audio", url: "https://studio.test/a.mp3" };
    const image = { id: "i", kind: "image", url: "https://studio.test/i.png" };
    const resolver = { resolve(id) { return { ok: true, asset: id === "a" ? asset : image }; } };
    const h = harness(null, resolver); h.catalog.initialize();
    h.catalog.addSource({ kind: "audio", name: "Radio", audioAssetId: "a", stillAssetId: "i" });
    assert.deepEqual(h.catalog.getAssetReferences("i").map((item) =>
        ({ sourceName: item.sourceName, fields: [...item.fields] })),
    [{ sourceName: "Radio", fields: ["stillAssetId"] }]);
});

test("active AUDIO source propagates artwork replacement and clear without changing scene", () => {
    const assets = new Map([
        ["A1", { id: "A1", kind: "audio", url: "https://studio.test/audio.mp3" }],
        ["I1", { id: "I1", kind: "image", url: "https://studio.test/old.png" }],
        ["I2", { id: "I2", kind: "image", url: "https://studio.test/new.png" }]
    ]);
    const resolver = { resolve(id, { expectedKind }) { const asset = assets.get(id);
        return asset && asset.kind === expectedKind ? { ok: true, asset }
            : { ok: false, reason: "asset-kind-mismatch" }; } };
    const h = harness(null, resolver); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "audio", name: "Show",
        audioAssetId: "A1", stillAssetId: "I1" }).source;
    const scene = h.catalog.createSceneForSource(source.id, { name: "Show scene" }).scene;
    const propagated = [];
    h.setActiveSource(source.id, (definition) => { propagated.push(definition); return true; });
    const changed = h.catalog.updateSource(source.id, { name: "Show",
        audioAssetId: "A1", stillAssetId: "I2" });
    assert.equal(changed.ok, true);
    assert.equal(changed.source.id, source.id);
    assert.match(h.sources.get(source.id).stillUrl, /new\.png$/);
    assert.equal(h.scenes.get(scene.id).renderer.sourceId, source.id);
    assert.match(propagated.at(-1).stillUrl, /new\.png$/);
    const storedAfterChange = JSON.parse(h.values.get(KEY)).sources.find(
        (item) => item.id === source.id);
    assert.equal(storedAfterChange.audioAssetId, "A1");
    assert.equal(storedAfterChange.stillAssetId, "I2");
    const reloaded = harness(h.values.get(KEY), resolver);
    reloaded.catalog.initialize();
    const reloadedSource = reloaded.catalog.getSources().find((item) => item.id === source.id);
    assert.equal(reloadedSource.audioAssetId, "A1");
    assert.equal(reloadedSource.stillAssetId, "I2");
    const manager = { getAsset: (id) => ({ id, originalName: `${id}.asset` }) };
    const ui = new StudioOperationalSourcesUI(null, null, { mediaLibraryManager: manager });
    ui.selectedAssets = ui.createSelectedAssets(reloadedSource);
    assert.equal(ui.selectedAssets.primary.id, "A1");
    assert.equal(ui.selectedAssets.artwork.id, "I2");
    const editPayload = ui.applyManagedSelections({ kind: "audio", name: "Show" });
    assert.equal(editPayload.audioAssetId, "A1");
    assert.equal(editPayload.stillAssetId, "I2");
    const cleared = h.catalog.updateSource(source.id, { name: "Show",
        audioAssetId: "A1" });
    assert.equal(cleared.ok, true);
    assert.equal(h.sources.get(source.id).stillUrl, undefined);
    assert.equal(propagated.at(-1).stillUrl, undefined);
    assert.equal(h.scenes.get(scene.id).renderer.sourceId, source.id);
    const storedAfterClear = JSON.parse(h.values.get(KEY)).sources.find(
        (item) => item.id === source.id);
    assert.equal(Object.hasOwn(storedAfterClear, "stillAssetId"), false);
    const clearedReload = harness(h.values.get(KEY), resolver);
    clearedReload.catalog.initialize();
    const clearedSource = clearedReload.catalog.getSources().find((item) => item.id === source.id);
    const clearedSelections = ui.createSelectedAssets(clearedSource);
    assert.equal(clearedSelections.primary.id, "A1");
    assert.equal(clearedSelections.artwork, null);
});

test("AUDIO motion artwork persists, resolves, references and clears on the same source", () => {
    const assets = new Map([
        ["A1", { id: "A1", kind: "audio", url: "https://studio.test/audio.mp3" }],
        ["I1", { id: "I1", kind: "image", url: "https://studio.test/still.png" }],
        ["M1", { id: "M1", kind: "video", url: "https://studio.test/motion.mp4" }]
    ]);
    const resolver = { resolve(id, { expectedKind }) { const asset = assets.get(id);
        return asset?.kind === expectedKind ? { ok: true, asset }
            : { ok: false, reason: asset ? "asset-kind-mismatch" : "asset-not-found" }; } };
    const first = harness(null, resolver); first.catalog.initialize();
    const source = first.catalog.addSource({ kind: "audio", name: "Motion radio",
        audioAssetId: "A1", stillAssetId: "I1", motionAssetId: "M1" }).source;
    assert.equal(source.motionAssetId, "M1");
    assert.equal(source.motionUrl, "https://studio.test/motion.mp4");
    assert.deepEqual(first.catalog.getAssetReferences("M1")[0].fields,
        Object.freeze(["motionAssetId"]));
    assert.equal(first.catalog.isAssetReferenced("M1"), true);
    const stored = JSON.parse(first.values.get(KEY)).sources[0];
    assert.equal(stored.motionAssetId, "M1");
    assert.equal(Object.hasOwn(stored, "motionUrl"), false);
    const second = harness(first.values.get(KEY), resolver); second.catalog.initialize();
    assert.equal(second.catalog.getSources()[0].motionUrl,
        "https://studio.test/motion.mp4");
    assert.equal(second.catalog.updateSource(source.id, { name: source.name,
        audioAssetId: "A1", stillAssetId: "I1" }).ok, true);
    const cleared = second.catalog.getSources()[0];
    assert.equal(cleared.motionAssetId, null);
    assert.equal(cleared.motionUrl, null);
    assert.equal(cleared.stillAssetId, "I1");
});

test("missing optional AUDIO motion falls back without disabling audio authority", () => {
    const resolver = { resolve(id, { expectedKind }) {
        if (id === "A1" && expectedKind === "audio") return { ok: true,
            asset: { id, kind: "audio", url: "https://studio.test/audio.mp3" } };
        return { ok: false, reason: "asset-not-found" };
    } };
    const seed = JSON.stringify({ version: 3, sources: [{
        id: "audio-00000000-0000-4000-8000-000000000001", name: "Radio",
        kind: "audio", audioAssetId: "A1", motionAssetId: "MISSING"
    }], scenes: [], sourceOverrides: [], sceneOverrides: [],
    deletedBootstrapSourceIds: [], deletedBootstrapSceneIds: [] });
    const h = harness(seed, resolver); h.catalog.initialize();
    const source = h.catalog.getSources()[0];
    assert.equal(source.available, true);
    assert.equal(source.motionUrl, null);
    assert.equal(source.motionUnavailableReason, "asset-not-found");
    assert.equal(h.sources.has(source.id), true);
});

test("AUDIO motion kind mismatch and ID ambiguity remain optional diagnostics", () => {
    const makeSeed = () => JSON.stringify({ version: 3, sources: [{
        id: "audio-00000000-0000-4000-8000-000000000001", name: "Radio",
        kind: "audio", audioAssetId: "A1", motionAssetId: "M1"
    }], scenes: [], sourceOverrides: [], sceneOverrides: [],
    deletedBootstrapSourceIds: [], deletedBootstrapSceneIds: [] });
    for (const reason of ["asset-kind-mismatch", "asset-id-ambiguous"]) {
        const resolver = { resolve(id, { expectedKind }) {
            return id === "A1" && expectedKind === "audio" ? { ok: true,
                asset: { id, kind: "audio", url: "https://studio.test/audio.mp3" } }
                : { ok: false, reason };
        } };
        const h = harness(makeSeed(), resolver); h.catalog.initialize();
        const source = h.catalog.getSources()[0];
        assert.equal(source.available, true);
        assert.equal(source.motionUnavailableReason, reason);
    }
});

test("AUDIO editor keeps motion selection explicit until SAVE", () => {
    const manager = { getAsset: (id) => ({ id, kind: id.startsWith("M") ? "video" :
        id.startsWith("I") ? "image" : "audio", originalName: `${id}.asset` }) };
    const ui = new StudioOperationalSourcesUI(null, null, { mediaLibraryManager: manager });
    ui.selectedAssets = ui.createSelectedAssets({ category: "audio",
        audioAssetId: "A1", stillAssetId: "I1", motionAssetId: "M1" });
    assert.equal(ui.selectedAssets.motion.id, "M1");
    let payload = ui.applyManagedSelections({ kind: "audio", name: "Radio" });
    assert.equal(payload.motionAssetId, "M1");
    ui.selectedAssets.motion = manager.getAsset("M2");
    payload = ui.applyManagedSelections({ kind: "audio", name: "Radio" });
    assert.equal(payload.motionAssetId, "M2");
    ui.selectedAssets.motion = null;
    payload = ui.applyManagedSelections({ kind: "audio", name: "Radio" });
    assert.equal(Object.hasOwn(payload, "motionAssetId"), false);
});

test("AUDIO motion picker and import are VIDEO-only and remain pending until SAVE", async () => {
    const imported = { id: "M2", kind: "video", originalName: "motion.mp4" };
    const manager = { async importAsset() { return imported; } };
    const pickerCalls = [];
    const picker = { async choose(options) { pickerCalls.push(options); return {
        id: "M1", kind: "video", originalName: "library.mp4" }; } };
    const ui = new StudioOperationalSourcesUI(null, null, {
        mediaLibraryManager: manager, mediaLibraryPicker: picker });
    ui.selectedAssets = { primary: { id: "A1", kind: "audio",
        originalName: "audio.mp3" }, artwork: null, motion: null };
    ui.renderSelections = () => {};
    ui.setFeedback = () => {};
    ui.form = { elements: { kind: { value: "audio" } } };
    const library = { dataset: { sourceLibrary: "motion" } };
    await ui.handleFormClick({ target: { closest(selector) {
        return selector === "[data-source-library]" ? library : null;
    } } });
    assert.equal(pickerCalls[0].kind, "video");
    assert.equal(ui.selectedAssets.motion.id, "M1");
    const input = { dataset: { sourceFile: "motion" }, files: [{}], value: "selected",
        closest() { return this; } };
    await ui.handleFileChange({ target: input });
    assert.equal(ui.selectedAssets.motion, imported);
    assert.equal(input.value, "");
    assert.equal(ui.applyManagedSelections({ kind: "audio" }).motionAssetId, "M2");
});

test("EDIT payload preserves managed AUDIO IDs when disabled kind is absent from FormData", () => {
    const ui = new StudioOperationalSourcesUI(null, null);
    ui.selectedAssets = {
        primary: { id: "A1", originalName: "audio.mp3" },
        artwork: { id: "I2", originalName: "new.png" }
    };
    const data = ui.applyManagedSelections({ kind: "audio", name: "Show" });
    assert.deepEqual(data, { kind: "audio", name: "Show",
        audioAssetId: "A1", stillAssetId: "I2" });
    ui.selectedAssets.artwork = null;
    const cleared = ui.applyManagedSelections({ kind: "audio", name: "Show" });
    assert.equal(cleared.audioAssetId, "A1");
    assert.equal(Object.hasOwn(cleared, "stillAssetId"), false);
});

test("real EDIT recovery reconciles prior URL-converted AUDIO before artwork replace", () => {
    const previousDocument = globalThis.document;
    globalThis.document = { baseURI: "https://studio.test/control/" };
    try {
        const assets = [
            { id: "A1", kind: "audio", originalName: "audio.mp3",
                url: "https://studio.test/media-library/files/audio/a.mp3" },
            { id: "I1", kind: "image", originalName: "old.png",
                url: "https://studio.test/media-library/files/image/old.png" },
            { id: "I2", kind: "image", originalName: "new.png",
                url: "https://studio.test/media-library/files/image/new.png" }
        ];
        const manager = { getAsset: (id) => assets.find((asset) => asset.id === id) || null,
            listAssets: ({ kind }) => assets.filter((asset) => asset.kind === kind) };
        const resolver = { resolve(id, { expectedKind }) { const asset = manager.getAsset(id);
            return asset?.kind === expectedKind ? { ok: true, asset }
                : { ok: false, reason: "asset-kind-mismatch" }; } };
        const h = harness(null, resolver); h.catalog.initialize();
        const source = h.catalog.addSource({ kind: "audio", name: "Show",
            url: "/media-library/files/audio/a.mp3",
            stillUrl: "/media-library/files/image/old.png" }).source;
        assert.equal(source.audioAssetId, undefined);
        assert.equal(source.stillAssetId, undefined);
        const ui = new StudioOperationalSourcesUI(null, null,
            { mediaLibraryManager: manager });
        ui.selectedAssets = ui.createSelectedAssets(h.catalog.getSources()[0]);
        assert.equal(ui.selectedAssets.primary.id, "A1");
        assert.equal(ui.selectedAssets.artwork.id, "I1");
        ui.selectedAssets.artwork = manager.getAsset("I2");
        const payload = ui.applyManagedSelections({ kind: "audio", name: "Show" });
        assert.equal(payload.audioAssetId, "A1");
        assert.equal(payload.stillAssetId, "I2");
        assert.equal(h.catalog.updateSource(source.id, payload).ok, true);
        const stored = JSON.parse(h.values.get(KEY)).sources.find(
            (item) => item.id === source.id);
        assert.equal(stored.audioAssetId, "A1");
        assert.equal(stored.stillAssetId, "I2");
        assert.equal(Object.hasOwn(stored, "audioUrl"), false);
        const reloaded = harness(h.values.get(KEY), resolver);
        reloaded.catalog.initialize();
        const restored = reloaded.catalog.getSources()[0];
        assert.equal(restored.audioAssetId, "A1");
        assert.equal(restored.stillAssetId, "I2");
    }
    finally { globalThis.document = previousDocument; }
});

class FakeTarget {
    constructor() {
        this.listeners = new Map();
        this.removed = false;
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener); this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type, target = this) {
        const event = { type, target, preventDefault() {} };
        Array.from(this.listeners.get(type) || [], (listener) => listener(event));
    }
    remove() { this.removed = true; }
}

function uiLifecycleHarness() {
    const list = new FakeTarget();
    list.closest = () => ({});
    list.before = (...items) => { list.inserted = items; };
    const root = { querySelector: () => list };
    const subscriptions = new Set();
    let renders = 0;
    const catalog = {
        subscribe(listener) {
            subscriptions.add(listener); listener([]);
            return () => subscriptions.delete(listener);
        },
        publish() { subscriptions.forEach((listener) => listener([])); }
    };
    class TestUI extends StudioOperationalSourcesUI {
        createCategoryNav() { return new FakeTarget(); }
        createForm() {
            const form = new FakeTarget();
            form.elements = { kind: new FakeTarget() };
            this.cancelButton = new FakeTarget();
            form.querySelector = () => this.cancelButton;
            form.elements.kind.addEventListener("change", this.handleKindChange);
            this.cancelButton.addEventListener("click", this.handleCancelClick);
            return form;
        }
        render() { if (this.started) renders += 1; }
        openEditor() { this.addActions = (this.addActions || 0) + 1; }
        handleCategoryClick() { this.categoryActions = (this.categoryActions || 0) + 1; }
        handleSubmit() { this.submitActions = (this.submitActions || 0) + 1; }
        handleClick() { this.listActions = (this.listActions || 0) + 1; }
        handleKindChange() { this.kindActions = (this.kindActions || 0) + 1; }
        handleCancelClick() { this.cancelActions = (this.cancelActions || 0) + 1; }
    }
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => new FakeTarget() };
    const ui = new TestUI(root, catalog);
    return { ui, catalog, list, subscriptions,
        renders: () => renders,
        restore: () => { globalThis.document = previousDocument; } };
}

function studioUiLifecycleHarness() {
    const sceneList = new FakeTarget();
    sceneList.before = (...items) => { sceneList.inserted = items; };
    const emptyState = new FakeTarget();
    const takeButton = new FakeTarget();
    const transitionSelect = new FakeTarget();
    const controls = { "#studio-scene-list": sceneList,
        "#studio-empty-state": emptyState, "#studio-take": takeButton,
        "#studio-transition-type": transitionSelect };
    const root = { querySelector: (selector) => controls[selector] };
    const catalogSubscriptions = new Set();
    const transitionSubscriptions = new Set();
    let renders = 0;
    const catalog = { subscribe(listener) { catalogSubscriptions.add(listener);
        listener([]); return () => catalogSubscriptions.delete(listener); } };
    const transitionCoordinator = { subscribe(listener) {
        transitionSubscriptions.add(listener);
        return () => transitionSubscriptions.delete(listener);
    }, transition() {} };
    class TestStudioUI extends StudioUI {
        createSceneForm() {
            const button = new FakeTarget();
            const form = new FakeTarget();
            const feedback = new FakeTarget();
            const cancelButton = new FakeTarget();
            form.elements = { name: { focus() {} }, sourceId: {} };
            button.addEventListener("click", this.handleSceneFormOpen);
            cancelButton.addEventListener("click", this.handleSceneFormCancel);
            return { button, form, feedback, cancelButton };
        }
        renderSceneSourceOptions() {}
        renderFromState() { renders += 1; }
        handleSceneCreate() { this.submitActions = (this.submitActions || 0) + 1; }
        handleSceneListClick() { this.sceneActions = (this.sceneActions || 0) + 1; }
    }
    const ui = new TestStudioUI(root, transitionCoordinator, catalog);
    return { ui, sceneList, catalogSubscriptions, transitionSubscriptions,
        renders: () => renders };
}

test("StudioUI destroy removes scene controls, listeners, subscriptions and editing state", () => {
    const h = studioUiLifecycleHarness();
    assert.equal(h.ui.start(), undefined);
    const sceneForm = h.ui.sceneForm;
    h.ui.editingSceneId = "scene-a";
    assert.equal(h.catalogSubscriptions.size, 1);
    assert.equal(h.transitionSubscriptions.size, 1);
    assert.equal(h.ui.destroy(), true);
    assert.equal(h.catalogSubscriptions.size, 0);
    assert.equal(h.transitionSubscriptions.size, 0);
    assert.equal(h.ui.editingSceneId, null);
    for (const node of [sceneForm.button, sceneForm.form, sceneForm.feedback]) {
        assert.equal(node.removed, true);
    }
    for (const target of [sceneForm.button, sceneForm.cancelButton,
        sceneForm.form, h.sceneList]) {
        assert.equal(Array.from(target.listeners.values()).every(
            (listeners) => listeners.size === 0), true);
    }
    assert.equal(h.ui.destroy(), false);
});

test("destroyed StudioUI ignores former controls and state notifications", () => {
    const h = studioUiLifecycleHarness();
    h.ui.start();
    const sceneForm = h.ui.sceneForm;
    const rendered = h.renders();
    h.ui.destroy();
    sceneForm.button.dispatch("click");
    sceneForm.cancelButton.dispatch("click");
    sceneForm.form.dispatch("submit");
    h.sceneList.dispatch("click");
    h.catalogSubscriptions.forEach((listener) => listener([]));
    h.transitionSubscriptions.forEach((listener) => listener());
    assert.equal(h.renders(), rendered);
    assert.equal(h.ui.submitActions || 0, 0);
    assert.equal(h.ui.sceneActions || 0, 0);
});

test("StudioUI repeated destroy and restart keeps one scene-management control set", () => {
    const h = studioUiLifecycleHarness();
    for (let cycle = 0; cycle < 3; cycle += 1) {
        h.ui.start();
        const sceneForm = h.ui.sceneForm;
        assert.equal(h.catalogSubscriptions.size, 1);
        assert.equal(h.transitionSubscriptions.size, 1);
        assert.equal(h.sceneList.inserted.length, 3);
        sceneForm.button.dispatch("click");
        sceneForm.cancelButton.dispatch("click");
        sceneForm.form.dispatch("submit");
        h.sceneList.dispatch("click");
        assert.equal(h.ui.submitActions, cycle + 1);
        assert.equal(h.ui.sceneActions, cycle + 1);
        assert.equal(h.ui.destroy(), true);
        assert.equal(h.catalogSubscriptions.size, 0);
        assert.equal(h.transitionSubscriptions.size, 0);
    }
});

test("StudioOperationalSourcesUI destroy removes subscription and every owned listener", () => {
    const h = uiLifecycleHarness();
    try {
        assert.equal(h.ui.start(), true);
        const controls = { add: h.ui.addButton, category: h.ui.categoryNav,
            form: h.ui.form, kind: h.ui.form.elements.kind,
            cancel: h.ui.cancelButton, list: h.list };
        assert.equal(h.subscriptions.size, 1);
        assert.equal(h.ui.destroy(), true);
        assert.equal(h.subscriptions.size, 0);
        for (const target of Object.values(controls)) {
            assert.equal(Array.from(target.listeners.values()).every(
                (listeners) => listeners.size === 0), true);
        }
        assert.equal(h.ui.destroy(), false);
    }
    finally { h.restore(); }
});

test("destroyed StudioOperationalSourcesUI ignores catalog and former DOM controls", () => {
    const h = uiLifecycleHarness();
    try {
        h.ui.start();
        const controls = { add: h.ui.addButton, category: h.ui.categoryNav,
            form: h.ui.form, kind: h.ui.form.elements.kind,
            cancel: h.ui.cancelButton, list: h.list };
        const rendered = h.renders();
        h.ui.destroy();
        h.catalog.publish();
        controls.add.dispatch("click"); controls.category.dispatch("click");
        controls.form.dispatch("submit"); controls.kind.dispatch("change");
        controls.cancel.dispatch("click"); controls.list.dispatch("click");
        assert.equal(h.renders(), rendered);
        assert.equal(h.ui.addActions || 0, 0);
        assert.equal(h.ui.categoryActions || 0, 0);
        assert.equal(h.ui.submitActions || 0, 0);
        assert.equal(h.ui.kindActions || 0, 0);
        assert.equal(h.ui.cancelActions || 0, 0);
        assert.equal(h.ui.listActions || 0, 0);
    }
    finally { h.restore(); }
});

test("StudioOperationalSourcesUI destroy and restart retains one handler set", () => {
    const h = uiLifecycleHarness();
    try {
        for (let cycle = 0; cycle < 3; cycle += 1) {
            assert.equal(h.ui.start(), true);
            assert.equal(h.ui.start(), false);
            assert.equal(h.subscriptions.size, 1);
            h.ui.addButton.dispatch("click");
            h.ui.categoryNav.dispatch("click");
            h.ui.form.dispatch("submit");
            h.list.dispatch("click");
            assert.equal(h.ui.addActions, cycle + 1);
            assert.equal(h.ui.categoryActions, cycle + 1);
            assert.equal(h.ui.submitActions, cycle + 1);
            assert.equal(h.ui.listActions, cycle + 1);
            assert.equal(h.ui.destroy(), true);
            assert.equal(h.subscriptions.size, 0);
        }
    }
    finally { h.restore(); }
});

test("Control Room ENGINE_STOP teardown destroys operational sources UI", async () => {
    const source = await readFile(new URL(
        "../public/js/entries/control-room-app.js", import.meta.url), "utf8");
    assert.match(source, /function destroyControlRoom\(\)[\s\S]*?studioSourcesUI\?\.destroy\(\)/);
    assert.match(source, /EventBus\.on\(Events\.ENGINE_STOP, destroyControlRoom\)/);
    assert.match(source, /function destroyControlRoom\(\)[\s\S]*?studioUI\?\.destroy\(\)/);
    assert.doesNotMatch(source, /(?:pagehide|beforeunload|unload)/);
});

for (const [kind, runtimeKind, field] of [
    ["live", "hls", "url"], ["video", "media", "url"],
    ["audio", "audio", "audioUrl"], ["image", "image", "url"]
]) {
    test(`creates persistent ${kind.toUpperCase()} without creating a scene`, () => {
        const h = harness(); h.catalog.initialize();
        const result = h.catalog.addSource({ kind, name: `${kind} source`, url: `https://example.test/a.${kind === "live" ? "m3u8" : "bin"}` });
        assert.equal(result.ok, true); assert.equal(result.source.kind, runtimeKind);
        assert.equal(h.scenes.size, 0); assert.ok(result.source[field]);
        assert.equal(JSON.parse(h.values.get(KEY)).scenes.length, 0);
    });
}

test("missing storage keeps bootstrap sources", () => {
    const h = harness(); h.catalog.initialize({ sources: [{ id: "base", name: "Base", kind: "media", url: "https://example.test/base.mp4" }] });
    assert.equal(h.catalog.getSources().length, 1); assert.equal(h.catalog.getSources()[0].origin, "base");
});

test("malformed and unsupported storage are ignored safely", () => {
    for (const seed of ["{", JSON.stringify({ version: 2, sources: [], scenes: [] })]) {
        const h = harness(seed); const report = h.catalog.initialize();
        assert.equal(h.catalog.getSources().length, 0); assert.equal(report.issues.length, 1);
    }
});

test("persisted unified definitions restore with provenance", () => {
    const first = harness(); first.catalog.initialize();
    for (const kind of ["live", "video", "audio", "image"]) first.catalog.addSource({ kind, name: kind, url: `https://example.test/${kind}` });
    const second = harness(first.values.get(KEY)); second.catalog.initialize();
    assert.deepEqual(second.catalog.getSources().map((item) => item.category), ["live", "video", "audio", "image"]);
    assert.ok(second.catalog.getSources().every((item) => item.origin === "operator"));
});

test("AUDIO artwork is optional and persists with the one source definition", () => {
    const first = harness(); first.catalog.initialize();
    const plain = first.catalog.addSource({ kind: "audio", name: "Plain",
        url: "/plain.mp3" }).source;
    const illustrated = first.catalog.addSource({ kind: "audio", name: "Show",
        url: "/show.mp3", stillUrl: "/show.jpg" }).source;
    assert.equal(plain.stillUrl, undefined);
    assert.match(illustrated.stillUrl, /show\.jpg$/);
    assert.equal(first.catalog.getSources().length, 2);
    const stored = JSON.parse(first.values.get(KEY)).sources.find(
        ({ id }) => id === illustrated.id);
    assert.match(stored.stillUrl, /show\.jpg$/);
    const second = harness(first.values.get(KEY)); second.catalog.initialize();
    assert.match(second.catalog.getSources().find(
        ({ id }) => id === illustrated.id).stillUrl, /show\.jpg$/);
});

test("editing AUDIO artwork preserves stable ID and survives reload", () => {
    const first = harness(); first.catalog.initialize();
    const source = first.catalog.addSource({ kind: "audio", name: "Show",
        url: "/show.mp3", stillUrl: "/old.jpg" }).source;
    const edited = first.catalog.updateSource(source.id, { name: "Show edited",
        url: "/show-v2.mp3", stillUrl: "/new.jpg" });
    assert.equal(edited.ok, true);
    assert.equal(edited.source.id, source.id);
    assert.match(edited.source.stillUrl, /new\.jpg$/);
    const second = harness(first.values.get(KEY)); second.catalog.initialize();
    const restored = second.catalog.getSources().find(({ id }) => id === source.id);
    assert.equal(restored.id, source.id);
    assert.match(restored.audioUrl, /show-v2\.mp3$/);
    assert.match(restored.stillUrl, /new\.jpg$/);
});

test("bootstrap AUDIO override preserves artwork", () => {
    const base = [{ id: "station-audio", name: "Station", kind: "audio",
        audioUrl: "https://example.test/station.mp3",
        stillUrl: "https://example.test/station.jpg" }];
    const first = harness(); first.catalog.initialize({ sources: base });
    assert.equal(first.catalog.updateSource("station-audio", { name: "Station 2",
        url: "/station-v2.mp3", stillUrl: "/station-v2.jpg" }).ok, true);
    const second = harness(first.values.get(KEY)); second.catalog.initialize({ sources: base });
    const restored = second.catalog.getSources()[0];
    assert.equal(restored.id, "station-audio");
    assert.match(restored.stillUrl, /station-v2\.jpg$/);
});

test("AudioSurface artwork load and failure keep audio authority and fallback", () => {
    const surface = new StudioAudioSurface({ sourceId: "audio-a",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/art.jpg", instanceId: "instance-a",
        consumer: "preview" });
    let readinessChecks = 0;
    surface.image = { hidden: true };
    surface.placeholder = { hidden: false };
    surface.checkCurrentReadiness = () => { readinessChecks += 1; };
    surface.handleImageLoad();
    assert.equal(surface.image.hidden, false);
    assert.equal(surface.placeholder.hidden, true);
    surface.handleImageError();
    assert.equal(surface.image.hidden, true);
    assert.equal(surface.placeholder.hidden, false);
    assert.equal(surface.imageReady, true);
    assert.equal(surface.transportError, false);
    assert.equal(surface.readinessState, "pending");
    assert.equal(readinessChecks, 2);

    const plain = new StudioAudioSurface({ sourceId: "audio-b",
        audioUrl: "https://example.test/audio.mp3", instanceId: "instance-b",
        consumer: "program" });
    assert.equal(plain.imageReady, true);
    assert.equal(plain.stillUrl, undefined);
});

test("AudioSurface stops and resets motion at audio end and restarts on replay", async () => {
    const surface = new StudioAudioSurface({ sourceId: "audio-motion",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4", instanceId: "instance-motion",
        consumer: "preview" });
    let pauseCalls = 0;
    let playCalls = 0;
    surface.motion = { currentTime: 18, pause() { pauseCalls += 1; },
        async play() { playCalls += 1; } };
    surface.image = { hidden: true };
    surface.placeholder = { hidden: true };
    surface.setHealth = () => {};
    surface.checkCurrentReadiness = () => {};
    surface.notifyTransport = () => {};

    surface.handleEnded();
    assert.equal(pauseCalls, 1);
    assert.equal(surface.motion.currentTime, 0);
    assert.equal(surface.motionFailed, false);
    assert.equal(surface.image.hidden, true);

    surface.handlePlaying();
    await Promise.resolve();
    assert.equal(playCalls, 1);
    assert.equal(surface.motionReady, true);

    const stillOnly = new StudioAudioSurface({ sourceId: "audio-still",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg", instanceId: "instance-still",
        consumer: "preview" });
    stillOnly.setHealth = () => {};
    stillOnly.notifyTransport = () => {};
    assert.doesNotThrow(() => stillOnly.handleEnded());
});

test("Program AudioSurface exposes one gesture retry only for autoplay rejection", async () => {
    const previousDocument = globalThis.document;
    const listeners = new Map();
    const button = {
        type: "", className: "", textContent: "", removed: false,
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type);
        },
        remove() { this.removed = true; }
    };
    globalThis.document = { createElement: (tag) => {
        assert.equal(tag, "button"); return button;
    } };
    try {
        const surface = new StudioAudioSurface({ sourceId: "audio-refresh",
            audioUrl: "https://example.test/audio.mp3",
            motionUrl: "https://example.test/motion.mp4",
            instanceId: "program-refresh", consumer: "program" });
        const root = { appended: [], appendChild(node) { this.appended.push(node); } };
        let playCalls = 0;
        let reject = true;
        const audio = { currentTime: 43199, ended: false, paused: true,
            async play() {
                playCalls += 1;
                if (reject) {
                    const error = new Error("User activation is required");
                    error.name = "NotAllowedError";
                    throw error;
                }
                this.paused = false;
            } };
        const motion = { currentTime: 72, paused: false };
        surface.root = root;
        surface.audio = audio;
        surface.motion = motion;

        assert.equal(await surface.activateProgram(), false);
        assert.equal(playCalls, 1);
        assert.equal(surface.autoplayBlocked, true);
        assert.equal(root.appended[0], button);
        assert.equal(button.type, "button");
        assert.equal(button.textContent, "ENABLE AUDIO");
        assert.equal(surface.getHealth().reason, "autoplay");
        assert.equal(motion.paused, false);
        assert.equal(motion.currentTime, 72);

        reject = false;
        listeners.get("click")(new Event("click"));
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(playCalls, 2);
        assert.equal(audio.currentTime, 43199);
        assert.equal(audio.paused, false);
        assert.equal(surface.autoplayBlocked, false);
        assert.equal(surface.audioRecoveryButton, null);
        assert.equal(button.removed, true);
        assert.equal(surface.getHealth().state, "ready");
        assert.equal(motion.paused, false);
    }
    finally { globalThis.document = previousDocument; }
});

test("Program AudioSurface resolved play and genuine failures show no recovery", async () => {
    const resolved = new StudioAudioSurface({ sourceId: "audio-ok",
        audioUrl: "https://example.test/audio.mp3", instanceId: "ok",
        consumer: "program" });
    resolved.audio = { ended: false, async play() {} };
    assert.equal(await resolved.activateProgram(), true);
    assert.equal(resolved.audioRecoveryButton, null);
    assert.equal(resolved.getHealth().state, "ready");

    const failed = new StudioAudioSurface({ sourceId: "audio-bad",
        audioUrl: "https://example.test/bad.mp3", instanceId: "bad",
        consumer: "program" });
    failed.audio = { ended: false, async play() {
        const error = new Error("Unsupported source");
        error.name = "NotSupportedError";
        throw error;
    } };
    assert.equal(await failed.activateProgram(), false);
    assert.equal(failed.audioRecoveryButton, null);
    assert.equal(failed.getHealth().state, "error");
    assert.equal(failed.getHealth().reason, "playback");
});

test("initial cached AUDIO artwork hides placeholder and no-artwork keeps it", () => {
    const illustrated = new StudioAudioSurface({ sourceId: "audio-cached",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/art.jpg", instanceId: "instance-cached",
        consumer: "preview" });
    illustrated.image = { complete: true, naturalWidth: 640, hidden: true };
    illustrated.placeholder = { hidden: false };
    illustrated.audio = { error: null, readyState: 0 };
    illustrated.checkCurrentReadiness();
    assert.equal(illustrated.image.hidden, false);
    assert.equal(illustrated.placeholder.hidden, true);

    const plain = new StudioAudioSurface({ sourceId: "audio-plain",
        audioUrl: "https://example.test/audio.mp3", instanceId: "instance-plain",
        consumer: "program" });
    plain.placeholder = { hidden: false };
    plain.audio = { error: null, readyState: 0 };
    plain.checkCurrentReadiness();
    assert.equal(plain.image, null);
    assert.equal(plain.placeholder.hidden, false);
});

test("managed AUDIO asset references reach Preview and Program surfaces with stillUrl", () => {
    StudioSourceManager.destroy();
    StudioSourceManager.initialize({});
    const assets = new Map([
        ["A1", { id: "A1", kind: "audio", url: "https://studio.test/audio.mp3" }],
        ["I1", { id: "I1", kind: "image", url: "https://studio.test/art.png" }]
    ]);
    const resolver = { resolve(id, { expectedKind }) { const asset = assets.get(id);
        return asset && asset.kind === expectedKind ? { ok: true, asset }
            : { ok: false, reason: "asset-kind-mismatch" }; } };
    const scenes = new Map();
    const catalog = new StudioCatalogManager({
        studioStateManager: { registerScene(scene) { scenes.set(scene.id, scene); return scene; },
            unregisterScene() {}, getPreviewSceneId() { return null; }, getProgramSceneId() { return null; } },
        studioSourceManager: StudioSourceManager, assetResolver: resolver, eventTarget: null,
        storage: { getItem() { return null; }, setItem() {} },
        baseUrl: "https://studio.test/control/", uuidFactory: () => "00000000-0000-4000-8000-000000000099"
    });
    catalog.initialize();
    const source = catalog.addSource({ kind: "audio", name: "Managed",
        audioAssetId: "A1", stillAssetId: "I1" }).source;
    const preview = StudioSourceManager.createInstance(source.id, { consumer: "preview" });
    const program = StudioSourceManager.createInstance(source.id, { consumer: "program" });
    assert.equal(preview.audioUrl, "https://studio.test/audio.mp3");
    assert.equal(preview.stillUrl, "https://studio.test/art.png");
    assert.equal(program.stillUrl, preview.stillUrl);
    assert.notEqual(preview, program);
    StudioSourceManager.destroy();
});

test("AudioSurface replaces and clears artwork in place without replacing audio", () => {
    const previousDocument = globalThis.document;
    const removed = [];
    const oldImage = { removeEventListener() {}, removeAttribute() {},
        remove() { removed.push("old"); } };
    const newImage = { addEventListener() {}, hidden: false, removeEventListener() {},
        removeAttribute() {}, remove() { removed.push("new"); } };
    globalThis.document = { createElement: () => newImage };
    try {
        const surface = new StudioAudioSurface({ sourceId: "audio-a",
            audioUrl: "https://example.test/audio.mp3",
            stillUrl: "https://example.test/old.jpg", instanceId: "instance-a",
            consumer: "preview" });
        const audio = {};
        surface.audio = audio;
        surface.image = oldImage;
        surface.placeholder = { hidden: true };
        surface.root = { insertBefore(node, before) {
            assert.equal(node, newImage); assert.equal(before, audio); } };
        surface.checkCurrentReadiness = () => {};
        assert.equal(surface.updateSourceDefinition({ audioUrl: surface.audioUrl,
            stillUrl: "https://example.test/new.jpg" }), true);
        assert.equal(surface.image, newImage);
        assert.equal(surface.stillUrl, "https://example.test/new.jpg");
        assert.equal(removed[0], "old");
        assert.equal(surface.updateSourceDefinition({ audioUrl: surface.audioUrl }), true);
        assert.equal(surface.image, null);
        assert.equal(surface.stillUrl, null);
        assert.equal(surface.placeholder.hidden, false);
        assert.deepEqual(removed, ["old", "new"]);
    } finally { globalThis.document = previousDocument; }
});

test("Control Room Preview and Program receive independent AUDIO artwork surfaces", () => {
    StudioSourceManager.destroy();
    StudioSourceManager.initialize({});
    assert.ok(StudioSourceManager.registerSource({ id: "art-a", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/art.jpg" }));
    const preview = StudioSourceManager.createInstance("art-a", {
        consumer: "preview" });
    const program = StudioSourceManager.createInstance("art-a", {
        consumer: "program" });
    assert.ok(preview instanceof StudioAudioSurface);
    assert.ok(program instanceof StudioAudioSurface);
    assert.notEqual(preview, program);
    assert.equal(preview.consumer, "preview");
    assert.equal(program.consumer, "program");
    assert.equal(preview.stillUrl, "https://example.test/art.jpg");
    assert.equal(program.stillUrl, "https://example.test/art.jpg");
    StudioSourceManager.destroy();
});

test("Preview and Program receive independent AUDIO motion surfaces", () => {
    StudioSourceManager.destroy();
    StudioSourceManager.initialize({});
    assert.ok(StudioSourceManager.registerSource({ id: "motion-a", kind: "audio",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/motion.mp4" }));
    const preview = StudioSourceManager.createInstance("motion-a", { consumer: "preview" });
    const program = StudioSourceManager.createInstance("motion-a", { consumer: "program" });
    assert.notEqual(preview, program);
    assert.equal(preview.motionUrl, "https://example.test/motion.mp4");
    assert.equal(program.motionUrl, preview.motionUrl);
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: () => ({ addEventListener() {} }) };
    try {
        const previewVideo = preview.createMotionElement();
        const programVideo = program.createMotionElement();
        assert.notEqual(previewVideo, programVideo);
    } finally { globalThis.document = previousDocument; }
    StudioSourceManager.destroy();
});

test("AudioSurface prioritizes motion and updates it without replacing audio", async () => {
    const surface = new StudioAudioSurface({ sourceId: "audio-motion",
        audioUrl: "https://example.test/audio.mp3",
        stillUrl: "https://example.test/still.jpg",
        motionUrl: "https://example.test/old.mp4", instanceId: "instance-motion",
        consumer: "preview" });
    const audio = {};
    const still = { hidden: true };
    const placeholder = { hidden: false };
    const oldMotion = { hidden: true, pause() {}, removeEventListener() {},
        removeAttribute() {}, load() {}, remove() {}, play: async () => {} };
    surface.audio = audio;
    surface.image = still;
    surface.imageReady = true;
    surface.placeholder = placeholder;
    surface.motion = oldMotion;
    surface.motionReady = true;
    surface.refreshArtworkVisibility();
    assert.equal(oldMotion.hidden, false);
    assert.equal(still.hidden, true);
    assert.equal(placeholder.hidden, true);

    const previousDocument = globalThis.document;
    const events = new Map();
    const nextMotion = { hidden: true, pause() {}, load() {}, remove() {},
        removeAttribute() {}, play: async () => {},
        addEventListener(type, listener) { events.set(type, listener); },
        removeEventListener() {} };
    globalThis.document = { createElement: (tag) => {
        assert.equal(tag, "video"); return nextMotion;
    } };
    try {
        surface.root = { insertBefore(node, before) {
            assert.equal(node, nextMotion); assert.equal(before, audio); } };
        surface.checkCurrentReadiness = () => {};
        assert.equal(surface.updateSourceDefinition({ audioUrl: surface.audioUrl,
            stillUrl: surface.stillUrl, motionUrl: "https://example.test/new.mp4" }), true);
        assert.equal(surface.audio, audio);
        assert.equal(surface.motion, nextMotion);
        assert.equal(nextMotion.muted, true);
        assert.equal(nextMotion.loop, true);
        assert.equal(nextMotion.autoplay, true);
        assert.equal(nextMotion.playsInline, true);
        assert.equal(nextMotion.controls, false);
        events.get("loadeddata")();
        await Promise.resolve();
        assert.equal(nextMotion.hidden, false);
        assert.equal(surface.updateSourceDefinition({ audioUrl: surface.audioUrl,
            stillUrl: surface.stillUrl }), true);
        assert.equal(surface.motion, null);
        assert.equal(surface.audio, audio);
        assert.equal(still.hidden, false);
    } finally { globalThis.document = previousDocument; }
});

test("Control Room AUDIO artwork CSS contains the image and honors fallback hiding", async () => {
    const css = await readFile(new URL(
        "../public/css/studio-renderer.css", import.meta.url), "utf8");
    assert.match(css,
        /\.studio-render-audio-still\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain;/s);
    assert.match(css,
        /\.studio-render-audio-placeholder\[hidden\]\s*\{[^}]*display:\s*none;/s);
});

test("BREAK remains the original bootstrap SLATE scene, not a source", async () => {
    const config = JSON.parse(await readFile(new URL(
        "../public/config/studio.json", import.meta.url), "utf8"));
    const breakScene = config.scenes.find(({ id }) => id === "break");
    assert.deepEqual({ id: breakScene.id, name: breakScene.name,
        type: breakScene.type, kind: breakScene.renderer.kind },
    { id: "break", name: "BREAK", type: "SLATE", kind: "slate" });
    assert.equal(config.sources.some(({ id }) => id === "break"), false);
    const h = harness(); h.catalog.initialize(config);
    assert.equal(h.catalog.getDefinition("break")?.renderer.kind, "slate");
    assert.equal(h.catalog.getSources().some(({ id }) => id === "break"), false);
});

test("source to scene is explicit, stable and reusable", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "video", name: "Opening", url: "/media/open.mp4" }).source;
    const a = h.catalog.createSceneForSource(source.id, { name: "Opening A" });
    const b = h.catalog.createSceneForSource(source.id, { name: "Opening B" });
    assert.equal(a.ok, true); assert.equal(b.ok, true); assert.notEqual(a.scene.id, b.scene.id);
    assert.equal(h.catalog.getSources()[0].sceneIds.length, 2);
});

test("rename preserves source identity", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "image", name: "Old", url: "/old.png" }).source;
    const updated = h.catalog.updateSource(source.id, { name: "New", url: "/new.png" });
    assert.equal(updated.ok, true); assert.equal(updated.source.id, source.id); assert.equal(updated.source.name, "New");
});

test("invalid kind and unsafe persistent URL are rejected", () => {
    const h = harness(); h.catalog.initialize();
    assert.equal(h.catalog.addSource({ kind: "document", name: "X", url: "/x" }).reason, "invalid-kind");
    assert.equal(h.catalog.addSource({ kind: "video", name: "X", url: "file:///x" }).reason, "invalid-url");
    assert.equal(h.catalog.addSource({ kind: "video", name: "X", url: "blob:x" }).reason, "invalid-url");
});

test("bootstrap source edits and tombstones persist by stable ID", () => {
    const base = [{ id: "base", name: "Base", kind: "media", url: "https://example.test/base.mp4" }];
    const first = harness(); first.catalog.initialize({ sources: base });
    const edited = first.catalog.updateSource("base", { name: "Edited", url: "/edited.mp4", kind: "audio" });
    assert.equal(edited.ok, true); assert.equal(edited.source.id, "base");
    assert.equal(edited.source.kind, "media");
    const reloaded = harness(first.values.get(KEY)); reloaded.catalog.initialize({ sources: base });
    assert.equal(reloaded.catalog.getSources()[0].name, "Edited");
    assert.match(reloaded.catalog.getSources()[0].url, /edited\.mp4$/);
    assert.equal(reloaded.catalog.removeSource("base").ok, true);
    const deleted = harness(reloaded.values.get(KEY)); deleted.catalog.initialize({ sources: base });
    assert.equal(deleted.catalog.getSources().length, 0);
});

test("referenced source removal is rejected and orphan source removal persists", () => {
    const h = harness(); h.catalog.initialize();
    const a = h.catalog.addSource({ kind: "image", name: "A", url: "/a.png" }).source;
    h.catalog.createSceneForSource(a.id, { name: "A scene" });
    assert.equal(h.catalog.removeSource(a.id).reason, "source-still-referenced");
    const b = h.catalog.addSource({ kind: "video", name: "B", url: "/b.mp4" }).source;
    assert.equal(h.catalog.removeSource(b.id).ok, true);
    assert.equal(JSON.parse(h.values.get(KEY)).sources.some(({ id }) => id === b.id), false);
});

test("removal guard protects externally authorized sources", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "live", name: "Live", url: "/live.m3u8" }).source;
    h.catalog.updateLiveSource(source.id, { name: "Live", url: "/live.m3u8", enabled: false });
    h.catalog.setRemovalGuard(({ sourceId }) => sourceId === source.id);
    assert.equal(h.catalog.removeSource(source.id).reason, "source-authorized");
});

test("scene edit keeps identity, changes source and persists", () => {
    const first = harness(); first.catalog.initialize();
    const a = first.catalog.addSource({ kind: "video", name: "A", url: "/a.mp4" }).source;
    const b = first.catalog.addSource({ kind: "image", name: "B", url: "/b.png" }).source;
    const scene = first.catalog.createSceneForSource(a.id, { name: "Original" }).scene;
    const result = first.catalog.updateScene(scene.id, { name: "Edited", sourceId: b.id });
    assert.equal(result.ok, true); assert.equal(result.scene.id, scene.id);
    assert.equal(result.scene.renderer.sourceId, b.id);
    assert.equal(first.catalog.getSources().find(({ id }) => id === a.id).sceneIds.length, 0);
    assert.deepEqual(first.catalog.getSources().find(({ id }) => id === b.id).sceneIds, [scene.id]);
    const second = harness(first.values.get(KEY)); second.catalog.initialize();
    assert.equal(second.catalog.getDefinition(scene.id).name, "Edited");
    assert.equal(second.catalog.getDefinition(scene.id).renderer.sourceId, b.id);
});

test("scene and source on-air deletion guards are explicit", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "video", name: "A", url: "/a.mp4" }).source;
    const scene = h.catalog.createSceneForSource(source.id, { name: "A" }).scene;
    h.setPreview(scene.id);
    assert.equal(h.catalog.removeScene(scene.id).reason, "scene-in-preview");
    assert.equal(h.catalog.removeSource(source.id).reason, "source-in-preview");
    h.setPreview(null); h.setProgram(scene.id);
    assert.equal(h.catalog.removeScene(scene.id).reason, "scene-in-program");
    assert.equal(h.catalog.removeSource(source.id).reason, "source-in-program");
});

test("unused scene deletion persists and scheduler guard rejects references", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "image", name: "A", url: "/a.png" }).source;
    const scene = h.catalog.createSceneForSource(source.id, { name: "A" }).scene;
    h.catalog.setRemovalGuard(({ sceneId }) => sceneId === scene.id);
    assert.equal(h.catalog.removeScene(scene.id).reason, "scene-authorized");
    h.catalog.setRemovalGuard(null);
    assert.equal(h.catalog.removeScene(scene.id).ok, true);
    assert.equal(h.catalog.getDefinition(scene.id), null);
});

test("active runtime source deletion is rejected", () => {
    const h = harness(); h.catalog.initialize();
    const source = h.catalog.addSource({ kind: "video", name: "A", url: "/a.mp4" }).source;
    h.setActiveSource(source.id);
    assert.equal(h.catalog.removeSource(source.id).reason, "source-has-active-instances");
});

test("bootstrap scene overrides and tombstones persist", () => {
    const sources = [{ id: "base", name: "Base", kind: "media", url: "https://example.test/base.mp4" }];
    const scenes = [{ id: "main", name: "Main", type: "MEDIA",
        renderer: { kind: "source", sourceId: "base" } }];
    const first = harness(); first.catalog.initialize({ sources, scenes });
    assert.equal(first.catalog.updateScene("main", { name: "Renamed", sourceId: "base" }).ok, true);
    const second = harness(first.values.get(KEY)); second.catalog.initialize({ sources, scenes });
    assert.equal(second.catalog.getDefinition("main").name, "Renamed");
    assert.equal(second.catalog.removeScene("main").ok, true);
    const third = harness(second.values.get(KEY)); third.catalog.initialize({ sources, scenes });
    assert.equal(third.catalog.getDefinition("main"), null);
});

test("registry snapshots are frozen and subscription is event driven", () => {
    const h = harness(); h.catalog.initialize(); let calls = 0;
    const unsubscribe = h.catalog.subscribe((snapshot) => { calls += 1; assert.equal(Object.isFrozen(snapshot), true); });
    h.catalog.addSource({ kind: "image", name: "Still", url: "/still.png" }); unsubscribe();
    assert.equal(calls, 2);
});

test("image surface owns load readiness and cleanup without polling", async () => {
    const source = await readFile(new URL("../public/js/studio/renderers/StudioImageSurface.js", import.meta.url), "utf8");
    assert.match(source, /addEventListener\("load"/); assert.match(source, /object|waitUntilReady/);
    assert.match(source, /removeAttribute\("src"\)/); assert.doesNotMatch(source, /setInterval|requestAnimationFrame/);
});

test("operator workflows keep source and scene controls separate", async () => {
    const sourcesUI = await readFile(new URL("../public/js/ui/StudioOperationalSourcesUI.js", import.meta.url), "utf8");
    const scenesUI = await readFile(new URL("../public/js/ui/StudioUI.js", import.meta.url), "utf8");
    assert.match(sourcesUI, /NEW SOURCE/); assert.doesNotMatch(sourcesUI, /CREATE SCENE/);
    assert.match(scenesUI, /CREATE SCENE/); assert.match(scenesUI, /createSceneForSource/);
    assert.match(sourcesUI, /summary\.textContent = "⋯"/);
    assert.match(scenesUI, /summary\.textContent = "⋯"/);
    assert.doesNotMatch(sourcesUI, /localStorage/);
    assert.doesNotMatch(scenesUI, /localStorage/);
});
