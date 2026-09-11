import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import DominantLiveConfig, { DOMINANT_LIVE_STORAGE_KEY } from
    "../public/js/studio/DominantLiveConfig.js";
import DominantLiveController, { LOSS_GRACE_MS } from
    "../public/js/studio/DominantLiveController.js";
import LiveSourceMonitor from "../public/js/studio/LiveSourceMonitor.js";
import { createDominantLiveConsumerFactory, LIVE_PROGRESS_STALL_MS } from
    "../public/js/studio/DominantLiveHealthConsumer.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import Events from "../public/js/core/Events.js";
import SourcePresenceMonitor from "../public/js/studio/SourcePresenceMonitor.js";

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
    sceneIds = ["scene-live-a"], beginMode = "context", commandThrows = false,
    runtimeFallback = false, transitionBusy = false,
    programSceneId = "program-scene", previewSceneId = "preview-scene",
    programSourceKind = "media", programTime = 37, monitorFactory = null } = {}) {
    const setting = { armed, authorizedSourceId }; const configListeners = new Set();
    const config = { getSnapshot: () => Object.freeze({ ...setting }), subscribe(fn) {
        configListeners.add(fn); fn(setting); return () => configListeners.delete(fn); },
    setArmed(value) { setting.armed = value; configListeners.forEach((fn) => fn(setting)); },
    setAuthorizedSourceId(value) { setting.authorizedSourceId = value;
        configListeners.forEach((fn) => fn(setting)); } };
    const sources = [{ id: "live-a", name: "LIVE A", kind: "hls", url: "https://a/live.m3u8",
        enabled, sceneIds }, { id: "program-source", name: "PROGRAM", kind: programSourceKind,
        url: "https://a/program" }]; const catalogListeners = new Set();
    const catalog = { getSources: () => sources, subscribe(fn) { catalogListeners.add(fn);
        fn(sources); return () => catalogListeners.delete(fn); },
    getDefinition(id) { if (id === "program-scene") return { id,
        renderer: { kind: "source", sourceId: "program-source" } };
        return id === "scene-live-a" || id === "dominant-live-source-live-a"
            ? { id } : null; } };
    const targetResolver = runtimeFallback ? { resolve(target) { return target.id === "live-a"
        ? { sceneId: "dominant-live-source-live-a", definition: {
            id: "dominant-live-source-live-a", renderer: { kind: "source", sourceId: target.id }
        } } : null; } } : null;
    const schedulerListeners = new Set(); const schedulerSnapshot = { enabled: schedulerEnabled,
        activeItem: schedulerEnabled && hasCurrentItem ? { id: "item-a" } : null,
        interruptionContext: null, status: schedulerEnabled ? hasCurrentItem ? "ACTIVE" : "ARMED" : "OFF" };
    const scheduler = { begins: [], ends: [], enabled: schedulerEnabled,
        programTransportProvider: () => ({ sourceId: "program-source",
            currentTime: programTime, state: "playing" }), getSnapshot: () => schedulerSnapshot,
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
    const clockTimers = timers();
    const monitor = monitorFactory ? monitorFactory(clockTimers) : new Monitor();
    const bus = new Bus();
    let currentProgramSceneId = programSceneId; let currentPreviewSceneId = previewSceneId;
    const transitionListeners = new Set(); let busy = transitionBusy;
    const transitionCoordinator = { isBusy: () => busy, subscribe(fn) {
        transitionListeners.add(fn); return () => transitionListeners.delete(fn); },
    setBusy(value) { busy = value; transitionListeners.forEach((fn) => fn({
        state: value ? "running" : "idle" })); } };
    const stateManager = { getProgramSceneId: () => currentProgramSceneId,
        getPreviewSceneId: () => currentPreviewSceneId,
        getScene: (id) => id ? { id } : null,
        setPreviewScene: (id) => { currentPreviewSceneId = id; return {}; } };
    const command = { stateManager, transitionCoordinator,
        calls: [], async execute(request) { this.calls.push(request);
            if (commandThrows) throw new Error("command");
            if (commandResult?.ok) currentProgramSceneId = request.sceneId;
            return commandResult; }, release() { currentProgramSceneId = null;
            return { ok: true }; } };
    const controller = new DominantLiveController({ config, catalog, monitor, scheduler,
        targetResolver,
        command, eventBus: bus, clock: () => 10000, setTimer: clockTimers.set,
        clearTimer: clockTimers.clear, uuidFactory: () => "session-1" });
    controller.start(); return { controller, config, catalog, sources, scheduler, monitor,
        timers: clockTimers, bus, command, stateManager, transitionCoordinator, setting,
        schedulerSnapshot, catalogListeners };
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
        origin: "dominant-live", canCommit: h.command.calls[0].canCommit, livePreroll: h.command.calls[0].livePreroll, beforeCommit: null });
    assert.equal(h.command.calls[0].canCommit(), true);
    assert.equal(h.controller.getSnapshot().status, "ON AIR");
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
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" }); h.timers.run(LOSS_GRACE_MS);
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
    assert.equal(missing.controller.getSnapshot().diagnostics.blockReason, "TARGET_UNAVAILABLE");
    const stale = harness(); await stale.controller.begin(stale.sources[0], stale.controller.generation - 1);
    assert.equal(stale.command.calls.length, 0);
    assert.equal(stale.controller.getSnapshot().diagnostics.beginAttempted, false);
});

test("authorized LIVE Source without Scene uses deterministic runtime-only target", async () => {
    const h = harness({ sceneIds: [], runtimeFallback: true });
    const originalSceneIds = [...h.sources[0].sceneIds];
    assert.equal(h.controller.getSnapshot().diagnostics.resolvedTarget, "runtime-source");
    assert.equal(h.controller.getSnapshot().diagnostics.resolvedSceneId,
        "dominant-live-source-live-a");
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(h.command.calls[0], { sceneId: "dominant-live-source-live-a",
        transition: "CUT", origin: "dominant-live", canCommit: h.command.calls[0].canCommit, livePreroll: h.command.calls[0].livePreroll, beforeCommit: null });
    assert.deepEqual(h.sources[0].sceneIds, originalSceneIds);
    assert.notEqual(h.controller.getSnapshot().diagnostics.blockReason, "SCENE_MISSING");
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
        "../public/js/studio/LiveHlsHealthConsumer.js", import.meta.url), "utf8");
    assert.match(source, /waitUntilReady\(\{ timeoutMs: 12000 \}\)\.then\(\(\) => \{/);
    assert.equal((source.match(/handlers\.online/g) || []).length, 1,
        "initial readiness and recovery share the advancing-playback gate");
    assert.match(source, /usesVideoFrameCallback\s*&&\s*surface\.firstFramePresented/);
    assert.doesNotMatch(source, /setInterval/);
    assert.match(source, /timeupdate/);
    assert.match(source, /progressTimer/);
    assert.match(source, /online\s*&&\s*health\.state\s*===\s*"stalled"/);
    assert.match(source, /handlers\.offline\(\{ recoverInPlace: true \}\)/);
    assert.match(source, /handlers\.offline\(\)/);
    assert.match(source, /currentTime <= lastProgressTime/);
});

test("real dominant health consumer converts a frozen decoded frame into OFFLINE", async () => {
    const previousDocument = globalThis.document;
    const clockTimers = timers();
    const video = new EventTarget();
    Object.assign(video, { readyState: 2, currentTime: 10, videoWidth: 1920,
        videoHeight: 1080, muted: true, defaultMuted: true, paused: false,
        ended: false, canPlayType: () => "probably", play: async () => {}, pause() {},
        setAttribute() {}, removeAttribute() {}, load() {}, remove() {} });
    const status = { remove() {} };
    globalThis.document = { createElement: (tagName) => tagName === "video" ? video : status };
    const root = { replaceChildren() {}, appendChild() {} };
    const states = [];
    try {
        const consumer = createDominantLiveConsumerFactory(root, () => {}, {
            setTimer: clockTimers.set, clearTimer: clockTimers.clear
        })({ id: "live-a", url: "/live.m3u8" }, {
            online: () => states.push("ONLINE"),
            offline: () => states.push("OFFLINE"),
            error: () => states.push("ERROR")
        });
        await consumer.start();
        video.dispatchEvent(new Event("loadeddata"));
        await Promise.resolve(); await Promise.resolve();
        assert.deepEqual(states, [], "one decoded frame is not live progression");
        video.currentTime = 11;
        video.dispatchEvent(new Event("timeupdate"));
        assert.deepEqual(states, ["ONLINE"]);
        assert.equal(clockTimers.run(LIVE_PROGRESS_STALL_MS), true);
        assert.deepEqual(states, ["ONLINE", "OFFLINE"]);
        video.dispatchEvent(new Event("canplay"));
        video.dispatchEvent(new Event("timeupdate"));
        assert.deepEqual(states, ["ONLINE", "OFFLINE"], "unchanged cached frame is not recovery");
        video.currentTime = 12;
        video.dispatchEvent(new Event("timeupdate"));
        assert.deepEqual(states, ["ONLINE", "OFFLINE", "ONLINE"]);
        consumer.destroy();
        video.currentTime = 13;
        video.dispatchEvent(new Event("timeupdate"));
        assert.deepEqual(states, ["ONLINE", "OFFLINE", "ONLINE"]);
        assert.equal(clockTimers.size(), 0);
    }
    finally { globalThis.document = previousDocument; }
});

test("persistent dominant loss exposes grace then closes session exactly once", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" }); h.timers.run(3000);
    await Promise.resolve(); await Promise.resolve();
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
    assert.equal(h.controller.getSnapshot().diagnostics.lossTimerActive, true);
    assert.equal(h.scheduler.ends.length, 0);
    h.timers.run(LOSS_GRACE_MS);
    assert.equal(h.controller.getSnapshot().status, "RECOVERING");
    assert.equal(h.controller.getSnapshot().session, null);
    assert.equal(h.controller.getSnapshot().diagnostics.endResult, "CLOSED");
    assert.equal(h.scheduler.ends.length, 1);
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.scheduler.ends.length, 1);
});

for (const [retryHasCachedFrame, retryRecovers] of [[false, false], [true, false], [true, true]]) {
    test(`actual health/monitor ${retryRecovers ? "retains ownership when retry progresses" :
        `completes loss when retry has ${retryHasCachedFrame ? "only a cached frame" : "no media"}`}`, async () => {
        const previousDocument = globalThis.document;
        const videos = [];
        const transitions = [];
        const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
        globalThis.document = { createElement(tag) {
            if (tag !== "video") return { remove() {} };
            const video = new EventTarget();
            Object.assign(video, { readyState: videos.length === 0 || retryHasCachedFrame ? 2 : 0,
                currentTime: 10, videoWidth: 1920, videoHeight: 1080,
                paused: false, ended: false, canPlayType: () => "probably",
                play: async () => {}, pause() {}, setAttribute() {},
                removeAttribute() {}, load() {}, remove() {} });
            videos.push(video);
            return video;
        } };
        let h;
        try {
            h = harness({ hasCurrentItem: false, monitorFactory: (clockTimers) => {
                const monitor = new LiveSourceMonitor({
                    setTimer: clockTimers.set, clearTimer: clockTimers.clear,
                    consumerFactory: createDominantLiveConsumerFactory({
                        replaceChildren() {}, appendChild() {}
                    }, () => {}, { setTimer: clockTimers.set, clearTimer: clockTimers.clear })
                });
                monitor.subscribe(({ state, generation }) => transitions.push({ state, generation }));
                return monitor;
            } });
            await flush();
            videos[0].currentTime = 11;
            videos[0].dispatchEvent(new Event("timeupdate"));
            h.timers.run(3000); await flush();
            assert.equal(h.controller.getSnapshot().status, "ON AIR");
            // No injected OFFLINE: the real progress watchdog detects the frozen frame.
            assert.equal(h.timers.run(LIVE_PROGRESS_STALL_MS), true);
            assert.equal(h.monitor.getSnapshot().state, "CHECKING");
            assert.equal(h.monitor.getSnapshot().uncertain, true);
            assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
            // A fatal player recovery replaces the consumer before the unchanged
            // source uncertainty deadline. Replacement itself is not absence.
            videos[0].dispatchEvent(new Event("error"));
            assert.equal(h.timers.run(1000), true); await flush();
            assert.equal(h.monitor.getSnapshot().state, "CHECKING");
            if (retryRecovers) {
                videos[1].currentTime = 11;
                videos[1].dispatchEvent(new Event("timeupdate")); await flush();
                assert.equal(h.monitor.getSnapshot().state, "ONLINE");
                assert.equal(h.controller.getSnapshot().status, "ON AIR");
                assert.equal(h.controller.getSnapshot().diagnostics.lossGraceExpired, false);
                assert.equal(h.scheduler.ends.length, 0);
                assert.equal(h.command.calls.length, 1);
                assert.equal(h.stateManager.getPreviewSceneId(), "preview-scene");
                return;
            }
            assert.equal(h.timers.run(5000), true); // source uncertainty deadline
            assert.equal(h.monitor.getSnapshot().state, "CHECKING");
            assert.equal(h.timers.run(LOSS_GRACE_MS), true); await flush();
            assert.ok(h.controller.session);
            assert.equal(h.timers.run(12000), true); await flush();
            assert.equal(h.monitor.getSnapshot().state, "OFFLINE");
            assert.equal(h.controller.getSnapshot().session, null);
            assert.equal(h.scheduler.ends.length, 1);
            assert.equal(h.command.calls.at(-1).sceneId, "program-scene");
            assert.equal(h.command.calls.at(-1).initialCueSeconds, 37);
            assert.equal(h.stateManager.getPreviewSceneId(), "preview-scene");
        }
        finally { h?.controller.destroy(); globalThis.document = previousDocument; }
    });
}

test("persistent normal loss reacquires without latch after a new stable ONLINE edge", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE", generation: 1 });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    const firstSession = h.controller.getSnapshot().session;
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE", generation: 1 });
    h.timers.run(LOSS_GRACE_MS);
    assert.equal(h.controller.getSnapshot().session, null);
    assert.equal(h.controller.getSnapshot().diagnostics.latched, false);
    h.monitor.emit({ sourceId: "live-a", state: "CHECKING", generation: 2 });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE", generation: 2 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.timers.run(3000), true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.controller.getSnapshot().status, "ON AIR");
    assert.notEqual(h.controller.getSnapshot().session, firstSession);
    assert.equal(h.scheduler.begins.length, 2);
    assert.equal(h.command.calls.length, 3,
        "AutoLive, restored Program, then the next AutoLive acquisition");
});

test("AutoLive restores Program identity cue and Preview for every Program kind", async () => {
    for (const kind of ["break", "image", "media", "audio", "hls"]) {
        const h = harness({ hasCurrentItem: false, programSourceKind: kind });
        h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
        assert.equal(h.timers.run(3000), true);
        await Promise.resolve(); await Promise.resolve();
        assert.equal(h.command.calls[0].sceneId, "scene-live-a");
        assert.equal(h.stateManager.getPreviewSceneId(), "preview-scene");
        h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
        assert.equal(h.timers.run(LOSS_GRACE_MS), true);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.equal(h.command.calls.at(-1).sceneId, "program-scene");
        assert.equal(h.command.calls.at(-1).initialCueSeconds,
            ["media", "audio"].includes(kind) ? 37 : null);
        assert.equal(h.stateManager.getProgramSceneId(), "program-scene");
        assert.equal(h.stateManager.getPreviewSceneId(), "preview-scene");
        assert.equal(h.scheduler.ends.length, 1);
    }
});

test("operator override and duplicate completion cannot restore stale Program", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.command.calls.length, 1);
    h.bus.emit(Events.STUDIO_PROGRAM_CHANGED, { source: "operator",
        currentSceneId: "program-b" });
    assert.equal(h.controller.endSession("duplicate-ended"), false);
    await Promise.resolve();
    assert.equal(h.command.calls.length, 1);
    assert.equal(h.scheduler.ends.length, 1);
});

test("monitor retry boundary holds loss grace pending the retry verdict", async () => {
    const h = harness({ hasCurrentItem: false });
    assert.equal(LOSS_GRACE_MS, 5000);
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
    h.monitor.emit({ sourceId: "live-a", state: "CHECKING" });
    assert.equal(h.timers.run(LOSS_GRACE_MS), true,
        "the grace callback observes CHECKING at the shared retry boundary");
    assert.equal(h.controller.getSnapshot().diagnostics.lossTimerActive, false);
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    assert.equal(h.timers.size(), 0);
    assert.equal(h.command.calls.length, 1);
    assert.equal(h.scheduler.ends.length, 0);
    assert.equal(h.controller.getSnapshot().status, "ON AIR");
});

test("real monitor retry cannot leave an unavailable source terminal in loss grace", async () => {
    const attempts = [];
    const h = harness({ hasCurrentItem: false, monitorFactory: (clockTimers) =>
        new LiveSourceMonitor({ retryDelayMs: LOSS_GRACE_MS, readinessTimeoutMs: 12000,
            setTimer: clockTimers.set, clearTimer: clockTimers.clear,
            consumerFactory: (_source, handlers) => {
                const attempt = { handlers, destroyed: false };
                attempts.push(attempt);
                return { start() {}, destroy() { attempt.destroyed = true; } };
            } }) });
    attempts[0].handlers.online();
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    attempts[0].handlers.offline({ recoverInPlace: true });
    assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
    assert.equal(h.timers.run(LOSS_GRACE_MS), true,
        "monitor retry was registered before the controller grace timer");
    assert.equal(h.monitor.getSnapshot().state, "CHECKING");
    assert.equal(h.timers.run(LOSS_GRACE_MS), true);
    assert.equal(h.controller.getSnapshot().diagnostics.lossGraceExpired, true);
    attempts[1].handlers.offline();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.controller.getSnapshot().session, null);
    assert.equal(h.controller.getSnapshot().diagnostics.endReason, "source-loss");
    assert.equal(h.scheduler.ends.length, 1);
    assert.equal(h.command.calls.at(-1).sceneId, "program-scene");
});

test("disarm cancels an active loss grace without a stale timer callback", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    assert.equal(h.timers.size(), 1);
    h.config.setArmed(false);
    assert.equal(h.timers.size(), 0);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.scheduler.ends.length, 1);
    assert.equal(h.command.calls.length, 2);
});

test("operator Preview selection during AutoLive becomes the recovery target", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    h.stateManager.setPreviewScene("operator-preview");
    h.bus.emit(Events.STUDIO_PREVIEW_CHANGED, { source: "operator",
        currentSceneId: "operator-preview" });
    h.monitor.emit({ sourceId: "live-a", state: "OFFLINE" });
    h.timers.run(LOSS_GRACE_MS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.stateManager.getPreviewSceneId(), "operator-preview");
});

test("25 transient loss cycles retain one AutoLive session without oscillation", async () => {
    const h = harness({ hasCurrentItem: false });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve(); await Promise.resolve();
    const session = h.controller.getSnapshot().session;
    for (let index = 0; index < 25; index += 1) {
        h.monitor.emit({ sourceId: "live-a", state: "OFFLINE", generation: index });
        h.monitor.emit({ sourceId: "live-a", state: "CHECKING", generation: index + 1 });
        h.monitor.emit({ sourceId: "live-a", state: "ONLINE", generation: index + 1 });
        assert.equal(h.controller.getSnapshot().session, session);
    }
    assert.equal(h.command.calls.length, 1);
    assert.equal(h.scheduler.begins.length, 1);
    assert.equal(h.scheduler.ends.length, 0);
});

test("AutoLive retries deterministically after an active transition becomes idle", async () => {
    const h = harness({ transitionBusy: true });
    h.monitor.emit({ sourceId: "live-a", state: "ONLINE" });
    h.timers.run(3000); await Promise.resolve();
    assert.equal(h.command.calls.length, 0);
    assert.equal(h.scheduler.begins.length, 0);
    assert.equal(h.controller.getSnapshot().diagnostics.blockReason, "TRANSITION_BUSY");
    h.transitionCoordinator.setBusy(false);
    assert.equal(h.timers.run(3000), true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.scheduler.begins.length, 1);
    assert.equal(h.command.calls.length, 1);
    assert.equal(h.controller.getSnapshot().status, "ON AIR");
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

const settleAutoLive = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function sourceObservation(h, state, generation) {
    h.monitor.emit({ sourceId: "live-a", state, generation, sourceHealth: true });
}
for (const scenario of ["uncertainty", "recovery", "persistent", "stale-online", "buffered-player", "old-generation"]) {
    test(`source-owned AutoLive history has no ping-pong: ${scenario}`, async () => {
        const h = harness();
        try {
            sourceObservation(h, "ONLINE", 10); h.timers.run(3000); await settleAutoLive();
            assert.equal(h.command.calls.length, 1);
            sourceObservation(h, scenario === "uncertainty" ? "CHECKING" : "OFFLINE", 11);
            if (scenario === "recovery") sourceObservation(h, "ONLINE", 12);
            h.timers.run(LOSS_GRACE_MS); await settleAutoLive();
            if (["uncertainty", "recovery"].includes(scenario)) {
                assert.deepEqual(h.command.calls.map(x => x.sceneId), ["scene-live-a"]);
                assert.equal(h.scheduler.ends.length, 0);
                sourceObservation(h, "ONLINE", 13); h.timers.run(3000); await settleAutoLive();
                assert.equal(h.command.calls.length, 1);
            } else {
                assert.equal(h.scheduler.ends.length, 1);
                if (scenario === "stale-online") sourceObservation(h, "ONLINE", 11);
                if (scenario === "old-generation") sourceObservation(h, "ONLINE", 9);
                if (scenario === "buffered-player") h.monitor.emit({ sourceId: "live-a", state: "ONLINE", generation: 99 });
                h.timers.run(3000); await settleAutoLive();
                sourceObservation(h, "OFFLINE", 12); h.timers.run(LOSS_GRACE_MS);
                assert.deepEqual(["program-scene", ...h.command.calls.map(x => x.sceneId)],
                    ["program-scene", "scene-live-a", "program-scene"]);
                assert.equal(h.scheduler.ends.length, 1);
                assert.equal(h.command.calls[1].initialCueSeconds, 37);
                assert.equal(h.stateManager.getPreviewSceneId(), "preview-scene");
            }
        } finally { h.controller.destroy(); }
    });
}

test("source uncertainty cancels stabilization and confirmed absence cancels pending acquisition", async () => {
    const h = harness();
    try {
        sourceObservation(h, "ONLINE", 1); sourceObservation(h, "CHECKING", 2);
        assert.equal(h.timers.run(3000), false);
        sourceObservation(h, "ONLINE", 3); h.timers.run(3000);
        const acquire = h.command.calls[0];
        sourceObservation(h, "OFFLINE", 4); sourceObservation(h, "ONLINE", 5);
        assert.equal(acquire.canCommit(), false, "even recovery cannot resurrect the old acquisition");
        await settleAutoLive();
        h.controller.endSession("source-loss"); await settleAutoLive();
        assert.equal(h.timers.run(3000), false);
        assert.equal(acquire.canCommit(), false);
    } finally { h.controller.destroy(); }
});

test("StudioProgramCommand revalidates source ownership after asynchronous preparation before TAKE", async () => {
    const h = programCommandHarness({ programSceneId: "old" });
    let prepared; let present = true;
    h.renderer.prepareProgramScene = () => new Promise(resolve => { prepared = resolve; });
    const pending = h.command.execute({ sceneId: "live", origin: "dominant-live", canCommit: () => present });
    present = false; prepared({ sceneId: "live" });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "acquisition-cancelled");
    assert.equal(h.state.program, "old");
    assert.equal(h.records.length, 0);
    h.coordinator.destroy();
});

test("real source monitor plus AutoLive closes one session and ignores old responses", async () => {
    const requests = [];
    const h = harness({ monitorFactory: timers => new SourcePresenceMonitor({
        setTimer: timers.set, clearTimer: timers.clear,
        fetchImplementation: () => new Promise(resolve => requests.push(value => resolve({
            ok: true, json: async () => ({ state: value ? "connecting" : "offline",
                playbackHlsUrl: "https://a/live.m3u8", health: { publisherPresent: value } })
        })))
    }) });
    try {
        requests[0](true); await settleAutoLive(); h.timers.run(3000); await settleAutoLive();
        h.timers.run(1000); requests[1](false); await settleAutoLive();
        h.timers.run(1000); // A request starts inside grace, before session closure.
        h.timers.run(LOSS_GRACE_MS); await settleAutoLive();
        requests[2](true); await settleAutoLive(); // Delayed old-session positive observation.
        assert.equal(h.timers.run(3000), false);
        requests[3](false); await settleAutoLive(); // A fresh observation is required.
        assert.deepEqual(h.command.calls.map(x => x.sceneId), ["scene-live-a", "program-scene"]);
    } finally { h.controller.destroy(); }
});

test("source-owned committed LIVE is not restored because player activation reports failure", async () => {
    const h = harness({ commandResult: { ok: false, reason: "program-activation-failed",
        diagnostics: { programCommitted: true, previewReady: true } } });
    try {
        sourceObservation(h, "ONLINE", 1); h.timers.run(3000); await settleAutoLive();
        assert.ok(h.controller.session);
        assert.equal(h.scheduler.ends.length, 0);
        assert.equal(h.command.calls.length, 1);
        sourceObservation(h, "CHECKING", 2); h.timers.run(LOSS_GRACE_MS); await settleAutoLive();
        assert.ok(h.controller.session);
        assert.equal(h.scheduler.ends.length, 0);
    } finally { h.controller.destroy(); }
});

// Actual command results are published into the retained store to check revisions,
// rather than relying only on the health/controller status text.
test("source-owned Program revision history is A LIVE A exactly once", async () => {
    const { default: ProgramOutputStore } = await import("../server/program-output/ProgramOutputStore.js");
    const { createProgramOutputEnvelope } = await import("../public/js/program-output/ProgramOutputEnvelope.js");
    const store = new ProgramOutputStore(); const history = [];
    const h = harness(); let revision = 0;
    const commit = sceneId => {
        const live = sceneId === "scene-live-a";
        const timestamp = new Date().toISOString();
        const snapshot = { version: 1, revision: ++revision, publisherSessionId: "ownership-test",
            publishedAt: timestamp, committedAt: timestamp,
            scene: { id: sceneId, name: sceneId, type: live ? "LIVE" : "MEDIA" },
            source: { id: live ? "live-a" : "media-a", kind: live ? "hls" : "media",
                url: live ? "https://example.test/live.m3u8" : "https://example.test/a.mp4" },
            playback: { initialTime: live ? 0 : 37, duration: null, playing: true,
                ended: false, state: "playing", startedAt: timestamp },
            graphics: { items: [] }, overlays: {}, transition: { type: "cut", durationMs: 0 } };
        assert.equal(store.accept(createProgramOutputEnvelope(snapshot)).accepted, true);
        history.push([store.getCurrent().revision, store.getCurrent().snapshot.source.kind]);
    };
    const execute = h.command.execute.bind(h.command);
    h.command.execute = async request => { const result = await execute(request);
        if (result.ok) commit(request.sceneId); return result; };
    try {
        commit("program-scene");
        sourceObservation(h, "ONLINE", 1); h.timers.run(3000); await settleAutoLive();
        sourceObservation(h, "CHECKING", 2); sourceObservation(h, "ONLINE", 3);
        h.timers.run(LOSS_GRACE_MS); await settleAutoLive();
        sourceObservation(h, "OFFLINE", 4); h.timers.run(LOSS_GRACE_MS); await settleAutoLive();
        sourceObservation(h, "ONLINE", 3); h.timers.run(3000); await settleAutoLive();
        assert.deepEqual(history, [[1, "media"], [2, "hls"], [3, "media"]]);
        assert.equal(store.getCurrent().revision, 3);
    } finally { h.controller.destroy(); }
});
