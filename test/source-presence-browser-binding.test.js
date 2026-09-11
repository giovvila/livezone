import test from "node:test";
import assert from "node:assert/strict";
import SourcePresenceMonitor from "../public/js/studio/SourcePresenceMonitor.js";
import DominantLiveConfig, { DOMINANT_LIVE_STORAGE_KEY as KEY } from "../public/js/studio/DominantLiveConfig.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import DominantLiveUI from "../public/js/ui/DominantLiveUI.js";
import StudioLiveSourcesUI from "../public/js/ui/StudioLiveSourcesUI.js";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const source = { id: "primary-live", kind: "hls", name: "MAIN LIVE", enabled: true,
    url: "http://127.0.0.1:8888/test/index.m3u8", sceneIds: [] };

// Model Window's receiver-sensitive native functions at the actual default-DI
// boundary. Arrow-function injections and Node timers cannot expose this error.
async function withWindowFunctions(run) {
    const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
        fetch: globalThis.fetch };
    const timers = new Map(); const requests = []; const calls = []; let next = 0;
    function requireWindow(receiver, method) {
        calls.push({ method, validReceiver: receiver === globalThis });
        if (receiver !== globalThis) throw new TypeError(`Illegal invocation: ${method}`);
    }
    globalThis.setTimeout = function (callback, delay) {
        requireWindow(this, "setTimeout"); timers.set(++next, { callback, delay }); return next;
    };
    globalThis.clearTimeout = function (id) {
        requireWindow(this, "clearTimeout"); timers.delete(id);
    };
    globalThis.fetch = function (url, options) {
        requireWindow(this, "fetch");
        return new Promise(resolve => requests.push({ url, signal: options.signal,
            finish: () => resolve({ ok: true, json: async () => ({ state: "offline",
                health: { publisherPresent: false }, playbackHlsUrl: source.url }) }) }));
    };
    try { await run({ timers, requests, calls }); }
    finally { Object.assign(globalThis, original); }
}

test("default clearTimeout keeps its Window receiver before start and on repeated stop/destroy", async () => {
    await withWindowFunctions(async ({ calls, timers }) => {
        const monitor = new SourcePresenceMonitor();
        monitor.stop(); monitor.stop(); monitor.selectSource(null); monitor.destroy(); monitor.destroy();
        assert.equal(monitor.source, null); assert.equal(timers.size, 0);
        assert.ok(calls.length >= 10);
        assert.ok(calls.every(call => call.method === "clearTimeout" && call.validReceiver));
    });
});

test("default setTimeout keeps its Window receiver at poll deadline and next poll", async () => {
    await withWindowFunctions(async ({ requests, timers, calls }) => {
        const monitor = new SourcePresenceMonitor();
        // Exercise setTimeout separately so a clearTimeout failure cannot mask it.
        monitor.source = source;
        const pending = monitor.poll(monitor.lifecycle);
        if (!requests.length) { await pending; assert.fail("poll must issue a request"); }
        requests[0].finish(); await pending;
        assert.deepEqual([...timers.values()].map(timer => timer.delay), [1000]);
        assert.equal(calls.filter(call => call.method === "setTimeout").length, 2);
        assert.ok(calls.every(call => call.validReceiver)); monitor.destroy();
        assert.equal(timers.size, 0);
    });
});

test("source replacement and partial in-flight cleanup abort safely and invalidate old work", async () => {
    await withWindowFunctions(async ({ requests, timers, calls }) => {
        const monitor = new SourcePresenceMonitor(); const observed = [];
        monitor.subscribe(snapshot => observed.push(snapshot));
        monitor.selectSource(source); const firstLifecycle = monitor.lifecycle;
        monitor.selectSource({ ...source, id: "live-custom" });
        assert.ok(monitor.lifecycle > firstLifecycle);
        assert.equal(requests[0].signal.aborted, true);
        monitor.stop(); monitor.stop();
        assert.equal(requests[1].signal.aborted, true);
        requests.forEach(request => request.finish()); await flush();
        assert.equal(observed.length, 1); assert.equal(timers.size, 0);
        monitor.selectSource(source); requests[2].finish(); await flush();
        assert.equal(monitor.getSnapshot().sourceId, source.id);
        monitor.destroy(); monitor.destroy();
        assert.equal(monitor.listeners.size, 0); assert.equal(timers.size, 0);
        assert.ok(calls.every(call => call.validReceiver));
    });
});

test("explicit timer injections retain their caller-provided binding", async () => {
    const owner = { timers: new Map(), next: 0,
        set(callback, delay) { assert.equal(this, owner); this.timers.set(++this.next, { callback, delay }); return this.next; },
        clear(id) { assert.equal(this, owner); this.timers.delete(id); } };
    const monitor = new SourcePresenceMonitor({ setTimer: owner.set.bind(owner),
        clearTimer: owner.clear.bind(owner), fetchImplementation: async () => ({ ok: false }) });
    monitor.selectSource(source); await flush(); monitor.destroy();
    assert.equal(owner.timers.size, 0);
});

for (const id of ["primary-live", "live-custom"]) {
    test(`real monitor startup reaches UI after immediate config subscription and reconstruction: ${id}`, async () => {
        await withWindowFunctions(async ({ requests, calls, timers }) => {
            const values = new Map(); const storage = { getItem: key => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, value) };
            const selected = { ...source, id, name: id === "primary-live" ? "MAIN LIVE" : "CUSTOM LIVE" };
            const catalog = { getSources: () => [selected], getDefinition: () => null,
                subscribe(listener) { listener([selected]); return () => {}; } };
            const scheduleConfig = new DominantLiveConfig({ storage, eventTarget: null });
            const schedulerUI = new StudioLiveSourcesUI(null, catalog, null, scheduleConfig);
            schedulerUI.show = () => {};
            schedulerUI.handleClick({ target: { closest: () => ({ dataset: { action: "authorize", id } }) } });
            assert.equal(JSON.parse(storage.getItem(KEY)).authorizedSourceId, id);
            scheduleConfig.destroy();
            for (let document = 0; document < 2; document++) {
                const records = [];
                const config = new DominantLiveConfig({ storage, eventTarget: null,
                    diagnostics: { record: (event, fields) => records.push({ event, fields }) } });
                const monitor = new SourcePresenceMonitor();
                const controller = new DominantLiveController({ config, catalog, monitor,
                    scheduler: { getSnapshot: () => ({ enabled: false }), subscribe: () => () => {} },
                    command: {}, eventBus: { on() {}, off() {} } });
                assert.equal(controller.start(), true);
                assert.equal(controller.start(), false);
                // The real synchronous subscription has already called selectSource/stop/poll.
                assert.equal(monitor.source.id, id);
                assert.equal(controller.getSnapshot().authorizedSourceId, id);
                const toggle = { setAttribute() {}, addEventListener(_type, callback) { this.change = callback; },
                    removeEventListener() {} }; const status = {}; const label = {};
                const nodes = { "#dominant-live-armed": toggle, "#dominant-live-status": status,
                    "#dominant-live-source": label };
                const ui = new DominantLiveUI({ config, controller,
                    root: { dataset: {}, querySelector: selector => nodes[selector] } });
                assert.equal(ui.start(), true);
                if (document === 0) { toggle.checked = true; toggle.change(); }
                assert.equal(toggle.checked, true); assert.equal(label.textContent, selected.name);
                assert.notEqual(label.textContent, "NO AUTHORIZED SOURCE");
                assert.deepEqual(JSON.parse(storage.getItem(KEY)), { version: 1, armed: true, authorizedSourceId: id });
                assert.ok(records.some(record => record.event === "AUTOLIVE_AUTH_READ"));
                assert.ok(records.some(record => record.event === "AUTOLIVE_AUTH_CONTROLLER"));
                requests.at(-1).finish(); await flush();
                ui.destroy(); controller.destroy(); config.destroy();
                assert.equal(timers.size, 0);
            }
            assert.ok(calls.every(call => call.validReceiver));
        });
    });
}
