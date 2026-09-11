import test from "node:test";
import assert from "node:assert/strict";
import LiveSourceMonitor from "../public/js/studio/LiveSourceMonitor.js";
import { shareTechnicalLiveHealth } from "../public/js/studio/SharedLiveHealthConsumer.js";

const source = { id: "external", kind: "hls", url: "https://example.test/live.m3u8" };
function technical() {
    let snapshot = { sourceId: source.id, endpoint: source.url, state: "ONLINE" };
    const listeners = new Set();
    return { subscribe(fn) { listeners.add(fn); fn(snapshot); return () => listeners.delete(fn); },
        emit(value) { snapshot = value; listeners.forEach(fn => fn(snapshot)); } };
}
test("matching Technical ONLINE is reused without a second health readiness cycle or stale 12s timer", () => {
    const shared = technical(), timers = new Map(); let serial = 0, cold = 0;
    const monitor = new LiveSourceMonitor({
        consumerFactory: shareTechnicalLiveHealth(shared, () => { cold++; throw Error("unexpected cold player"); }),
        setTimer(fn) { timers.set(++serial, fn); return serial; }, clearTimer(id) { timers.delete(id); }
    });
    try {
        monitor.selectSource(source);
        assert.equal(monitor.getSnapshot().state, "ONLINE");
        assert.equal(cold, 0); assert.equal(timers.size, 0);
        shared.emit({ sourceId: source.id, endpoint: source.url, state: "CHECKING", uncertain: true });
        assert.equal(monitor.getSnapshot().uncertain, true);
        shared.emit({ sourceId: source.id, endpoint: source.url, state: "ONLINE" });
        assert.equal(monitor.getSnapshot().state, "ONLINE"); assert.equal(timers.size, 0);
    } finally { monitor.destroy(); }
});
test("Technical selection change starts an isolated fallback; returning observation releases it", () => {
    const shared = technical(); let starts = 0, destroys = 0, online = 0;
    const consumer = shareTechnicalLiveHealth(shared, () => ({ start() { starts++; }, destroy() { destroys++; } }))(
        source, { online() { online++; }, offline() {}, error() {} });
    consumer.start(); assert.equal(starts, 0); assert.equal(online, 1);
    shared.emit({ sourceId: "other", endpoint: source.url, state: "ONLINE" });
    assert.equal(starts, 1); assert.equal(online, 1);
    shared.emit({ sourceId: source.id, endpoint: source.url + "?different=1", state: "ONLINE" });
    assert.equal(starts, 1); assert.equal(online, 1);
    shared.emit({ sourceId: source.id, endpoint: source.url, state: "ONLINE" });
    assert.equal(destroys, 1); assert.equal(online, 2);
    consumer.destroy();
    shared.emit({ sourceId: source.id, endpoint: source.url, state: "ONLINE" });
    assert.equal(online, 2);
});
