import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import SourceManager from "../public/js/studio/StudioSourceManager.js";
import StudioCatalogManager from "../public/js/studio/StudioCatalogManager.js";
import initializeScheduleSources from "../public/js/scheduler/InitializeScheduleSources.js";
import DominantLiveConfig, { DOMINANT_LIVE_STORAGE_KEY as KEY } from "../public/js/studio/DominantLiveConfig.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import DominantLiveUI from "../public/js/ui/DominantLiveUI.js";
import StudioLiveSourcesUI from "../public/js/ui/StudioLiveSourcesUI.js";
import ScheduleWorkspaceUI from "../public/js/ui/ScheduleWorkspaceUI.js";
import ScheduleStore from "../public/js/scheduler/ScheduleStore.js";
import { AutoLiveAuthorizationDiagnostics } from "../public/js/studio/AutoLiveAuthorizationDiagnostics.js";

const definition = JSON.parse(await readFile(new URL("../public/config/studio.json", import.meta.url), "utf8"));
const technical = { stream: { primary: "https://example.test/main/index.m3u8" } };
const savedDocument = globalThis.document; const savedFormData = globalThis.FormData;
class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map();
        this.elements = {}; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    closest() { return this; }
    reset() {}
    dispatch(type, target = this) { this.listeners.get(type)?.({ target, preventDefault() {} }); }
}
before(() => {
    globalThis.document = { createElement: () => new Element() };
    // Node has no HTMLFormElement; only adapt form field collection, not production handlers.
    globalThis.FormData = class { constructor(form) { this.fields = form.fields; }
        get(key) { return this.fields[key] ?? null; } };
});
after(() => { globalThis.document = savedDocument; globalThis.FormData = savedFormData; });
function storage() {
    const values = new Map(); const writes = [];
    return { values, writes, getItem: key => values.get(key) ?? null,
        setItem(key, value) { writes.push({ key, value }); values.set(key, value); } };
}
async function page(shared, { hydrate = true, configure = true } = {}) {
    const sourceManager = new SourceManager.constructor();
    if (configure) await initializeScheduleSources(sourceManager, {
        fetchImplementation: async () => ({ ok: true, json: async () => technical }) });
    else sourceManager.initialize({});
    const scenes = new Map(); let uuid = 0;
    const catalog = new StudioCatalogManager({ studioSourceManager: sourceManager,
        studioStateManager: { registerScene: s => (scenes.set(s.id, s), s),
            unregisterScene: id => scenes.delete(id), getPreviewSceneId: () => null,
            getProgramSceneId: () => null }, storage: shared, eventTarget: null,
        baseUrl: "https://example.test/config/studio.json", uuidFactory: () => `selected-${++uuid}` });
    const records = [];
    const diagnostics = new AutoLiveAuthorizationDiagnostics({ enabled: true,
        output: (event, fields) => records.push({ event, fields }) });
    const config = new DominantLiveConfig({ storage: shared, eventTarget: null, diagnostics });
    if (hydrate) catalog.initialize(definition);
    const nodes = Object.fromEntries(["live-source-form", "live-source-list", "live-source-feedback",
        "live-source-cancel"].map(id => [id, new Element()]));
    nodes["live-source-form"].elements = { name: {}, url: {}, enabled: {} };
    const store = new ScheduleStore({ storage: shared, eventTarget: null });
    const ui = new StudioLiveSourcesUI({ querySelector: selector => nodes[selector.slice(1)] }, catalog, store, config);
    assert.equal(ui.start(), true);
    return { catalog, config, sourceManager, records, nodes, ui, store,
        destroy() { this.running?.view.destroy(); this.running?.controller.destroy();
            ui.destroy(); config.destroy(); catalog.destroy(); },
        click(id, action = "authorize") {
            const button = nodes["live-source-list"].children.flatMap(row => row.children[4].children)
                .find(button => button.dataset.id === id && button.dataset.action === action);
            assert.ok(button, `Rendered ${action} action for ${id}`);
            nodes["live-source-list"].dispatch("click", button);
        },
        saveLive(id = null) {
            if (id) this.click(id, "edit");
            nodes["live-source-form"].fields = { name: "Operator LIVE", url: "https://example.test/live.m3u8", enabled: "on" };
            nodes["live-source-form"].dispatch("submit");
            assert.equal(nodes["live-source-feedback"].textContent.includes("rifiutato"), false);
        },
        saveSchedule(id) {
            const workspace = new ScheduleWorkspaceUI({ root: null, store, catalog, uuidFactory: () => "item-a" });
            workspace.schedule = store.load().schedule;
            workspace.form = { fields: { title: "Selected LIVE", sourceTargetId: id,
                targetKind: "source", date: "2026-09-09", time: "12:00", duration: "00:10:00",
                startMode: "ABSOLUTE", behavior: "NORMAL", transition: "CUT" } };
            workspace.resetEditor = () => {}; workspace.showFeedback = (_message, error) => assert.equal(error, false);
            workspace.handleFormSubmit({ preventDefault() {} });
            assert.equal(store.load().schedule.items[0].target.id, id);
        },
        startControl() {
            const monitor = { source: null, subscribe: () => () => {},
                selectSource(source) { this.source = source; }, stop() { this.source = null; }, destroy() {} };
            const controller = new DominantLiveController({ config, catalog, monitor,
                scheduler: { getSnapshot: () => ({ enabled: false }), subscribe: () => () => {} },
                command: {}, eventBus: { on() {}, off() {} } });
            controller.start();
            const controlNodes = Object.fromEntries(["dominant-live-armed", "dominant-live-status", "dominant-live-source"]
                .map(id => [id, new Element()]));
            const view = new DominantLiveUI({ config, controller,
                root: { dataset: {}, querySelector: selector => controlNodes[selector.slice(1)] } });
            assert.equal(view.start(), true);
            this.running = { controller, monitor, controlNodes, view };
            return this.running;
        } };
}

test("production source manager reproduces the empty-config rejection of primary-live", async () => {
    const old = await page(storage(), { configure: false });
    assert.equal(old.catalog.getSources().some(s => s.id === "primary-live"), false);
    const fixed = await page(storage());
    assert.equal(fixed.catalog.getSources().find(s => s.id === "primary-live").url, technical.stream.primary);
    const entry = await readFile(new URL("../public/js/entries/schedule-app.js", import.meta.url), "utf8");
    assert.ok(entry.indexOf("await initializeScheduleSources(StudioSourceManager)") < entry.indexOf("await bootstrap.initialize()"));
    assert.ok(!entry.includes("StudioSourceManager.initialize({})"));
});

for (const selected of ["primary-live", "live-selected-1"]) {
    test(`rendered AUTO INTERRUPT action → SAVE → Control reconstruction preserves ${selected}`, async () => {
        const shared = storage(); const scheduler = await page(shared);
        scheduler.saveLive(); scheduler.saveLive();
        scheduler.click(selected);
        if (selected !== "primary-live") scheduler.saveLive(selected);
        scheduler.saveSchedule(selected);
        assert.deepEqual(JSON.parse(shared.getItem(KEY)), { version: 1, armed: false, authorizedSourceId: selected });
        assert.equal(JSON.parse(shared.getItem("livezone.scheduler.schedule.v1")).items[0].target.id, selected);
        assert.equal(Object.hasOwn(JSON.parse(shared.getItem("livezone.scheduler.schedule.v1")), "dominantLive"), false);
        assert.ok(scheduler.records.some(r => r.event === "AUTOLIVE_AUTH_WRITE" &&
            r.fields.sourceId === selected && r.fields.sourceKind === "hls" && r.fields.ok === true));
        for (let reload = 0; reload < 2; reload++) {
            const control = await page(shared); const running = control.startControl();
            assert.equal(running.controller.getSnapshot().authorizedSourceId, selected);
            assert.equal(running.monitor.source.id, selected);
            assert.notEqual(running.controlNodes["dominant-live-source"].textContent, "NO AUTHORIZED SOURCE");
            assert.ok(control.records.some(r => r.event === "AUTOLIVE_AUTH_READ" &&
                r.fields.storedSourceId === selected && r.fields.normalizedSourceId === selected &&
                r.fields.catalogMatch && r.fields.finalAuthorizedSourceId === selected));
            running.controller.destroy();
        }
    });
}

test("Control → Scheduler → Control uses exact new selection among multiple LIVE sources", async () => {
    const shared = storage(); const first = await page(shared); first.startControl().controller.destroy();
    const scheduler = await page(shared); scheduler.saveLive(); scheduler.saveLive();
    scheduler.click("live-selected-2"); scheduler.saveSchedule("live-selected-2");
    const control = (await page(shared)).startControl();
    assert.equal(control.monitor.source.id, "live-selected-2"); control.controller.destroy();
});

test("saved UI selection survives catalog hydration after config and controller", async () => {
    const shared = storage(); const scheduler = await page(shared);
    scheduler.click("primary-live"); scheduler.saveSchedule("primary-live");
    const control = await page(shared, { hydrate: false }); const running = control.startControl();
    assert.equal(control.config.getSnapshot().authorizedSourceId, "primary-live");
    control.catalog.initialize(definition);
    assert.equal(running.monitor.source.id, "primary-live"); running.controller.destroy();
});

test("deleting selected LIVE safely disarms including reconstruction", async () => {
    const shared = storage(); const scheduler = await page(shared); scheduler.saveLive();
    scheduler.click("live-selected-1"); const control = await page(shared); const running = control.startControl();
    for (const sceneId of control.catalog.getSources().find(s => s.id === "live-selected-1").sceneIds) {
        assert.equal(control.catalog.removeScene(sceneId).ok, true);
    }
    assert.equal(control.catalog.removeSource("live-selected-1").ok, true);
    assert.equal(running.controller.getSnapshot().status, "DISARMED");
    assert.equal(control.config.getSnapshot().authorizedSourceId, null);
    assert.equal((await page(shared)).config.getSnapshot().authorizedSourceId, null); running.controller.destroy();
});

test("non-LIVE action is rejected and multiple LIVE sources never imply authorization", async () => {
    const shared = storage(); const scheduler = await page(shared); scheduler.saveLive();
    const fake = new Element(); fake.dataset = { action: "authorize", id: "media-demo" };
    scheduler.nodes["live-source-list"].dispatch("click", fake);
    assert.equal(shared.getItem(KEY), null);
    assert.equal(scheduler.config.getSnapshot().authorizedSourceId, null);
});

test("AUTO INTERRUPT OFF persists explicit revocation through normal UI", async () => {
    const shared = storage(); const scheduler = await page(shared);
    scheduler.click("primary-live"); scheduler.click("primary-live"); scheduler.saveSchedule("primary-live");
    assert.equal(JSON.parse(shared.getItem(KEY)).authorizedSourceId, null);
    const running = (await page(shared)).startControl();
    assert.equal(running.controlNodes["dominant-live-source"].textContent, "NO AUTHORIZED SOURCE");
    running.controller.destroy();
});

for (const failure of ["throw", "discard"]) {
    test(`authorization write ${failure} cannot display a false saved confirmation`, async () => {
        const shared = storage(); const scheduler = await page(shared);
        const setItem = shared.setItem.bind(shared);
        shared.setItem = (key, value) => { if (key !== KEY) return setItem(key, value);
            if (failure === "throw") throw new Error("do-not-log-this-error"); };
        scheduler.click("primary-live");
        assert.equal(scheduler.config.getSnapshot().authorizedSourceId, null);
        assert.match(scheduler.nodes["live-source-feedback"].textContent, /non salvata/);
        assert.ok(scheduler.records.some(r => r.event === "AUTOLIVE_AUTH_WRITE" && r.fields.ok === false));
        assert.equal((await page(shared)).config.getSnapshot().authorizedSourceId, null);
    });
}

test("authorization console diagnostics are bounded and exclude unexpected or unsafe fields", () => {
    const records = []; const diagnostics = new AutoLiveAuthorizationDiagnostics({ enabled: true, capacity: 2,
        output: (event, fields) => records.push({ event, fields }) });
    diagnostics.record("AUTOLIVE_AUTH_READ", { storedSourceId: "https://user:secret@example.test",
        normalizedSourceId: null, catalogMatch: false, finalAuthorizedSourceId: null, cookie: "secret" });
    for (let i = 0; i < 10; i++) diagnostics.record("AUTOLIVE_AUTH_CONTROLLER", {
        authorizedSourceId: `live-${i}`, state: "DISARMED", reason: "NO_AUTHORIZED_SOURCE", token: "secret" });
    assert.equal(records.length, 2); assert.ok(!JSON.stringify(records).includes("secret"));
});

test("failed revocation persistence still stops a deleted source without recursive reconciliation", async () => {
    const shared = storage(); const scheduler = await page(shared); scheduler.click("primary-live");
    const control = await page(shared); const running = control.startControl();
    const setItem = shared.setItem.bind(shared);
    shared.setItem = (key, value) => { if (key === KEY) throw new Error("write failed"); setItem(key, value); };
    assert.equal(control.catalog.removeScene("main-live").ok, true);
    assert.equal(control.catalog.removeSource("primary-live").ok, true);
    assert.equal(running.monitor.source, null);
    assert.equal(running.controller.getSnapshot().status, "DISARMED");
    assert.equal(running.controller.getSnapshot().authorizedSourceName, null);
    running.controller.destroy();
});

for (const kind of ["bootstrap", "existing", "new"]) {
    test(`three fresh documents persist source and armed through production UI: ${kind}`, async () => {
        const shared = storage();
        if (kind === "existing") { const seed = await page(shared); seed.saveLive(); seed.destroy(); }
        const a = await page(shared);
        if (kind === "new") a.saveLive();
        const id = kind === "bootstrap" ? "primary-live" : "live-selected-1";
        a.click(id); a.saveSchedule(id);
        assert.deepEqual(JSON.parse(shared.getItem(KEY)), { version: 1, armed: false, authorizedSourceId: id });
        a.destroy();
        const b = await page(shared); const liveB = b.startControl();
        assert.equal(liveB.controller.getSnapshot().authorizedSourceId, id);
        liveB.controlNodes["dominant-live-armed"].checked = true;
        liveB.controlNodes["dominant-live-armed"].dispatch("change");
        const expected = { version: 1, armed: true, authorizedSourceId: id };
        assert.deepEqual(JSON.parse(shared.getItem(KEY)), expected);
        assert.ok(b.records.some(r => r.event === "AUTOLIVE_AUTH_WRITE" &&
            r.fields.armed === true && r.fields.authorizedSourceId === id &&
            r.fields.writeSucceeded === true && r.fields.readBackSucceeded === true));
        b.destroy();
        const c = await page(shared, { hydrate: false });
        assert.deepEqual(c.config.getSnapshot(), { armed: true, authorizedSourceId: id });
        const liveC = c.startControl();
        c.catalog.initialize(definition);
        assert.deepEqual(JSON.parse(shared.getItem(KEY)), expected);
        assert.equal(liveC.controller.getSnapshot().armed, true);
        assert.equal(liveC.controller.getSnapshot().authorizedSourceId, id);
        assert.equal(liveC.controlNodes["dominant-live-armed"].checked, true);
        assert.notEqual(liveC.controlNodes["dominant-live-source"].textContent, "NO AUTHORIZED SOURCE");
        for (const phase of ["CONFIG_LOAD", "CATALOG_RESOLUTION"]) {
            assert.ok(c.records.some(r => r.event === "AUTOLIVE_AUTH_READ" && r.fields.phase === phase &&
                r.fields.armed === true && r.fields.authorizedSourceId === id));
        }
        c.destroy();
    });
}

test("stale Control instance arming must preserve a Scheduler source write", async () => {
    const shared = storage(); const control = await page(shared); const running = control.startControl();
    const scheduler = await page(shared); scheduler.click("primary-live");
    running.controlNodes["dominant-live-armed"].checked = true;
    running.controlNodes["dominant-live-armed"].dispatch("change");
    assert.deepEqual(JSON.parse(shared.getItem(KEY)), { version: 1, armed: true, authorizedSourceId: "primary-live" });
    control.destroy(); scheduler.destroy();
});

test("stale Scheduler source write must preserve a Control armed write", async () => {
    const shared = storage(); const scheduler = await page(shared); const control = await page(shared);
    const running = control.startControl(); running.controlNodes["dominant-live-armed"].checked = true;
    running.controlNodes["dominant-live-armed"].dispatch("change");
    scheduler.click("primary-live");
    assert.deepEqual(JSON.parse(shared.getItem(KEY)), { version: 1, armed: true, authorizedSourceId: "primary-live" });
    control.destroy(); scheduler.destroy();
});

test("failed armed write restores the visible checkbox to the confirmed state", async () => {
    const shared = storage(); const control = await page(shared); const running = control.startControl();
    shared.setItem = () => { throw new Error("storage denied"); };
    running.controlNodes["dominant-live-armed"].checked = true;
    running.controlNodes["dominant-live-armed"].dispatch("change");
    assert.equal(running.controlNodes["dominant-live-armed"].checked, false);
    assert.equal(running.controlNodes["dominant-live-status"].textContent, "CONFIG NOT SAVED");
    assert.equal(shared.getItem(KEY), null); control.destroy();
});

test("armed and exact selection survive Control → Scheduler → fresh Control", async () => {
    const shared = storage(); const first = await page(shared); first.saveLive();
    first.click("primary-live"); const running = first.startControl();
    running.controlNodes["dominant-live-armed"].checked = true;
    running.controlNodes["dominant-live-armed"].dispatch("change"); first.destroy();
    const scheduler = await page(shared); scheduler.click("live-selected-1");
    scheduler.saveSchedule("live-selected-1"); scheduler.destroy();
    const next = await page(shared); const final = next.startControl();
    assert.deepEqual(next.config.getSnapshot(), { armed: true, authorizedSourceId: "live-selected-1" });
    assert.equal(final.controlNodes["dominant-live-armed"].checked, true);
    assert.equal(final.monitor.source.id, "live-selected-1"); next.destroy();
});

test("config constructors are read-only and never overwrite valid policy with defaults", () => {
    const shared = storage(); const first = new DominantLiveConfig({ storage: shared, eventTarget: null });
    const second = new DominantLiveConfig({ storage: shared, eventTarget: null });
    assert.equal(shared.writes.length, 0);
    first.setAuthorizedSourceId("primary-live"); first.setArmed(true);
    const before = shared.getItem(KEY); const writes = shared.writes.length;
    const third = new DominantLiveConfig({ storage: shared, eventTarget: null });
    assert.equal(shared.writes.length, writes); assert.equal(shared.getItem(KEY), before);
    assert.deepEqual(third.getSnapshot(), { armed: true, authorizedSourceId: "primary-live" });
    first.destroy(); second.destroy(); third.destroy();
});

test("unreadable storage cannot turn a stale mutation into a destructive default write", async () => {
    const shared = storage(); const scheduler = await page(shared); const stale = await page(shared);
    scheduler.click("primary-live"); const before = shared.getItem(KEY); const writes = shared.writes.length;
    shared.getItem = () => { throw new Error("read unavailable"); };
    stale.config.setArmed(true);
    assert.equal(shared.values.get(KEY), before); assert.equal(shared.writes.length, writes);
    assert.equal(stale.config.lastWrite.reason, "STORAGE_READ_FAILED");
    stale.destroy(); scheduler.destroy();
});

test("armed readback failure restores checkbox and reports both verification outcomes", async () => {
    const shared = storage(); const control = await page(shared); control.click("primary-live");
    const running = control.startControl(); shared.setItem = () => {};
    running.controlNodes["dominant-live-armed"].checked = true;
    running.controlNodes["dominant-live-armed"].dispatch("change");
    assert.equal(running.controlNodes["dominant-live-armed"].checked, false);
    assert.equal(running.controlNodes["dominant-live-status"].textContent, "CONFIG NOT SAVED");
    assert.ok(control.records.some(r => r.event === "AUTOLIVE_AUTH_WRITE" &&
        r.fields.writeSucceeded === true && r.fields.readBackSucceeded === false && r.fields.requestedArmed === true));
    assert.deepEqual(JSON.parse(shared.getItem(KEY)), { version: 1, armed: false, authorizedSourceId: "primary-live" });
    control.destroy();
});

test("navigation links preserve origin and diagnostics record only a safe origin", async () => {
    const control = await readFile(new URL("../public/control/index.html", import.meta.url), "utf8");
    const schedule = await readFile(new URL("../public/control/schedule/index.html", import.meta.url), "utf8");
    assert.match(control, /href="\.\/schedule\/"/);
    const returnLink = schedule.match(/href="([^"]+)"[^>]*>[^<]*(?:REGIA|Regia|CONTROL|Control)/);
    assert.ok(returnLink, "Schedule return link");
    const origin = "http://127.0.0.1:8080";
    assert.equal(new URL("./schedule/", `${origin}/control/`).origin, origin);
    assert.equal(new URL(returnLink[1], `${origin}/control/schedule/`).origin, origin);
    const records = []; const log = new AutoLiveAuthorizationDiagnostics({ enabled: true,
        output: (event, fields) => records.push(fields) });
    log.record("AUTOLIVE_AUTH_READ", { origin });
    log.record("AUTOLIVE_AUTH_READ", { origin: "http://user:secret@127.0.0.1:8080/" });
    assert.equal(records[0].origin, origin); assert.equal(records[1].origin, null);
});
