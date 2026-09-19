import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import DominantLiveConfig, { DOMINANT_LIVE_STORAGE_KEY as KEY } from "../public/js/studio/DominantLiveConfig.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import StudioCatalogManager from "../public/js/studio/StudioCatalogManager.js";
import StudioLiveSourcesUI from "../public/js/ui/StudioLiveSourcesUI.js";
import DominantLiveUI from "../public/js/ui/DominantLiveUI.js";

const live = { id: "primary-live", name: "MAIN LIVE", kind: "hls", url: "https://example.test/live.m3u8" };
function storageFor(id = live.id) {
    const values = new Map([[KEY, JSON.stringify({ version: 1, armed: true, authorizedSourceId: id })]]);
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function setup({ storage = storageFor(), sources = [live], hydrate = true } = {}) {
    const registered = new Map(); const scenes = new Map();
    const catalog = new StudioCatalogManager({ storage, eventTarget: null,
        baseUrl: "https://example.test/control/", uuidFactory: () => "test-a",
        studioStateManager: { registerScene: s => (scenes.set(s.id, s), s),
            unregisterScene: id => scenes.delete(id), getPreviewSceneId: () => null,
            getProgramSceneId: () => null },
        studioSourceManager: { registerSource: s => (registered.set(s.id, s), s),
            unregisterSource: id => registered.delete(id), getActiveInstances: () => [] } });
    if (hydrate) catalog.initialize({ sources });
    const config = new DominantLiveConfig({ storage, eventTarget: null });
    const monitor = { subscribe: () => () => {}, selectSource(s) { this.source = s; },
        stop() { this.source = null; }, destroy() {} };
    const scheduler = { getSnapshot: () => ({ enabled: false }), subscribe: () => () => {} };
    const controller = new DominantLiveController({ config, catalog, monitor, scheduler,
        command: {}, eventBus: { on() {}, off() {} } });
    controller.start();
    return { storage, catalog, config, controller, monitor,
        destroy() { controller.destroy(); config.destroy(); catalog.destroy(); } };
}

test("saved authorized bootstrap LIVE source hydrates without changing v1 policy", () => {
    const storage = storageFor(); const before = storage.getItem(KEY);
    const h = setup({ storage });
    assert.equal(h.controller.getSnapshot().authorizedSourceName, "MAIN LIVE");
    assert.equal(h.monitor.source.id, live.id);
    assert.equal(storage.getItem(KEY), before); h.destroy();
});

test("saved authorization resolves after source registration without guessing another LIVE", () => {
    const h = setup({ storage: storageFor("live-test-a") });
    assert.equal(h.controller.getSnapshot().status, "DISARMED");
    assert.equal(h.config.getSnapshot().authorizedSourceId, "live-test-a");
    assert.equal(h.catalog.addLiveSource({ name: "Operator LIVE", url: live.url, enabled: true }).ok, true);
    assert.equal(h.monitor.source.id, "live-test-a"); h.destroy();
});

test("reload preserves an explicitly selected operator LIVE and catalog overlay", () => {
    const storage = storageFor(null); const first = setup({ storage });
    const added = first.catalog.addLiveSource({ name: "Operator LIVE", url: live.url, enabled: true });
    first.config.setAuthorizedSourceId(added.source.id); first.destroy();
    const second = setup({ storage });
    assert.equal(second.controller.getSnapshot().authorizedSourceId, added.source.id);
    assert.equal(second.monitor.source.id, added.source.id); second.destroy();
});

test("schedule navigation and controller reconstruction preserve authorization", () => {
    const storage = storageFor(null); const first = setup({ storage }); first.destroy();
    const scheduleConfig = new DominantLiveConfig({ storage, eventTarget: null });
    scheduleConfig.setAuthorizedSourceId(live.id); scheduleConfig.destroy();
    const second = setup({ storage });
    assert.equal(second.monitor.source.id, live.id); second.destroy();
});

test("missing source renders actionable selection warning while retaining saved identity", () => {
    const h = setup({ storage: storageFor("live-missing") });
    const ui = new DominantLiveUI();
    ui.toggle = { setAttribute() {} }; ui.status = {}; ui.source = {}; ui.root = { dataset: {} };
    ui.render(h.controller.getSnapshot());
    assert.equal(ui.status.textContent, "SELEZIONA SORGENTE");
    assert.equal(ui.source.textContent, "");
    assert.equal(h.config.getSnapshot().authorizedSourceId, "live-missing"); h.destroy();
});

test("deleting a resolved source revokes authorization and stops the monitor", () => {
    const h = setup();
    assert.equal(h.catalog.removeSource(live.id).ok, true);
    assert.equal(h.config.getSnapshot().authorizedSourceId, null);
    assert.equal(h.controller.getSnapshot().status, "DISARMED");
    assert.equal(h.monitor.source, null); h.destroy();
});

test("multiple LIVE sources never implicitly authorize a source", () => {
    const h = setup({ storage: storageFor(null), sources: [live, { ...live, id: "live-b" }] });
    assert.equal(h.config.getSnapshot().authorizedSourceId, null);
    assert.equal(h.controller.getSnapshot().status, "DISARMED");
    assert.equal(h.monitor.source, null); h.destroy();
});

test("non-LIVE source cannot become an effective authorized source", () => {
    const h = setup({ sources: [{ ...live, kind: "media", url: "https://example.test/a.mp4" }] });
    assert.equal(h.config.getSnapshot().authorizedSourceId, null);
    assert.equal(h.controller.getSnapshot().status, "DISARMED"); h.destroy();
});

test("late catalog hydration notifies the running controller and preserves the saved identity", () => {
    const h = setup({ hydrate: false }); const before = h.storage.getItem(KEY);
    assert.equal(h.controller.getSnapshot().status, "DISARMED");
    assert.equal(h.storage.getItem(KEY), before);
    h.catalog.initialize({ sources: [live] });
    assert.equal(h.monitor.source.id, live.id);
    assert.equal(h.storage.getItem(KEY), before); h.destroy();
});

test("late policy hydration reconciles with a registered catalog", () => {
    const h = setup({ storage: storageFor(null) });
    h.config.handleStorage({ key: KEY, newValue: storageFor().getItem(KEY) });
    assert.equal(h.monitor.source.id, live.id); h.destroy();
});

test("existing source authorization action accepts bootstrap LIVE, rejects disabled and non-LIVE", () => {
    const h = setup({ storage: storageFor(null) });
    const ui = new StudioLiveSourcesUI(null, h.catalog, null, h.config); ui.show = () => {};
    const click = id => ui.handleClick({ target: { closest: () => ({ dataset: { action: "authorize", id } }) } });
    click(live.id); assert.equal(h.config.getSnapshot().authorizedSourceId, live.id);
    click(live.id); assert.equal(h.config.getSnapshot().authorizedSourceId, null);
    ui.catalog = { getSources: () => [{ ...live, enabled: false }] };
    click(live.id); assert.equal(h.config.getSnapshot().authorizedSourceId, null);
    ui.catalog = { getSources: () => [{ ...live, kind: "media" }] };
    click(live.id); assert.equal(h.config.getSnapshot().authorizedSourceId, null); h.destroy();
});

test("LIVE SOURCES renders the bootstrap authorization control alongside operator LIVE sources", () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: () => ({ dataset: {}, attributes: {}, children: [],
        setAttribute(key, value) { this.attributes[key] = value; },
        append(...children) { this.children.push(...children); } }) };
    try {
        const ui = new StudioLiveSourcesUI(null, null, null,
            { getSnapshot: () => ({ armed: true, authorizedSourceId: live.id }) });
        ui.started = true; ui.list = { replaceChildren(...rows) { this.rows = rows; } };
        ui.render([{ ...live, origin: "base", enabled: true },
            { ...live, id: "live-operator", origin: "operator", enabled: true },
            { ...live, id: "media-a", kind: "media" }]);
        assert.equal(ui.list.rows.length, 2);
        const [edit, toggle, authorize, remove] = ui.list.rows[0].children[4].children;
        assert.equal(authorize.dataset.id, live.id);
        assert.equal(authorize.textContent, "AUTO INTERRUPT: ON");
        assert.equal(authorize.disabled, false);
        assert.ok(edit.hidden && toggle.hidden && remove.hidden);
        assert.equal(ui.list.rows[1].children[4].children[0].hidden, false);
    } finally { globalThis.document = previous; }
});

test("ControlDesk startup still precedes awaited catalog bootstrap and AutoLive initialization", async () => {
    const code = await readFile(new URL("../public/js/entries/control-room-app.js", import.meta.url), "utf8");
    const steps = ["new DominantLiveConfig()", "controlDeskLayoutManager.start()", "runtime.start({",
        "StudioSourceManager.initialize(config)", "await studioBootstrap.initialize()",
        "new AutoLiveEntryController({", "dominantLiveController.start()", "dominantLiveUI.start()"];
    let previous = -1;
    for (const step of steps) {
        const index = code.indexOf(step); assert.ok(index > previous, step); previous = index;
    }
    const h = setup(); assert.equal(h.monitor.source.id, live.id); h.destroy();
});
