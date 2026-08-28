import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import StudioCatalogManager from "../public/js/studio/StudioCatalogManager.js";
import StudioAudioSurface from "../public/js/studio/renderers/StudioAudioSurface.js";
import StudioSourceManager from "../public/js/studio/StudioSourceManager.js";
import StudioOperationalSourcesUI from "../public/js/ui/StudioOperationalSourcesUI.js";
import StudioUI from "../public/js/ui/StudioUI.js";

const KEY = "livezone.studio.mediaCatalog.overlay.v1";

function harness(seed = null) {
    const values = new Map(seed ? [[KEY, seed]] : []);
    const sources = new Map();
    const scenes = new Map();
    let activeInstances = [];
    let serial = 0;
    const sourceManager = {
        registerSource(value) { if (sources.has(value.id)) return null; sources.set(value.id, value); return value; },
        replaceSource(value) { if (!sources.has(value.id)) return null; sources.set(value.id, value); return value; },
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
        studioSourceManager: sourceManager, eventTarget: null,
        storage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
        baseUrl: "https://studio.test/control/", uuidFactory: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}` });
    return { catalog, values, sources, scenes,
        setPreview: (id) => { previewSceneId = id; },
        setProgram: (id) => { programSceneId = id; },
        setActiveSource: (id) => { activeInstances = id ? [{ sourceId: id }] : []; } };
}

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
