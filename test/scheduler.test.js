import test from "node:test";
import assert from "node:assert/strict";
import {
    createEmptySchedule, getActiveInterruptItem, getActiveItem,
    getActiveNormalItem, getNextBoundary, getNextItem,
    resolveScheduleItems, validateSchedule, zonedLocalToIso
} from "../public/js/scheduler/ScheduleContract.js";
import ScheduleStore from "../public/js/scheduler/ScheduleStore.js";
import SchedulerEngine from "../public/js/scheduler/SchedulerEngine.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import { calculateEffectiveSchedule, isHardClock,
    RESUME_POLICIES } from "../public/js/scheduler/ScheduleClock.js";
import { getScheduleEditorTime } from "../public/js/ui/StudioScheduleUI.js";
import ProgramRemainingTimeUI, { calculateProgramRemaining, formatRemainingSeconds } from
    "../public/js/ui/ProgramRemainingTimeUI.js";
import Events from "../public/js/core/Events.js";

const item = (id, start, durationSeconds = 1800, sceneId = id) => ({
    id, title: id.toUpperCase(), start, durationSeconds, sceneId, transition: "CUT"
});
const schedule = (...items) => validateSchedule({
    version: 1, timezone: "Europe/Rome", items
}).schedule;

test("validation sorts items and derives deterministic windows", () => {
    const result = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("b", "2026-08-23T20:30:00+02:00"),
        item("a", "2026-08-23T20:00:00+02:00")
    ] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schedule.items.map(({ id }) => id), ["a", "b"]);
    assert.equal(result.schedule.items[0].endMs, Date.parse("2026-08-23T20:30:00+02:00"));
});

test("missing transition defaults to CUT", () => {
    const value = item("a", "2026-08-23T20:00:00+02:00");
    delete value.transition;
    const result = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [value] });
    assert.equal(result.ok, true);
    assert.equal(result.schedule.items[0].transition, "CUT");
});

test("legacy items migrate to ABSOLUTE NORMAL without a version bump", () => {
    const result = validateSchedule({ version: 1, timezone: "Europe/Rome",
        items: [item("legacy", "2026-08-23T20:00:00+02:00")] });
    assert.equal(result.schedule.items[0].startMode, "ABSOLUTE");
    assert.equal(result.schedule.items[0].behavior, "NORMAL");
    assert.equal(result.schedule.items[0].resumePolicy, "RESUME_FIXED");
});

test("RESUME_SHIFT extends item and its AFTER_PREVIOUS chain only", () => {
    const after = { ...item("b", null, 600), startMode: "AFTER_PREVIOUS" };
    delete after.start;
    const base = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        { ...item("a", "2026-08-23T20:00:00+02:00", 1800), resumePolicy: "RESUME_SHIFT" },
        after
    ] }).schedule;
    const before = JSON.stringify(base);
    const effective = calculateEffectiveSchedule(base, new Map([["a", 300000]]));
    assert.equal(effective.items.find(({ id }) => id === "a").endMs,
        Date.parse("2026-08-23T20:35:00+02:00"));
    assert.equal(effective.items.find(({ id }) => id === "b").startMs,
        Date.parse("2026-08-23T20:35:00+02:00"));
    assert.equal(JSON.stringify(base), before, "runtime shift must not mutate base schedule");
});

test("FILLER absorbs drift and hard clock remains fixed", () => {
    const create = (shift) => {
        const base = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
            { ...item("a", "2026-08-23T20:00:00+02:00", 2400), resumePolicy: "RESUME_SHIFT" },
            { ...item("f", "2026-08-23T20:40:00+02:00", 1200), resumePolicy: "FILLER" },
            item("hard", "2026-08-23T21:00:00+02:00", 600)
        ] }).schedule;
        return calculateEffectiveSchedule(base, new Map([["a", shift]]));
    };
    const shortened = create(480000);
    assert.equal(shortened.items.find(({ id }) => id === "f").effectiveDurationSeconds, 720);
    assert.equal(shortened.items.find(({ id }) => id === "hard").startMs,
        Date.parse("2026-08-23T21:00:00+02:00"));
    const skipped = create(1200000);
    assert.equal(skipped.items.find(({ id }) => id === "f").effectiveDurationSeconds, 0);
    assert.equal(skipped.items.find(({ id }) => id === "f").skipped, true);
    assert.equal(isHardClock(skipped.items.find(({ id }) => id === "hard")), true);
});

test("RESUME_FIXED leaves the base hard-clock window unchanged", () => {
    const base = schedule(item("a", "2026-08-23T20:00:00+02:00", 1800),
        item("hard", "2026-08-23T20:30:00+02:00", 600));
    const effective = calculateEffectiveSchedule(base);
    assert.equal(effective.items.find(({ id }) => id === "a").endMs,
        Date.parse("2026-08-23T20:30:00+02:00"));
    assert.equal(effective.items.find(({ id }) => id === "hard").startMs,
        Date.parse("2026-08-23T20:30:00+02:00"));
});

test("Program remaining uses recorded source position and ENDED state", () => {
    const source = calculateProgramRemaining({ transport: {
        duration: 60, currentTime: 20, paused: false, ended: false
    } });
    assert.deepEqual(source, { label: "SOURCE", remainingSeconds: 40 });
    const paused = calculateProgramRemaining({ transport: {
        duration: 60, currentTime: 20, paused: true, ended: false
    } });
    assert.equal(paused.remainingSeconds, 40);
    assert.equal(calculateProgramRemaining({ transport: {
        duration: 60, currentTime: 60, ended: true
    } }).remainingSeconds, 0);
    assert.equal(calculateProgramRemaining({ transport: null }).remainingSeconds, null);
});

test("matching schedule authority remains editorially authoritative after source end", () => {
    const authority = (effectiveEnd) => ({
        mode: "scheduled", sceneId: "media", effectiveEnd
    });
    const transport = { duration: 34, currentTime: 0, ended: false };
    assert.deepEqual(calculateProgramRemaining({
        now: 0, schedulerAuthority: authority(70000), programSceneId: "media", transport
    }), { label: "SCHEDULE", remainingSeconds: 70 });
    assert.deepEqual(calculateProgramRemaining({
        now: 34000, schedulerAuthority: authority(70000), programSceneId: "media",
        transport: { duration: 34, currentTime: 34, ended: true }
    }), { label: "SCHEDULE", remainingSeconds: 36 });
    assert.equal(calculateProgramRemaining({
        now: 69000, schedulerAuthority: authority(70000), programSceneId: "media",
        transport
    }).remainingSeconds, 1);
    assert.equal(calculateProgramRemaining({
        now: 70000, schedulerAuthority: authority(70000), programSceneId: "media",
        transport
    }).remainingSeconds, 0);
    assert.deepEqual(calculateProgramRemaining({
        now: 0, schedulerAuthority: authority(20000), programSceneId: "media", transport
    }), { label: "SCHEDULE", remainingSeconds: 20 });
});

test("ended transport is zero only outside matching schedule authority", () => {
    const ended = { duration: 34, currentTime: 34, ended: true };
    assert.deepEqual(calculateProgramRemaining({ transport: ended }),
        { label: "SOURCE", remainingSeconds: 0 });
    assert.deepEqual(calculateProgramRemaining({
        now: 1000,
        schedulerAuthority: { mode: "scheduled", sceneId: "other", effectiveEnd: 70000 },
        programSceneId: "media", transport: ended
    }), { label: "SOURCE", remainingSeconds: 0 });
});

test("scheduled boundary wins over longer source duration with ceil rounding", () => {
    const remaining = calculateProgramRemaining({
        now: 1000,
        schedulerAuthority: { mode: "scheduled", sceneId: "media",
            effectiveEnd: 16001 },
        programSceneId: "media",
        transport: { duration: 60, currentTime: 20 }
    });
    assert.deepEqual(remaining, { label: "SCHEDULE", remainingSeconds: 16 });
    assert.equal(formatRemainingSeconds(16), "00:00:16");
    assert.equal(formatRemainingSeconds(null), "--:--:--");
});

test("manual override displays countdown to scheduler takeover boundary", () => {
    const remaining = calculateProgramRemaining({ now: 1000,
        schedulerAuthority: { mode: "manual-override", effectiveEnd: 11000 },
        programSceneId: "manual", transport: null });
    assert.deepEqual(remaining, { label: "NEXT TAKE", remainingSeconds: 10 });
});

test("effective SHIFT, FIXED and shortened FILLER ends drive countdown", () => {
    const authority = (item) => ({ mode: "scheduled", sceneId: item.sceneId,
        effectiveEnd: item.endMs });
    const endedTransport = { duration: 34, currentTime: 34, ended: true };
    const base = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        { ...item("a", "2026-08-23T20:00:00+02:00", 2400), resumePolicy: "RESUME_SHIFT" },
        { ...item("f", "2026-08-23T20:40:00+02:00", 1200), resumePolicy: "FILLER" },
        item("hard", "2026-08-23T21:00:00+02:00", 600)
    ] }).schedule;
    const effective = calculateEffectiveSchedule(base, new Map([["a", 480000]]));
    const shifted = effective.items.find(({ id }) => id === "a");
    const filler = effective.items.find(({ id }) => id === "f");
    assert.equal(calculateProgramRemaining({ now: shifted.startMs,
        schedulerAuthority: authority(shifted), programSceneId: shifted.sceneId,
        transport: endedTransport })
        .remainingSeconds, 2880);
    assert.equal(calculateProgramRemaining({ now: filler.startMs,
        schedulerAuthority: authority(filler), programSceneId: filler.sceneId,
        transport: endedTransport })
        .remainingSeconds, 720);
    const hard = effective.items.find(({ id }) => id === "hard");
    assert.equal(hard.startMs, Date.parse("2026-08-23T21:00:00+02:00"));
    assert.equal(calculateProgramRemaining({ now: hard.startMs,
        schedulerAuthority: authority(hard), programSceneId: hard.sceneId,
        transport: endedTransport }).remainingSeconds, 600);
});

test("Program remaining UI owns one presentation timer and destroys cleanly", () => {
    const timer = fakeTimer(0);
    const label = { textContent: "" };
    const output = { textContent: "" };
    const listeners = new Map();
    const eventBus = {
        on: (event, listener) => listeners.set(event, listener),
        off: (event) => listeners.delete(event)
    };
    const ui = new ProgramRemainingTimeUI({
        root: { querySelector: (selector) => selector.includes("label") ? label : output },
        schedulerEngine: { subscribe: (listener) => { listener(); return () => {}; },
            getCurrentEffectiveAuthority: () => ({ mode: "none" }) },
        renderer: { subscribeProgramTransport: (listener) => {
            listener({ duration: 60, currentTime: 20, ended: false }); return () => {};
        } },
        stateManager: { getProgramSceneId: () => "media" },
        eventBus,
        clock: timer.now,
        setTimer: timer.set,
        clearTimer: timer.clear
    });
    assert.equal(ui.start(), true);
    assert.equal(ui.start(), false);
    assert.equal(timer.count(), 1);
    assert.equal(output.textContent, "00:00:40");
    ui.destroy();
    assert.equal(timer.count(), 0);
    assert.equal(listeners.size, 0);
});

test("AFTER_PREVIOUS chains derive from preceding NORMAL duration", () => {
    const chained = (duration) => validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:00+02:00", duration),
        { ...item("b", null, 300), startMode: "AFTER_PREVIOUS", start: undefined },
        { ...item("c", null, 300), startMode: "AFTER_PREVIOUS", start: undefined }
    ].map((value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))) }).schedule;
    assert.equal(chained(600).items.find(({ id }) => id === "b").startMs,
        Date.parse("2026-08-23T20:10:00+02:00"));
    assert.equal(chained(720).items.find(({ id }) => id === "b").startMs,
        Date.parse("2026-08-23T20:12:00+02:00"));
    assert.equal(chained(720).items.find(({ id }) => id === "c").startMs,
        Date.parse("2026-08-23T20:17:00+02:00"));
});

test("AFTER_PREVIOUS rejects first item and INTERRUPT combination", () => {
    const after = { ...item("a", null), startMode: "AFTER_PREVIOUS" };
    delete after.start;
    assert.equal(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [after] }).ok, false);
    const interrupt = { ...after, behavior: "INTERRUPT" };
    assert.equal(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("base", "2026-08-23T20:00:00+02:00", 60), interrupt
    ] }).ok, false);
});

test("INTERRUPT overlaps NORMAL but not another INTERRUPT", () => {
    const normal = item("normal", "2026-08-23T20:00:00+02:00", 1800);
    const interrupt = { ...item("interrupt", "2026-08-23T20:10:00+02:00", 120), behavior: "INTERRUPT" };
    const allowed = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [normal, interrupt] });
    assert.equal(allowed.ok, true);
    const second = { ...item("interrupt-2", "2026-08-23T20:11:00+02:00", 120), behavior: "INTERRUPT" };
    assert.equal(validateSchedule({ version: 1, timezone: "Europe/Rome",
        items: [normal, interrupt, second] }).ok, false);
});

test("interrupt controls NOW and normal resume controls NEXT", () => {
    const value = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("movie", "2026-08-23T20:00:00+02:00", 7200),
        { ...item("news", "2026-08-23T20:30:00+02:00", 600), behavior: "INTERRUPT" }
    ] }).schedule;
    const now = Date.parse("2026-08-23T20:35:00+02:00");
    assert.equal(getActiveNormalItem(value, now).id, "movie");
    assert.equal(getActiveInterruptItem(value, now).id, "news");
    assert.equal(getActiveItem(value, now).id, "news");
    assert.equal(getNextItem(value, now).id, "movie");
});

test("validation rejects overlaps, duplicate IDs and malformed fields", () => {
    const overlap = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:00+02:00", 3600),
        item("b", "2026-08-23T20:30:00+02:00")
    ] });
    assert.equal(overlap.ok, false);
    assert.match(overlap.issues.join(), /overlap/);
    assert.equal(validateSchedule({ version: 1, timezone: "Nope/Nowhere", items: [] }).ok, false);
    assert.equal(validateSchedule({ version: 1, timezone: "Europe/Rome",
        items: [item("a", "not-a-date")] }).ok, false);
});

test("active, next, gaps, past items and exact boundaries are deterministic", () => {
    const value = schedule(
        item("a", "2026-08-23T20:00:00+02:00"),
        item("b", "2026-08-23T21:00:00+02:00")
    );
    assert.equal(getActiveItem(value, Date.parse("2026-08-23T20:00:00+02:00")).id, "a");
    assert.equal(getActiveItem(value, Date.parse("2026-08-23T20:30:00+02:00")), null);
    assert.equal(getNextItem(value, Date.parse("2026-08-23T20:30:00+02:00")).id, "b");
    assert.equal(getActiveItem(value, Date.parse("2026-08-23T21:30:00+02:00")), null);
    assert.equal(getNextBoundary(value, Date.parse("2026-08-23T20:10:00+02:00")),
        Date.parse("2026-08-23T20:30:00+02:00"));
});

test("Europe/Rome wall time conversion is explicit across summer and winter", () => {
    assert.equal(zonedLocalToIso("2026-08-23", "20:00"), "2026-08-23T20:00:00+02:00");
    assert.equal(zonedLocalToIso("2026-12-23", "20:00"), "2026-12-23T20:00:00+01:00");
    assert.equal(zonedLocalToIso("2026-03-29", "02:30"), null);
});

test("absolute editor conversion and edit value preserve seconds", () => {
    assert.equal(zonedLocalToIso("2026-08-23", "20:15:37"),
        "2026-08-23T20:15:37+02:00");
    assert.equal(getScheduleEditorTime("2026-08-23T20:15:37+02:00"), "20:15:37");
    assert.equal(zonedLocalToIso("2026-08-23", "20:15"),
        "2026-08-23T20:15:00+02:00");
});

test("AFTER_PREVIOUS and next boundary retain second precision", () => {
    const after = { ...item("b", null, 20), startMode: "AFTER_PREVIOUS" };
    delete after.start;
    const value = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:10+02:00", 35), after
    ] }).schedule;
    assert.equal(value.items.find(({ id }) => id === "b").startMs,
        Date.parse("2026-08-23T20:00:45+02:00"));
    assert.equal(getNextBoundary(value, Date.parse("2026-08-23T20:00:20+02:00")),
        Date.parse("2026-08-23T20:00:45+02:00"));
});

test("second-boundary INTERRUPT wins and returns to NORMAL", () => {
    const value = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("normal", "2026-08-23T20:00:00+02:00", 120),
        { ...item("interrupt", "2026-08-23T20:00:30+02:00", 15), behavior: "INTERRUPT" }
    ] }).schedule;
    assert.equal(getActiveItem(value, Date.parse("2026-08-23T20:00:30+02:00")).id, "interrupt");
    assert.equal(getActiveItem(value, Date.parse("2026-08-23T20:00:45+02:00")).id, "normal");
});

test("missing scenes remain visible as unresolved without fallback", () => {
    const resolved = resolveScheduleItems(schedule(item("a", "2026-08-23T20:00:00+02:00")),
        () => null);
    assert.equal(resolved[0].resolved, false);
});

test("store rejects untrusted persistence and round-trips canonical data", () => {
    const values = new Map([["livezone.scheduler.schedule.v1", "{bad"]]);
    const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
    const store = new ScheduleStore({ storage });
    assert.deepEqual(store.load().schedule, createEmptySchedule());
    const value = schedule(item("a", "2026-08-23T20:00:00+02:00"));
    assert.equal(store.save(value).ok, true);
    assert.equal(store.load().schedule.items[0].id, "a");
});

test("late wake activates only the item active now", async () => {
    const harness = engineHarness("2026-08-23T20:17:00+02:00");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 600),
        item("b", "2026-08-23T20:10:00+02:00", 1800)
    ));
    harness.engine.start();
    await flush();
    assert.deepEqual(harness.calls.map(({ sceneId }) => sceneId), ["b"]);
    harness.engine.destroy();
});

test("manual override does not snap back and clears at next boundary", async () => {
    const harness = engineHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00"),
        item("b", "2026-08-23T20:30:00+02:00")
    ));
    harness.engine.start();
    await flush();
    harness.now.value = Date.parse("2026-08-23T20:10:00+02:00");
    harness.bus.emit(Events.STUDIO_PROGRAM_CHANGED, { source: "operator" });
    assert.equal(harness.engine.getSnapshot().status, "MANUAL OVERRIDE");
    assert.equal(harness.engine.getCurrentEffectiveAuthority().mode, "manual-override");
    await harness.engine.reconcile(true);
    assert.equal(harness.calls.length, 1);
    harness.now.value = Date.parse("2026-08-23T20:30:00+02:00");
    await harness.engine.reconcile(true);
    assert.deepEqual(harness.calls.map(({ sceneId }) => sceneId), ["a", "b"]);
    harness.engine.destroy();
});

test("failed item leaves future boundary eligible", async () => {
    const harness = engineHarness("2026-08-23T20:00:00+02:00", "a");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 600),
        item("b", "2026-08-23T20:10:00+02:00")
    ));
    harness.engine.start();
    await flush();
    assert.equal(harness.engine.getSnapshot().status, "ERROR");
    harness.now.value = Date.parse("2026-08-23T20:10:00+02:00");
    await harness.engine.reconcile(true);
    assert.deepEqual(harness.calls.map(({ sceneId }) => sceneId), ["a", "b"]);
    assert.equal(harness.engine.getSnapshot().status, "ACTIVE");
    harness.engine.destroy();
});

test("Studio command uses authoritative Preview and transition path", async () => {
    let preview = "old-preview";
    let program = "old-program";
    const transitions = [];
    const stateManager = {
        getPreviewSceneId: () => preview,
        getProgramSceneId: () => program,
        setPreviewScene: (id, context) => { preview = id; return { currentSceneId: id, ...context }; }
    };
    const coordinator = {
        isBusy: () => false,
        transition: async (options) => { transitions.push(options); program = preview; return {}; }
    };
    const command = new StudioProgramCommand({ stateManager,
        catalog: { getDefinition: () => ({ id: "target" }) }, transitionCoordinator: coordinator });
    const result = await command.execute({ sceneId: "target", transition: "DISSOLVE" });
    assert.equal(result.ok, true);
    assert.equal(program, "target");
    assert.equal(transitions[0].source, "schedule");
    assert.equal(transitions[0].durationMs, 400);
});

test("Studio command forwards cue only for recorded MEDIA/AUDIO", async () => {
    const contexts = [];
    const sourceKind = { media: "media", audio: "audio", hls: "hls" };
    const state = { preview: null, program: null };
    const command = new StudioProgramCommand({
        stateManager: {
            getProgramSceneId: () => state.program,
            getPreviewSceneId: () => state.preview,
            setPreviewScene: (id) => { state.preview = id; return {}; }
        },
        catalog: {
            getDefinition: (id) => ({ id, renderer: { kind: "source", sourceId: id } }),
            getSources: () => Object.entries(sourceKind).map(([id, kind]) => ({ id, kind }))
        },
        transitionCoordinator: {
            isBusy: () => false,
            transition: async ({ preparationContext }) => { contexts.push(preparationContext); return {}; }
        }
    });
    await command.execute({ sceneId: "media", initialCueSeconds: 600 });
    await command.execute({ sceneId: "audio", initialCueSeconds: 42 });
    await command.execute({ sceneId: "hls", initialCueSeconds: 99 });
    assert.deepEqual(contexts.map((value) => value?.transportCueTime ?? null), [600, 42, null]);
});

test("boundary timer activates consecutive A and B without toggling", async () => {
    const harness = boundaryHarness("2026-08-23T19:59:30+02:00");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 120),
        item("b", "2026-08-23T20:02:00+02:00", 120)
    ));
    harness.engine.start();
    await flushTwice();
    assert.equal(harness.timer.count(), 1);
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:00+02:00"));
    assert.deepEqual(harness.calls, ["a"]);
    assert.equal(harness.timer.count(), 1);
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:02:00+02:00"));
    assert.deepEqual(harness.calls, ["a", "b"]);
    assert.equal(harness.timer.count(), 1);
    harness.engine.destroy();
});

test("boundary timer fires an AFTER_PREVIOUS item at an exact second", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    const after = { ...item("b", null, 20), startMode: "AFTER_PREVIOUS" };
    delete after.start;
    harness.engine.setSchedule(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:10+02:00", 35), after
    ] }).schedule);
    harness.engine.start();
    await flushTwice();
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:10+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:45+02:00"));
    assert.deepEqual(harness.calls, ["a", "b"]);
    harness.engine.destroy();
});

test("gap end rearms future B start and leaves Program untouched", async () => {
    const harness = boundaryHarness("2026-08-23T19:59:30+02:00");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 60),
        item("b", "2026-08-23T20:03:00+02:00", 60)
    ));
    harness.engine.start();
    await flushTwice();
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:01:00+02:00"));
    assert.deepEqual(harness.calls, ["a"]);
    assert.equal(harness.timer.nextAt(), Date.parse("2026-08-23T20:03:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:03:00+02:00"));
    assert.deepEqual(harness.calls, ["a", "b"]);
    harness.engine.destroy();
});

test("manual override survives A and clears automatically at B timer", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 120),
        item("b", "2026-08-23T20:02:00+02:00", 120)
    ));
    harness.engine.start();
    await flushTwice();
    harness.bus.emit(Events.STUDIO_PROGRAM_CHANGED, { source: "operator" });
    assert.equal(harness.engine.getSnapshot().status, "MANUAL OVERRIDE");
    assert.equal(harness.timer.count(), 1);
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:02:00+02:00"));
    assert.deepEqual(harness.calls, ["a", "b"]);
    assert.equal(harness.engine.getSnapshot().status, "ACTIVE");
    harness.engine.destroy();
});

test("failed command and late callback still rearm from current wall clock", async () => {
    const harness = boundaryHarness("2026-08-23T19:59:30+02:00", "a");
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 120),
        item("b", "2026-08-23T20:02:00+02:00", 120)
    ));
    harness.engine.start();
    await flushTwice();
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:10+02:00"));
    assert.equal(harness.engine.getSnapshot().status, "ERROR");
    assert.equal(harness.timer.nextAt(), Date.parse("2026-08-23T20:02:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:02:10+02:00"));
    assert.deepEqual(harness.calls, ["a", "b"]);
    harness.engine.destroy();
});

test("schedule edit while ON replaces the owned timeout", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(item("late", "2026-08-23T20:30:00+02:00")));
    harness.engine.start();
    await flushTwice();
    assert.equal(harness.timer.nextAt(), Date.parse("2026-08-23T20:30:00+02:00"));
    harness.engine.setSchedule(schedule(
        item("early", "2026-08-23T20:10:00+02:00", 600),
        item("late", "2026-08-23T20:30:00+02:00")
    ));
    await flushTwice();
    assert.equal(harness.timer.count(), 1);
    assert.equal(harness.timer.nextAt(), Date.parse("2026-08-23T20:10:00+02:00"));
    harness.engine.destroy();
});

test("disable cancels boundary, re-enable reconciles, destroy prevents callbacks", async () => {
    const harness = boundaryHarness("2026-08-23T19:59:30+02:00");
    harness.engine.setSchedule(schedule(item("a", "2026-08-23T20:00:00+02:00")));
    harness.engine.start();
    await flushTwice();
    harness.engine.stop();
    assert.equal(harness.timer.count(), 0);
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:10+02:00"));
    assert.deepEqual(harness.calls, []);
    harness.engine.start();
    await flushTwice();
    assert.deepEqual(harness.calls, ["a"]);
    harness.engine.destroy();
    assert.equal(harness.timer.count(), 0);
    await harness.timer.advanceTo(Date.parse("2026-08-23T21:00:00+02:00"));
    assert.deepEqual(harness.calls, ["a"]);
});

test("interrupt start and end take X then recompute and resume A", async () => {
    const harness = boundaryHarness("2026-08-23T19:59:30+02:00");
    harness.engine.setSchedule(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:00+02:00", 1800),
        { ...item("x", "2026-08-23T20:10:00+02:00", 120), behavior: "INTERRUPT" }
    ] }).schedule);
    harness.engine.start();
    await flushTwice();
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:00:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:10:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:12:00+02:00"));
    assert.deepEqual(harness.calls, ["a", "x", "a"]);
    harness.engine.destroy();
});

test("interrupt boundary clears manual override and it does not return", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:00+02:00", 1800),
        { ...item("x", "2026-08-23T20:10:00+02:00", 120), behavior: "INTERRUPT" }
    ] }).schedule);
    harness.engine.start();
    await flushTwice();
    harness.bus.emit(Events.STUDIO_PROGRAM_CHANGED, { source: "operator" });
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:10:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:12:00+02:00"));
    assert.deepEqual(harness.calls, ["a", "x", "a"]);
    assert.notEqual(harness.engine.getSnapshot().status, "MANUAL OVERRIDE");
    harness.engine.destroy();
});

test("scheduled interrupt captures MEDIA cue, resumes it, and shifts chained item", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00", null, {
        transport: { sourceId: "source-a", currentTime: 600 }, sourceKind: "media"
    });
    const after = { ...item("b", null, 600), startMode: "AFTER_PREVIOUS" };
    delete after.start;
    harness.engine.setSchedule(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        { ...item("a", "2026-08-23T20:00:00+02:00", 1800), resumePolicy: "RESUME_SHIFT" },
        { ...item("x", "2026-08-23T20:10:00+02:00", 300), behavior: "INTERRUPT" },
        after
    ] }).schedule);
    harness.engine.start();
    await flushTwice();
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:10:00+02:00"));
    assert.equal(harness.engine.getSnapshot().status, "INTERRUPTED");
    assert.equal(harness.engine.getSnapshot().interruptionContext.cueAtInterruption, 600);
    assert.equal(harness.engine.getCurrentEffectiveAuthority().item.id, "x");
    assert.equal(harness.engine.getCurrentEffectiveAuthority().effectiveEnd,
        Date.parse("2026-08-23T20:15:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:15:00+02:00"));
    assert.deepEqual(harness.calls, ["a", "x", "a"]);
    assert.equal(harness.requests.at(-1).initialCueSeconds, 600);
    assert.equal(harness.engine.getEffectiveSchedule().items.find(({ id }) => id === "b").startMs,
        Date.parse("2026-08-23T20:35:00+02:00"));
    assert.equal(harness.engine.getCurrentEffectiveAuthority().item.id, "a");
    assert.equal(harness.engine.getCurrentEffectiveAuthority().effectiveEnd,
        Date.parse("2026-08-23T20:35:00+02:00"));
    harness.engine.destroy();
});

test("RESUME_FIXED resumes cue without moving next hard clock", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00", null, {
        transport: { sourceId: "source-a", currentTime: 600 }, sourceKind: "media"
    });
    harness.engine.setSchedule(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-23T20:00:00+02:00", 1800),
        { ...item("x", "2026-08-23T20:10:00+02:00", 300), behavior: "INTERRUPT" },
        item("hard", "2026-08-23T20:30:00+02:00", 600)
    ] }).schedule);
    harness.engine.start();
    await flushTwice();
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:10:00+02:00"));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:15:00+02:00"));
    assert.equal(harness.requests.at(-1).initialCueSeconds, 600);
    assert.equal(harness.engine.getEffectiveSchedule().items.find(({ id }) => id === "hard").startMs,
        Date.parse("2026-08-23T20:30:00+02:00"));
    harness.engine.destroy();
});

test("HLS and BREAK interruption contexts carry no cue and nested begin is rejected", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00", null, {
        transport: { sourceId: "source-a", currentTime: 80 }, sourceKind: "hls"
    });
    harness.engine.setSchedule(schedule(item("a", "2026-08-23T20:00:00+02:00", 1800)));
    harness.engine.start();
    await flushTwice();
    const context = harness.engine.beginInterruption();
    assert.equal(context.cueAtInterruption, null);
    assert.equal(harness.engine.beginInterruption(), null);
    harness.engine.endInterruption(Date.parse("2026-08-23T20:01:00+02:00"));
    await flushTwice();
    assert.equal(harness.engine.getSnapshot().interruptionContext, null);
    harness.engine.destroy();
});

test("external interruption API explicitly ends and reissues recorded resume command", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00", null, {
        transport: { sourceId: "source-a", currentTime: 75 }, sourceKind: "audio"
    });
    harness.engine.setSchedule(schedule(item("a", "2026-08-23T20:00:00+02:00", 1800)));
    harness.engine.start();
    await flushTwice();
    assert.equal(harness.engine.beginInterruption().kind, "external");
    harness.timer.setNow(Date.parse("2026-08-23T20:01:00+02:00"));
    harness.engine.endInterruption();
    await flushTwice();
    assert.deepEqual(harness.calls, ["a", "a"]);
    assert.equal(harness.requests.at(-1).initialCueSeconds, 75);
    harness.engine.destroy();
});

function engineHarness(isoNow, failScene = null) {
    const now = { value: Date.parse(isoNow) };
    const listeners = new Map();
    const bus = {
        on: (event, listener) => listeners.set(event, listener),
        off: (event) => listeners.delete(event),
        emit: (event, value) => listeners.get(event)?.(value)
    };
    const calls = [];
    const engine = new SchedulerEngine({
        command: { execute: async (request) => {
            calls.push(request);
            return request.sceneId === failScene ? { ok: false, reason: "prepare-failed" } : { ok: true };
        } },
        catalog: { getDefinition: (id) => ({ id }) },
        eventBus: bus,
        clock: () => now.value,
        setTimer: () => 1,
        clearTimer: () => {}
    });
    return { engine, calls, now, bus };
}

function flush() { return new Promise((resolve) => setImmediate(resolve)); }

function boundaryHarness(isoNow, failScene = null, options = {}) {
    const timer = fakeTimer(Date.parse(isoNow));
    const listeners = new Map();
    const bus = {
        on: (event, listener) => listeners.set(event, listener),
        off: (event) => listeners.delete(event),
        emit: (event, value) => listeners.get(event)?.(value)
    };
    const calls = [];
    const requests = [];
    const engine = new SchedulerEngine({
        command: { execute: async (request) => {
            const { sceneId } = request;
            calls.push(sceneId);
            requests.push(request);
            return sceneId === failScene ? { ok: false, reason: "prepare-failed" } : { ok: true };
        } },
        catalog: {
            getDefinition: (id) => ({ id, renderer: { kind: "source", sourceId: `source-${id}` } }),
            getSources: () => ["a", "b", "x", "hard"].map((id) => ({
                id: `source-${id}`, kind: id === "a" ? options.sourceKind || "media" : "media"
            }))
        },
        eventBus: bus,
        clock: () => timer.now(),
        setTimer: timer.set,
        clearTimer: timer.clear,
        programTransportProvider: () => options.transport || null
    });
    return { engine, calls, requests, bus, timer };
}

function fakeTimer(initialNow) {
    let current = initialNow;
    let nextId = 1;
    const timers = new Map();
    const set = function (callback, delay) {
        assert.equal(this, undefined, "timer dependency must be invoked without engine receiver");
        const id = nextId++;
        timers.set(id, { callback, at: current + delay });
        return id;
    };
    const clear = function (id) {
        assert.equal(this, undefined, "clear dependency must be invoked without engine receiver");
        timers.delete(id);
    };
    return {
        set,
        clear,
        now: () => current,
        setNow: (timestamp) => { current = timestamp; },
        count: () => timers.size,
        nextAt: () => Math.min(...Array.from(timers.values(), ({ at }) => at)),
        async advanceTo(timestamp) {
            current = timestamp;
            for (let pass = 0; pass < 10; pass += 1) {
                const due = Array.from(timers.entries())
                    .filter(([, timer]) => timer.at <= current)
                    .sort((left, right) => left[1].at - right[1].at);
                if (!due.length) break;
                due.forEach(([id, timer]) => { timers.delete(id); timer.callback(); });
                await flushTwice();
            }
        }
    };
}

async function flushTwice() { await flush(); await flush(); }
