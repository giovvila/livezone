import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import DominantLiveConfig, { DOMINANT_LIVE_STORAGE_KEY } from
    "../public/js/studio/DominantLiveConfig.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import Events from "../public/js/core/Events.js";

class Target { constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type) { this.listeners.delete(type); }
    dispatch(type, value) { this.listeners.get(type)?.(value); } }
class Bus { constructor() { this.listeners = new Map(); }
    on(type, fn) { this.listeners.set(type, fn); }
    off(type) { this.listeners.delete(type); }
    emit(type, value) { this.listeners.get(type)?.(value); } }
class Monitor { constructor() { this.snapshot = { sourceId: null, state: "IDLE" }; this.listeners = new Set(); }
    subscribe(fn) { this.listeners.add(fn); fn(this.snapshot); return () => this.listeners.delete(fn); }
    selectSource(source) { this.source = source; this.emit({ sourceId: source.id, state: "CHECKING" }); }
    stop() { this.source = null; this.emit({ sourceId: null, state: "IDLE" }); }
    destroy() { this.destroyed = true; this.listeners.clear(); }
    emit(value) { this.snapshot = value; this.listeners.forEach((fn) => fn(value)); } }
function timers() { let next = 1; const values = new Map(); return {
    set: (fn, delay) => { const id = next++; values.set(id, { fn, delay }); return id; },
    clear: (id) => values.delete(id), run: (delay) => { const entry = [...values.entries()]
        .find(([, value]) => value.delay === delay); if (!entry) return false;
        values.delete(entry[0]); entry[1].fn(); return true; }, size: () => values.size }; }
function harness({ armed = true, authorizedSourceId = "live-a", enabled = true,
    schedulerEnabled = true, hasCurrentItem = true, commandResult = { ok: true },
    sceneIds = ["scene-live-a"], beginMode = "context", commandThrows = false } = {}) {
    const setting = { armed, authorizedSourceId }; const configListeners = new Set();
    const config = { getSnapshot: () => Object.freeze({ ...setting }), subscribe(fn) {
        configListeners.add(fn); fn(setting); return () => configListeners.delete(fn); },
    setArmed(value) { setting.armed = value; configListeners.forEach((fn) => fn(setting)); },
    setAuthorizedSourceId(value) { setting.authorizedSourceId = value;
        configListeners.forEach((fn) => fn(setting)); } };
    const sources = [{ id: "live-a", name: "LIVE A", kind: "hls", url: "https://a/live.m3u8",
        enabled, sceneIds }]; const catalogListeners = new Set();
    const catalog = { getSources: () => sources, subscribe(fn) { catalogListeners.add(fn);
        fn(sources); return () => catalogListeners.delete(fn); },
    getDefinition(id) { return id === "scene-live-a" ? { id } : null; } };
    const schedulerListeners = new Set(); const schedulerSnapshot = { enabled: schedulerEnabled,
        activeItem: schedulerEnabled && hasCurrentItem ? { id: "item-a" } : null,
        interruptionContext: null, status: schedulerEnabled ? hasCurrentItem ? "ACTIVE" : "ARMED" : "OFF" };
    const scheduler = { begins: [], ends: [], getSnapshot: () => schedulerSnapshot,
        subscribe(fn) { schedulerListeners.add(fn); fn(schedulerSnapshot); return () => schedulerListeners.delete(fn); },
        getInterruptionEligibility({ allowEmptySlot = false } = {}) { return schedulerSnapshot.interruptionContext
            ? { allowed: false, reason: "EXISTING_INTERRUPTION" }
            : !schedulerSnapshot.activeItem && !allowEmptySlot ? { allowed: false, reason: "NO_ACTIVE_ITEM" }
                : !schedulerSnapshot.activeItem ? { allowed: true, reason: null, mode: "EMPTY_SLOT" }
                : { allowed: true, reason: null }; },
        beginInterruption(request) { this.begins.push(request); if (beginMode === "throw") throw new Error("begin");
            if (beginMode === "null") return null;
            if (!schedulerSnapshot.activeItem && request.allowEmptySlot) return Object.freeze({
                interruptedItemId: null, resumePolicy: null, kind: "empty-slot",
                origin: request.origin, sessionId: request.sessionId });
            return schedulerEnabled
            ? Object.freeze({ interruptedItemId: "item-a", resumePolicy: "RESUME_FIXED",
                kind: "external", origin: request.origin, sessionId: request.sessionId }) : null; },
        endInterruption(now) { this.ends.push(now); return {}; } };
    const monitor = new Monitor(); const clockTimers = timers(); const bus = new Bus();
    const command = { stateManager: { getProgramSceneId: () => "program-scene" },
        transitionCoordinator: { isBusy: () => commandResult?.reason === "transition-busy" },
        calls: [], async execute(request) { this.calls.push(request);
            if (commandThrows) throw new Error("command"); return commandResult; } };
    const controller = new DominantLiveController({ config, catalog, monitor, scheduler,
        command, eventBus: bus, clock: () => 10000, setTimer: clockTimers.set,
        clearTimer: clockTimers.clear, uuidFactory: () => "session-1" });
    controller.start(); return { controller, config, catalog, sources, scheduler, monitor,
        timers: clockTimers, bus, command, setting, schedulerSnapshot, catalogListeners };
}

test("dominant config defaults safely and validates persisted/cross-tab input", () => {
    const values = new Map(); const storage = { getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, value) }; const target = new Target();
    const config = new DominantLiveConfig({ storage, eventTarget: target });
    assert.deepEqual(config.getSnapshot(), { armed: false, authorizedSourceId: null });
    config.setAuthorizedSourceId("live-a"); config.setArmed(true);
    assert.deepEqual(JSON.parse(values.get(DOMINANT_LIVE_STORAGE_KEY)), {
        version: 1, armed: true, authorizedSourceId: "live-a" });
    config.setAuthorizedSourceId("live-b");
    assert.equal(config.getSnapshot().authorizedSourceId, "live-b");
    target.dispatch("storage", { key: DOMINANT_LIVE_STORAGE_KEY,
        newValue: JSON.stringify({ version: 1, armed: true, authorizedSourceId: "javascript:x" }) });
    assert.deepEqual(config.getSnapshot(), { armed: false, authorizedSourceId: null });
    target.dispatch("storage", { key: DOMINANT_LIVE_STORAGE_KEY, newValue: "{" });
    assert.equal(config.getSnapshot().armed, false); config.destroy();
});

test("ONLINE stabilization starts one identified dominant session", async () => {
    const h = harness(); h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.controller.getSnapshot().status, "ARMED — ONLINE/STABILIZING");
    assert.equal(h.controller.getSnapshot().diagnostics.stableTimerActive, true);
    assert.equal(h.controller.getSnapshot().diagnostics.waitingReason, "WAITING_STABILIZING");
    assert.equal(h.controller.getSnapshot().diagnostics.resolvedSceneId, "scene-live-a");
    assert.equal(h.controller.getSnapshot().diagnostics.schedulerStatus, "ACTIVE");
    assert.equal(h.controller.getSnapshot().diagnostics.activeItemId, "item-a");
    assert.equal(typeof h.controller.getSnapshot().diagnostics.generation, "number");
    assert.equal(h.command.calls.length, 0); assert.equal(h.timers.run(3000), true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.scheduler.begins.length, 1); assert.equal(h.command.calls.length, 1);
    assert.deepEqual(h.command.calls[0], { sceneId: "scene-live-a", transition: "CUT",
        origin: "dominant-live" }); assert.equal(h.controller.getSnapshot().status, "ON AIR");
    assert.equal(h.controller.getSnapshot().diagnostics.beginResult, "RETURNED_CONTEXT");
    assert.equal(h.controller.getSnapshot().diagnostics.commandResult, "SUCCESS");
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.scheduler.begins.length, 1);
});

test("short ONLINE cancels, short loss survives, sustained loss recovers once", async () => {
    const h = harness(); h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" }); assert.equal(h.timers.size(), 0);
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); assert.equal(h.scheduler.ends.length, 0);
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" }); h.timers.run(3000);
    assert.equal(h.scheduler.ends.length, 1); assert.equal(h.controller.getSnapshot().session, null);
});

test("later ONLINE after initial OFFLINE enters stabilization and acquires Program", async () => {
    const h = harness(); h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.command.calls.length, 0); assert.equal(h.timers.size(), 0);
    h.monitor.emit({ sourceId: "live-a", state: "CHECKING" });
    assert.equal(h.controller.getSnapshot().status, "ARMED — CHECKING");
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.controller.getSnapshot().status, "ARMED — ONLINE/STABILIZING");
    assert.equal(h.timers.run(3000), true); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.scheduler.begins.length, 1); assert.equal(h.command.calls.length, 1);
});

test("stable ONLINE acquires Program through an explicit empty-slot Scheduler context", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.controller.getSnapshot().status, "ARMED — ONLINE/STABILIZING");
    assert.equal(h.timers.run(3000), true); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(h.scheduler.begins[0], { origin: "dominant-live", sessionId: "session-1",
        allowEmptySlot: true });
    assert.equal(h.command.calls.length, 1); assert.equal(h.controller.getSnapshot().status, "ON AIR");
    assert.equal(h.controller.getSnapshot().diagnostics.contextType, "EMPTY_SLOT");
    assert.equal(h.controller.getSnapshot().diagnostics.commandResult, "SUCCESS");
});

test("manual TAKE releases ownership and requires OFFLINE edge before reacquire", async () => {
    const h = harness(); h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve(); h.bus.emit(Events.STUDIO_PROGRAM_CHANGED,
        { source: "operator" }); assert.equal(h.scheduler.ends.length, 1);
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); assert.equal(h.timers.size(), 0);
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); assert.equal(h.timers.size(), 1);
});

test("manual TAKE closes empty-slot dominant ownership and preserves anti-reacquire latch", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.controller.getSnapshot().diagnostics.contextType, "EMPTY_SLOT");
    h.bus.emit(Events.STUDIO_PROGRAM_CHANGED, { source: "operator" });
    assert.equal(h.scheduler.ends.length, 1); assert.equal(h.controller.getSnapshot().status, "ARMED — BLOCKED");
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); assert.equal(h.timers.size(), 0);
});

test("DISARM cancels waiting/active work and Scheduler OFF never starts", async () => {
    const waiting = harness(); waiting.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    waiting.config.setArmed(false); assert.equal(waiting.timers.size(), 0);
    const active = harness(); active.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    active.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    active.config.setArmed(false); assert.equal(active.scheduler.ends.length, 1);
    const off = harness({ schedulerEnabled: false }); off.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(off.timers.size(), 0); assert.equal(off.controller.getSnapshot().status, "WAITING FOR SCHEDULER");
});

test("activation failure rolls back, latches, and does not retry-loop", async () => {
    const h = harness({ commandResult: { ok: false, reason: "prepare-failed" } });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve(); assert.equal(h.scheduler.ends.length, 1);
    assert.equal(h.controller.getSnapshot().status, "ERROR");
    assert.equal(h.controller.getSnapshot().diagnostics.lastError, "prepare-failed");
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); assert.equal(h.timers.size(), 0);
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.notEqual(h.controller.getSnapshot().status, "ERROR");
    assert.equal(h.controller.getSnapshot().diagnostics.lastError, "prepare-failed");
});

test("empty-slot activation failure closes Scheduler context and latches", async () => {
    const h = harness({ hasCurrentItem: false,
        commandResult: { ok: false, reason: "prepare-failed" } });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.scheduler.ends.length, 1); assert.equal(h.controller.getSnapshot().status, "ERROR");
    assert.equal(h.controller.getSnapshot().diagnostics.contextType, "EMPTY_SLOT");
});

test("stable ONLINE records one deterministic acquisition attempt per generation", async () => {
    const h = harness(); h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.scheduler.begins.length, 1);
    const diagnostics = h.controller.getSnapshot().diagnostics;
    assert.equal(diagnostics.attemptGeneration, diagnostics.generation);
    assert.equal(diagnostics.authorizedSourceIdAtAttempt, "live-a");
    assert.equal(diagnostics.resolvedSceneId, "scene-live-a");
    assert.equal(diagnostics.currentProgramSceneId, "program-scene");
});

test("missing scene and changed generation produce explicit blocks without silent READY", async () => {
    const missing = harness({ sceneIds: [] });
    missing.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); missing.timers.run(3000);
    await Promise.resolve(); assert.equal(missing.controller.getSnapshot().status, "ARMED — BLOCKED");
    assert.equal(missing.controller.getSnapshot().diagnostics.blockReason, "SCENE_MISSING");
    const stale = harness(); await stale.controller.begin(stale.sources[0], stale.controller.generation - 1);
    assert.equal(stale.controller.getSnapshot().diagnostics.blockReason, "GENERATION");
});

test("every acquisition precondition exits with an explicit block reason", async () => {
    const cases = [
        ["ARMED_FALSE", (h) => { h.setting.armed = false; }, (h) => h.sources[0]],
        ["LATCHED", (h) => { h.controller.latched = true; }, (h) => h.sources[0]],
        ["SOURCE_INVALID", () => {}, () => ({ id: "other", sceneIds: ["scene-live-a"] })],
        ["SCHEDULER_DISABLED", (h) => { h.schedulerSnapshot.enabled = false; }, (h) => h.sources[0]],
        ["EXISTING_INTERRUPTION", (h) => { h.schedulerSnapshot.interruptionContext = { id: "x" }; },
            (h) => h.sources[0]]
    ];
    for (const [reason, arrange, source] of cases) {
        const h = harness(); arrange(h); await h.controller.begin(source(h), h.controller.generation);
        assert.equal(h.controller.getSnapshot().diagnostics.blockReason, reason);
        assert.notEqual(h.controller.getSnapshot().status, "ARMED — READY");
    }
});

test("beginInterruption null and exception are observable", async () => {
    for (const [mode, reason, result] of [["null", "BEGIN_RETURNED_NULL", "RETURNED_NULL"],
        ["throw", "BEGIN_THREW", "THREW"]]) {
        const h = harness({ beginMode: mode }); h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
        h.timers.run(3000); await Promise.resolve();
        assert.equal(h.controller.getSnapshot().status, "ARMED — BLOCKED");
        assert.equal(h.controller.getSnapshot().diagnostics.blockReason, reason);
        assert.equal(h.controller.getSnapshot().diagnostics.beginResult, result);
    }
});

test("Program command rejection and exception are observable and rolled back", async () => {
    const rejected = harness({ commandResult: { ok: false, reason: "transition-busy" } });
    rejected.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); rejected.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(rejected.controller.getSnapshot().diagnostics.commandResult, "REJECTED");
    assert.equal(rejected.controller.getSnapshot().diagnostics.blockReason, "transition-busy");
    const thrown = harness({ commandThrows: true });
    thrown.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); thrown.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(thrown.controller.getSnapshot().diagnostics.commandResult, "THREW");
    assert.equal(thrown.controller.getSnapshot().diagnostics.blockReason, "COMMAND_THREW");
});

test("disable revokes authorization and source edit replaces health generation", () => {
    const h = harness(); const first = h.monitor.source;
    h.sources[0] = { ...h.sources[0], name: "RENAMED", url: "https://b/live.m3u8" };
    h.catalogListeners.forEach((fn) => fn(h.sources)); assert.notEqual(h.monitor.source, first);
    h.sources[0] = { ...h.sources[0], enabled: false };
    h.catalogListeners.forEach((fn) => fn(h.sources)); assert.equal(h.setting.authorizedSourceId, null);
});

test("removed source and stale stabilization generation cannot acquire Program", async () => {
    const h = harness(); h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.sources.splice(0); h.catalogListeners.forEach((fn) => fn(h.sources));
    assert.equal(h.setting.authorizedSourceId, null); h.timers.run(3000);
    await Promise.resolve(); assert.equal(h.command.calls.length, 0);
});

test("Scheduler with no current item starts empty-slot stabilization", () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.timers.size(), 1); assert.equal(h.command.calls.length, 0);
    assert.equal(h.controller.getSnapshot().diagnostics.waitingReason, "WAITING_STABILIZING");
});

test("Dominant Live consumes restored Scheduler authority without reading persistence", async () => {
    const source = await readFile(new URL(
        "../public/js/studio/DominantLiveController.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /localStorage|scheduler\.runtime|SchedulerRuntimeState/);
    const h = harness({ schedulerEnabled: true });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.controller.getSnapshot().diagnostics.schedulerEnabled, true);
    assert.equal(h.timers.run(3000), true);
});

test("ONLINE pre-stabilization gates expose the first WAITING reason without begin", () => {
    const cases = [
        ["WAITING_ARMED_FALSE", { armed: false }],
        ["WAITING_SOURCE_INVALID", { authorizedSourceId: "missing" }],
        ["WAITING_SCHEDULER_DISABLED", { schedulerEnabled: false }]
    ];
    for (const [reason, options] of cases) {
        const h = harness(options); h.controller.health = { sourceId: "live-a", state: "ONLINE" };
        h.controller.evaluate(); const snapshot = h.controller.getSnapshot();
        assert.equal(snapshot.diagnostics.waitingReason, reason);
        assert.equal(snapshot.diagnostics.stableTimerActive, false);
        assert.equal(snapshot.diagnostics.beginResult, "NOT_CALLED");
        assert.equal(h.scheduler.begins.length, 0);
    }
    const interruption = harness(); interruption.schedulerSnapshot.interruptionContext = { id: "existing" };
    interruption.controller.health = { sourceId: "live-a", state: "ONLINE" };
    interruption.controller.evaluate();
    assert.equal(interruption.controller.getSnapshot().diagnostics.waitingReason,
        "WAITING_EXISTING_INTERRUPTION");
    assert.equal(interruption.timers.size(), 0); assert.equal(interruption.scheduler.begins.length, 0);
    const empty = harness({ hasCurrentItem: false });
    empty.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(empty.controller.getSnapshot().diagnostics.waitingReason, "WAITING_STABILIZING");
    assert.equal(empty.controller.getSnapshot().diagnostics.stableTimerActive, true);
});

test("autonomous HLS probe stays renderable inside the viewport", async () => {
    const css = await readFile(new URL("../public/css/studio.css", import.meta.url), "utf8");
    const rule = css.match(/\.dominant-live-health-surface\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(rule, /position:\s*fixed/);
    assert.match(rule, /left:\s*0/);
    assert.match(rule, /bottom:\s*0/);
    assert.match(rule, /width:\s*2px/);
    assert.match(rule, /height:\s*2px/);
    const opacity = Number(rule.match(/opacity:\s*([\d.]+)/)?.[1]);
    const zIndex = Number(rule.match(/z-index:\s*(-?\d+)/)?.[1]);
    assert.ok(opacity > 0 && opacity <= 0.01);
    assert.ok(zIndex >= 0);
    assert.match(rule, /pointer-events:\s*none/);
    assert.doesNotMatch(rule,
        /display:\s*none|visibility:\s*hidden|left:\s*-\d|opacity:\s*0(?:\D|$)|z-index:\s*-/);
});

test("autonomous HLS health becomes ONLINE only after surface readiness", async () => {
    const source = await readFile(new URL(
        "../public/js/studio/DominantLiveHealthConsumer.js", import.meta.url), "utf8");
    assert.match(source, /waitUntilReady\(\{ timeoutMs: 12000 \}\)\.then\(\(\) => \{/);
    assert.equal((source.match(/handlers\.online/g) || []).length, 2,
        "one initial readiness edge and one in-place recovery edge are allowed");
    assert.match(source, /usesVideoFrameCallback\s*&&\s*surface\.firstFramePresented/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    assert.match(source, /online\s*&&\s*health\.state\s*===\s*"stalled"/);
    assert.match(source, /handlers\.offline\(\{ recoverInPlace: true \}\)/);
    assert.match(source, /handlers\.offline\(\)/);
    assert.match(source, /degraded\s*&&\s*health\.state\s*===\s*"ready"/);
});

test("persistent dominant loss exposes grace then closes session exactly once", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
    assert.equal(h.controller.getSnapshot().diagnostics.lossTimerActive, true);
    assert.equal(h.scheduler.ends.length, 0);
    h.timers.run(3000);
    assert.equal(h.controller.getSnapshot().status, "RECOVERING");
    assert.equal(h.controller.getSnapshot().session, null);
    assert.equal(h.controller.getSnapshot().diagnostics.endResult, "CLOSED");
    assert.equal(h.scheduler.ends.length, 1);
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.scheduler.ends.length, 1);
});

test("persistent normal loss reacquires without latch after a new stable ONLINE edge", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE", generation: 1 });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    const firstSession = h.controller.getSnapshot().session;
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE", generation: 1 });
    h.timers.run(3000);
    assert.equal(h.controller.getSnapshot().session, null);
    assert.equal(h.controller.getSnapshot().diagnostics.latched, false);
    h.monitor.emit({ sourceId: "live-a", state: "CHECKING", generation: 2 });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE", generation: 2 });
    assert.equal(h.timers.run(3000), true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.controller.getSnapshot().status, "ON AIR");
    assert.notEqual(h.controller.getSnapshot().session, firstSession);
    assert.equal(h.scheduler.begins.length, 2);
    assert.equal(h.command.calls.length, 2);
});

test("Program command releases authoritative Program through Studio state", () => {
    let program = "live"; const releases = [];
    const command = new StudioProgramCommand({ stateManager: {
        getProgramSceneId: () => program,
        releaseProgram: (metadata) => { releases.push(metadata); program = null; return {}; }
    } });
    assert.deepEqual(command.release({ origin: "scheduler" }), {
        ok: true, changed: true, previousSceneId: "live" });
    assert.equal(program, null);
    assert.deepEqual(releases, [{ source: "scheduler", reason: "no-current-authority" }]);
});

function programCommandHarness({ programSceneId = null, transitionResult = true,
    prepareThrows = false } = {}) {
    const scenes = new Map([["live", { id: "live" }], ["old", { id: "old" }]]);
    const records = []; const state = { preview: null, program: programSceneId,
        getProgramSceneId() { return this.program; }, getPreviewSceneId() { return this.preview; },
        getScene(id) { return scenes.get(id) || null; },
        setPreviewScene(id) { this.preview = id; return { currentSceneId: id }; },
        take(metadata) { if (!this.preview || this.preview === this.program) return null;
            const incoming = this.preview; this.preview = this.program; this.program = incoming;
            records.push(metadata); return { currentSceneId: incoming, timestamp: "now" }; } };
    const renderer = { async prepareProgramScene() { if (prepareThrows) throw new Error("prepare");
            return { sceneId: "live" }; }, discardPreparedProgram() {}, cancelProgramTransition() {},
        captureProgramPreviewHandoff() {}, discardPreviewHandoff() {},
        async waitForProgramTransition() { return transitionResult; } };
    const coordinator = new StudioTransitionCoordinator({ studioStateManager: state,
        studioRenderer: renderer }); coordinator.start();
    const command = new StudioProgramCommand({ stateManager: state,
        catalog: { getDefinition: (id) => id === "live" ? { id, renderer: { kind: "source",
            sourceId: "source-live" } } : null, getSources: () => [{ id: "source-live", kind: "hls" }] },
        transitionCoordinator: coordinator });
    return { state, renderer, coordinator, command, records };
}

test("normal Program command CUT supports null Program to LIVE through the shared pipeline", async () => {
    const h = programCommandHarness();
    const result = await h.command.execute({ sceneId: "live", transition: "CUT",
        origin: "dominant-live" });
    assert.equal(result.ok, true); assert.equal(h.state.program, "live");
    assert.equal(h.state.preview, null); assert.deepEqual(h.records[0], {
        source: "dominant-live", reason: "scheduled-take" });
    assert.equal(result.diagnostics.programCommitted, true);
});

test("existing Program CUT and DISSOLVE retain normal swap semantics", async () => {
    for (const transition of ["CUT", "DISSOLVE"]) {
        const h = programCommandHarness({ programSceneId: "old" });
        const result = await h.command.execute({ sceneId: "live", transition,
            origin: "dominant-live" });
        assert.equal(result.ok, true); assert.equal(h.state.program, "live");
        assert.equal(h.state.preview, "old");
        assert.equal(result.transition, transition.toLowerCase());
    }
});

test("Program command exposes exact prepare and activation failures", async () => {
    const prepare = programCommandHarness({ prepareThrows: true });
    const prepareResult = await prepare.command.execute({ sceneId: "live", origin: "dominant-live" });
    assert.equal(prepareResult.reason, "program-prepare-threw");
    assert.equal(prepareResult.diagnostics.programCommitted, false);
    const activation = programCommandHarness({ transitionResult: false });
    const activationResult = await activation.command.execute({ sceneId: "live", origin: "dominant-live" });
    assert.equal(activationResult.reason, "program-activation-failed");
    assert.equal(activationResult.diagnostics.previewReady, true);
    assert.equal(activationResult.diagnostics.programCommitted, true);
});
