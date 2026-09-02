import test from "node:test";
import assert from "node:assert/strict";
import {
    createEmptySchedule, getActiveInterruptItem, getActiveItem,
    getActiveNormalItem, getNextBoundary, getNextItem,
    resolveScheduleItems, validateSchedule, zonedLocalToIso
} from "../public/js/scheduler/ScheduleContract.js";
import ScheduleStore from "../public/js/scheduler/ScheduleStore.js";
import SchedulerEngine from "../public/js/scheduler/SchedulerEngine.js";
import SchedulerRuntimeState, { SCHEDULER_RUNTIME_STORAGE_KEY } from
    "../public/js/scheduler/SchedulerRuntimeState.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import ScheduleTargetResolver from "../public/js/scheduler/ScheduleTargetResolver.js";
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

test("Scheduler runtime persistence defaults safely and validates its versioned schema", () => {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value) };
    const state = new SchedulerRuntimeState({ storage });
    assert.deepEqual(state.load(), { version: 1, enabled: false });
    values.set(SCHEDULER_RUNTIME_STORAGE_KEY, "{");
    assert.deepEqual(state.load(), { version: 1, enabled: false });
    values.set(SCHEDULER_RUNTIME_STORAGE_KEY, JSON.stringify({ version: 2, enabled: true }));
    assert.deepEqual(state.load(), { version: 1, enabled: false });
    values.set(SCHEDULER_RUNTIME_STORAGE_KEY, JSON.stringify({ version: 1, enabled: "true" }));
    assert.deepEqual(state.load(), { version: 1, enabled: false });
    const unavailable = new SchedulerRuntimeState({ storage: {
        getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }
    } });
    assert.deepEqual(unavailable.load(), { version: 1, enabled: false });
    assert.doesNotThrow(() => unavailable.save(true));
});

test("Scheduler ON and OFF persist across runtime reconstruction without persisting transients", () => {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value) };
    const create = () => new SchedulerEngine({ command: {}, catalog: {},
        eventBus: { on() {}, off() {} }, runtimeState: new SchedulerRuntimeState({ storage }),
        setTimer: () => 1, clearTimer: () => {} });
    const first = create();
    assert.equal(first.getSnapshot().enabled, false);
    first.start();
    assert.deepEqual(JSON.parse(values.get(SCHEDULER_RUNTIME_STORAGE_KEY)), {
        version: 1, enabled: true });
    first.destroy();
    assert.equal(JSON.parse(values.get(SCHEDULER_RUNTIME_STORAGE_KEY)).enabled, true);

    const second = create();
    const observed = [];
    second.subscribe((snapshot) => observed.push(snapshot.enabled));
    assert.equal(second.restoreEnabledState(), true);
    assert.equal(second.getSnapshot().enabled, true);
    assert.equal(observed.at(-1), true);
    second.stop();
    assert.deepEqual(JSON.parse(values.get(SCHEDULER_RUNTIME_STORAGE_KEY)), {
        version: 1, enabled: false });
    second.destroy();

    const third = create();
    assert.equal(third.restoreEnabledState(), false);
    assert.equal(third.getSnapshot().enabled, false);
    third.destroy();
});

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

test("long AFTER_PREVIOUS FILLER is accepted and clipped by the next hard clock", () => {
    const afterFiller = { ...item("b", null, 43141), startMode: "AFTER_PREVIOUS",
        resumePolicy: "FILLER" };
    delete afterFiller.start;
    const values = [
        { ...item("a", "2026-08-24T00:39:00+02:00", 34),
            resumePolicy: "RESUME_FIXED" },
        afterFiller,
        { ...item("c", "2026-08-24T00:42:32+02:00", 34),
            resumePolicy: "RESUME_FIXED" }
    ];
    const result = validateSchedule({ version: 1, timezone: "Europe/Rome", items: values });
    assert.equal(result.ok, true, result.issues.join(","));
    assert.equal(result.schedule.items.find(({ id }) => id === "b").endMs,
        Date.parse("2026-08-24T00:42:32+02:00"));
    assert.equal(result.schedule.items.find(({ id }) => id === "b").durationSeconds, 43141);
    const storedBefore = JSON.stringify(result.schedule);
    const effective = calculateEffectiveSchedule(result.schedule);
    const [a, b, c] = ["a", "b", "c"].map((id) =>
        effective.items.find((entry) => entry.id === id));
    assert.equal(a.startMs, Date.parse("2026-08-24T00:39:00+02:00"));
    assert.equal(a.endMs, Date.parse("2026-08-24T00:39:34+02:00"));
    assert.equal(b.startMs, Date.parse("2026-08-24T00:39:34+02:00"));
    assert.equal(b.durationSeconds, 43141);
    assert.equal(b.endMs, Date.parse("2026-08-24T00:42:32+02:00"));
    assert.equal(c.startMs, Date.parse("2026-08-24T00:42:32+02:00"));
    assert.equal(JSON.stringify(result.schedule), storedBefore);

    const reordered = validateSchedule({ version: 1, timezone: "Europe/Rome",
        items: [values[2], values[0], values[1]] });
    assert.equal(reordered.ok, true, reordered.issues.join(","));
    assert.deepEqual(calculateEffectiveSchedule(reordered.schedule).items.map(
        ({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    effective.items.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
});

test("FILLER boundary exception preserves natural gaps and genuine overlap rejection", () => {
    const filler = { ...item("f", null, 30), startMode: "AFTER_PREVIOUS",
        resumePolicy: "FILLER" };
    delete filler.start;
    const short = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("a", "2026-08-24T00:39:00+02:00", 34), filler,
        item("c", "2026-08-24T00:42:32+02:00", 34)
    ] });
    assert.equal(short.ok, true);
    assert.equal(calculateEffectiveSchedule(short.schedule).items.find(
        ({ id }) => id === "f").endMs, Date.parse("2026-08-24T00:40:04+02:00"));

    const withoutHardClock = validateSchedule({ version: 1, timezone: "Europe/Rome",
        items: [item("a", "2026-08-24T00:39:00+02:00", 34),
            { ...filler, durationSeconds: 43141 }] });
    assert.equal(withoutHardClock.ok, true);
    assert.equal(calculateEffectiveSchedule(withoutHardClock.schedule).items.find(
        ({ id }) => id === "f").durationSeconds, 43141);

    const overlap = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        item("program-a", "2026-08-24T00:39:00+02:00", 300),
        item("program-c", "2026-08-24T00:42:32+02:00", 34)
    ] });
    assert.equal(overlap.ok, false);
    assert.match(overlap.issues.join(","), /overlap:program-a:program-c/);
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

test("schedule target contract accepts direct sources without rewriting legacy scenes", () => {
    const direct = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [{
        id: "direct", title: "Direct", target: { kind: "source", id: "source-a" },
        start: "2026-08-23T20:00:00+02:00", durationSeconds: 60
    }] });
    assert.equal(direct.ok, true);
    assert.deepEqual(direct.schedule.items[0].target, { kind: "source", id: "source-a" });

    const values = new Map();
    const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
    const store = new ScheduleStore({ storage });
    const legacy = schedule(item("legacy", "2026-08-23T20:00:00+02:00"));
    assert.equal(store.save(legacy).ok, true);
    const persisted = JSON.parse(values.get("livezone.scheduler.schedule.v1"));
    assert.equal(persisted.items[0].sceneId, "legacy");
    assert.equal(Object.hasOwn(persisted.items[0], "target"), false);

    const ambiguous = validateSchedule({ version: 1, timezone: "Europe/Rome", items: [{
        ...item("bad", "2026-08-23T21:00:00+02:00"), target: { kind: "source", id: "source-a" }
    }] });
    assert.equal(ambiguous.ok, false);
    assert.ok(ambiguous.issues.includes("item-target:0"));
});

test("direct source resolver creates deterministic runtime-only scene definitions", async () => {
    const registered = [];
    const catalog = {
        getSources: () => [
            { id: "video-a", name: "Video A", kind: "media" },
            { id: "audio-a", name: "Audio A", kind: "audio" },
            { id: "live-a", name: "Live A", kind: "hls", enabled: true },
            { id: "image-a", name: "Image A", kind: "image" }
        ],
        registerRuntimeDefinition(candidate) { registered.push(candidate); return Object.freeze(candidate); }
    };
    const resolver = new ScheduleTargetResolver({ catalog });
    for (const [id, type] of [["video-a", "MEDIA"], ["audio-a", "AUDIO"],
        ["live-a", "LIVE"], ["image-a", "IMAGE"]]) {
        const first = resolver.resolve({ kind: "source", id });
        const second = resolver.resolve({ kind: "source", id });
        assert.equal(first.sceneId, second.sceneId);
        assert.equal(first.definition.type, type);
        assert.deepEqual(first.definition.renderer, { kind: "source", sourceId: id });
    }
    assert.equal(resolver.resolve({ kind: "source", id: "missing" }), null);
    assert.ok(registered.every(({ id }) => id.startsWith("schedule-source-")));
    const dominant = new ScheduleTargetResolver({ catalog, namespace: "dominant-live-source" });
    assert.match(dominant.getRuntimeSceneId({ kind: "source", id: "live-a" }),
        /^dominant-live-source-live-a-[0-9a-f]{8}$/);
    assert.equal(dominant.getRuntimeSceneId({ kind: "source", id: "live-a" }),
        dominant.getRuntimeSceneId({ kind: "source", id: "live-a" }));
});

test("Studio command resolves direct sources through the canonical transition path", async () => {
    const transitions = [];
    const state = { preview: null, program: null };
    const targetResolver = {
        resolve: ({ id }) => id === "missing" ? null : ({ sceneId: `runtime-${id}`,
            definition: { id: `runtime-${id}`, renderer: { kind: "source", sourceId: id } } }),
        getRuntimeSceneId: ({ id }) => `runtime-${id}`
    };
    const command = new StudioProgramCommand({ targetResolver,
        stateManager: {
            getProgramSceneId: () => state.program,
            getPreviewSceneId: () => state.preview,
            setPreviewScene: (id) => { state.preview = id; return {}; }
        },
        catalog: { getSources: () => [{ id: "video-a", kind: "media" }] },
        transitionCoordinator: { isBusy: () => false,
            transition: async (options) => { transitions.push(options); state.program = state.preview; return {}; } }
    });
    assert.equal((await command.execute({ target: { kind: "source", id: "video-a" },
        transition: "CUT" })).ok, true);
    assert.equal(state.program, "runtime-video-a");
    assert.equal(transitions[0].type, "cut");
    state.program = "other";
    assert.equal((await command.execute({ target: { kind: "source", id: "video-a" },
        transition: "DISSOLVE" })).ok, true);
    assert.equal(transitions[1].type, "dissolve");
    assert.equal((await command.execute({ target: { kind: "source", id: "missing" } })).reason,
        "unresolved-source");
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

test("FILLER recovery resumes captured cue without shifting its hard boundary", async () => {
    const harness = boundaryHarness("2026-08-23T20:45:00+02:00", null, {
        transport: { sourceId: "source-f", currentTime: 37 }, sourceKind: "media"
    });
    harness.engine.setSchedule(validateSchedule({ version: 1, timezone: "Europe/Rome", items: [
        { ...item("f", "2026-08-23T20:40:00+02:00", 1200), resumePolicy: "FILLER" },
        item("hard", "2026-08-23T21:00:00+02:00", 600)
    ] }).schedule);
    harness.engine.start(); await flushTwice();
    const context = harness.engine.beginInterruption({ origin: "dominant-live" });
    assert.equal(context.cueAtInterruption, 37);
    assert.equal(context.resumePolicy, "FILLER");
    harness.timer.setNow(Date.parse("2026-08-23T20:47:00+02:00"));
    harness.engine.endInterruption(); await flushTwice();
    assert.equal(harness.requests.at(-1).sceneId, "f");
    assert.equal(harness.requests.at(-1).initialCueSeconds, 37);
    assert.equal(harness.engine.getEffectiveSchedule().items.find(({ id }) => id === "f").endMs,
        Date.parse("2026-08-23T21:00:00+02:00"));
    harness.engine.destroy();
});

test("expired FIXED interruption discards stale cue and activates current authority", async () => {
    const harness = boundaryHarness("2026-08-23T20:20:00+02:00", null, {
        transport: { sourceId: "source-a", currentTime: 37 }, sourceKind: "media"
    });
    harness.engine.setSchedule(schedule(
        item("a", "2026-08-23T20:00:00+02:00", 1800),
        item("b", "2026-08-23T20:30:00+02:00", 1800)
    ));
    harness.engine.start(); await flushTwice();
    assert.equal(harness.engine.beginInterruption({ origin: "dominant-live" }).cueAtInterruption, 37);
    harness.timer.setNow(Date.parse("2026-08-23T20:35:00+02:00"));
    harness.engine.endInterruption(); await flushTwice();
    assert.equal(harness.requests.at(-1).sceneId, "b");
    assert.equal(harness.requests.at(-1).initialCueSeconds, 300);
    assert.equal(harness.engine.resumeCues.has("a"), false);
    harness.engine.destroy();
});

test("HLS and BREAK interruption contexts carry no cue and nested begin is rejected", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00", null, {
        transport: { sourceId: "source-a", currentTime: 80 }, sourceKind: "hls"
    });
    harness.engine.setSchedule(schedule(item("a", "2026-08-23T20:00:00+02:00", 1800)));
    harness.engine.start();
    await flushTwice();
    assert.deepEqual(harness.engine.getInterruptionEligibility(), {
        allowed: true, reason: null, mode: "SCHEDULED_ITEM", activeItemId: "a", status: "ACTIVE"
    });
    const context = harness.engine.beginInterruption();
    assert.equal(context.cueAtInterruption, null);
    assert.deepEqual(harness.engine.getInterruptionEligibility(), {
        allowed: false, reason: "EXISTING_INTERRUPTION", activeItemId: "a", status: "INTERRUPTED"
    });
    assert.equal(harness.engine.beginInterruption(), null);
    harness.engine.endInterruption(Date.parse("2026-08-23T20:01:00+02:00"));
    await flushTwice();
    assert.equal(harness.engine.getSnapshot().interruptionContext, null);
    harness.engine.destroy();
});

test("empty-slot acquisition is opt-in and reconciles current authority on end", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(item("a", "2026-08-23T20:05:00+02:00", 1800)));
    harness.engine.start(); await flushTwice();
    assert.deepEqual(harness.engine.getInterruptionEligibility(), {
        allowed: false, reason: "NO_ACTIVE_ITEM", activeItemId: null, status: "ARMED"
    });
    assert.deepEqual(harness.engine.getInterruptionEligibility({ allowEmptySlot: true }), {
        allowed: true, reason: null, mode: "EMPTY_SLOT", activeItemId: null, status: "ARMED"
    });
    assert.equal(harness.engine.beginInterruption(), null);
    const context = harness.engine.beginInterruption({ origin: "dominant-live",
        sessionId: "dominant-gap", allowEmptySlot: true });
    assert.deepEqual(context, { interruptedItemId: null, sceneId: null, sourceId: null,
        sourceKind: null, interruptionItemId: null, kind: "empty-slot", origin: "dominant-live",
        sessionId: "dominant-gap", interruptedAt: Date.parse("2026-08-23T20:00:00+02:00"),
        cueAtInterruption: null, scheduledStart: null, scheduledEnd: null, resumePolicy: null });
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:05:00+02:00"));
    assert.deepEqual(harness.calls, []);
    harness.engine.endInterruption(); await flushTwice();
    assert.deepEqual(harness.calls, ["a"]);
    harness.engine.destroy();
});

test("empty-slot context survives schedule edits and recovers against the latest timeline", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(item("old", "2026-08-23T20:05:00+02:00", 1800)));
    harness.engine.start(); await flushTwice();
    harness.engine.beginInterruption({ origin: "dominant-live", sessionId: "dominant-gap",
        allowEmptySlot: true });
    harness.engine.setSchedule(schedule(item("latest", "2026-08-23T20:02:00+02:00", 1800)));
    await harness.timer.advanceTo(Date.parse("2026-08-23T20:03:00+02:00"));
    assert.equal(harness.engine.getSnapshot().interruptionContext.kind, "empty-slot");
    assert.deepEqual(harness.calls, []);
    harness.engine.endInterruption(); await flushTwice();
    assert.deepEqual(harness.calls, ["latest"]);
    harness.engine.destroy();
});

test("empty-slot interruption end releases Program when wall-clock authority is empty", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(item("future", "2026-08-23T20:05:00+02:00", 1800)));
    harness.engine.start(); await flushTwice();
    harness.engine.beginInterruption({ origin: "dominant-live", sessionId: "dominant-gap",
        allowEmptySlot: true });
    harness.engine.endInterruption(); await flushTwice();
    assert.equal(harness.engine.getSnapshot().interruptionContext, null);
    assert.deepEqual(harness.releases, [{ origin: "scheduler",
        reason: "interruption-ended-empty-slot" }]);
    assert.deepEqual(harness.calls, []);
    harness.engine.destroy();
});

test("empty-slot Program release failure is explicit Scheduler recovery failure", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00", null,
        { releaseFails: true });
    harness.engine.start(); await flushTwice();
    harness.engine.beginInterruption({ origin: "dominant-live", sessionId: "dominant-gap",
        allowEmptySlot: true });
    harness.engine.endInterruption(); await flushTwice();
    assert.deepEqual(harness.engine.getSnapshot().failure,
        { itemId: null, reason: "release-failed" });
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

test("dominant-live interruption origin does not become a manual scheduler override", async () => {
    const harness = boundaryHarness("2026-08-23T20:00:00+02:00");
    harness.engine.setSchedule(schedule(item("a", "2026-08-23T20:00:00+02:00", 1800)));
    harness.engine.start();
    await flushTwice();
    const context = harness.engine.beginInterruption({
        origin: "dominant-live", sessionId: "dominant-session-1"
    });
    assert.equal(context.origin, "dominant-live");
    assert.equal(context.sessionId, "dominant-session-1");
    harness.bus.emit(Events.STUDIO_PROGRAM_CHANGED, { source: "dominant-live" });
    assert.equal(harness.engine.getSnapshot().status, "INTERRUPTED");
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
    const releases = [];
    const engine = new SchedulerEngine({
        command: { execute: async (request) => {
            const { sceneId } = request;
            calls.push(sceneId);
            requests.push(request);
            return sceneId === failScene ? { ok: false, reason: "prepare-failed" } : { ok: true };
        }, release: (request) => { releases.push(request); return options.releaseFails
                ? { ok: false, reason: "release-failed" } : { ok: true, changed: true }; } },
        catalog: {
            getDefinition: (id) => ({ id, renderer: { kind: "source", sourceId: `source-${id}` } }),
            getSources: () => ["a", "b", "f", "x", "hard"].map((id) => ({
                id: `source-${id}`, kind: id === "a" ? options.sourceKind || "media" : "media"
            }))
        },
        eventBus: bus,
        clock: () => timer.now(),
        setTimer: timer.set,
        clearTimer: timer.clear,
        programTransportProvider: () => options.transport || null
    });
    return { engine, calls, requests, releases, bus, timer };
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
