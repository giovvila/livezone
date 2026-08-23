import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSchedule } from "../public/js/scheduler/ScheduleContract.js";
import { calculateDayMetrics, getDayWindow } from
    "../public/js/scheduler/ScheduleDayMetrics.js";
import ScheduleStore from "../public/js/scheduler/ScheduleStore.js";
import ControlDeskLayoutManager from "../public/js/ui/ControlDeskLayoutManager.js";
import StudioScheduleSummaryUI from "../public/js/ui/StudioScheduleSummaryUI.js";

const createSchedule = (items) => validateSchedule({
    version: 1, timezone: "Europe/Rome", items
}).schedule;
const item = (id, start, durationSeconds, behavior = "NORMAL") => ({
    id, title: id, start, durationSeconds, sceneId: "main-live",
    transition: "CUT", behavior, resumePolicy: "RESUME_FIXED"
});

test("day window follows Europe/Rome DST day lengths", () => {
    assert.equal(getDayWindow("2026-03-29", "Europe/Rome").durationSeconds, 23 * 3600);
    assert.equal(getDayWindow("2026-10-25", "Europe/Rome").durationSeconds, 25 * 3600);
    assert.equal(getDayWindow("2026-08-23", "Europe/Rome").durationSeconds, 24 * 3600);
});

test("coverage union reports gaps without double-counting interrupt overlays", () => {
    const schedule = createSchedule([
        item("a", "2026-08-23T00:00:00+02:00", 6 * 3600),
        item("b", "2026-08-23T08:00:00+02:00", 2 * 3600),
        item("interrupt", "2026-08-23T08:15:00+02:00", 5 * 60, "INTERRUPT")
    ]);
    const result = calculateDayMetrics(schedule, "2026-08-23");
    assert.equal(result.coveredSeconds, 8 * 3600);
    assert.equal(result.uncoveredSeconds, 16 * 3600);
    assert.equal(result.coveragePercent.toFixed(2), "33.33");
    assert.equal(result.status, "PARTIAL");
});

test("cross-midnight items are clipped into both selected days", () => {
    const schedule = createSchedule([
        item("night", "2026-08-23T23:30:00+02:00", 3600)
    ]);
    assert.equal(calculateDayMetrics(schedule, "2026-08-23").coveredSeconds, 1800);
    assert.equal(calculateDayMetrics(schedule, "2026-08-24").coveredSeconds, 1800);
});

test("empty and full local days derive deterministic status", () => {
    const empty = createSchedule([]);
    assert.equal(calculateDayMetrics(empty, "2026-08-23").status, "EMPTY");
    const full = createSchedule([item("full", "2026-08-23T00:00:00+02:00", 86400)]);
    const result = calculateDayMetrics(full, "2026-08-23");
    assert.equal(result.coveragePercent, 100);
    assert.equal(result.status, "FULL");
});

test("ScheduleStore notifies local saves and validated external storage updates", () => {
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, value)
    };
    const handlers = new Map();
    const eventTarget = {
        addEventListener: (type, handler) => handlers.set(type, handler),
        removeEventListener: (type) => handlers.delete(type)
    };
    const store = new ScheduleStore({ storage, eventTarget });
    const received = [];
    const unsubscribe = store.subscribe(({ schedule }) => received.push(schedule.items.length));
    store.save(createSchedule([item("a", "2026-08-23T10:00:00+02:00", 60)]));
    values.set("livezone.scheduler.schedule.v1", JSON.stringify({
        version: 1, timezone: "Europe/Rome", items: [
            item("a", "2026-08-23T10:00:00+02:00", 60),
            item("b", "2026-08-23T11:00:00+02:00", 60)
        ]
    }));
    handlers.get("storage")({ key: "livezone.scheduler.schedule.v1", storageArea: storage });
    assert.deepEqual(received, [0, 1, 2]);
    unsubscribe();
    assert.equal(handlers.size, 0);
});

test("Control layout maps legacy schedule geometry without moving other modules", () => {
    const stored = JSON.stringify({ version: 1, modules: [
        { id: "scenes", x: 0, y: 0, w: 6, h: 4 },
        { id: "sources", x: 0, y: 11, w: 6, h: 6 },
        { id: "assets", x: 6, y: 11, w: 6, h: 7 },
        { id: "transition", x: 6, y: 0, w: 2, h: 3 },
        { id: "take", x: 8, y: 0, w: 2, h: 3 },
        { id: "broadcast", x: 10, y: 0, w: 2, h: 3 },
        { id: "media-preview", x: 0, y: 4, w: 3, h: 4 },
        { id: "lower-third", x: 3, y: 4, w: 3, h: 7 },
        { id: "channel-logo", x: 6, y: 4, w: 4, h: 7 },
        { id: "schedule", x: 0, y: 18, w: 12, h: 8 }
    ], collapsed: ["schedule", "assets"] });
    const manager = new ControlDeskLayoutManager({ root: null,
        storage: { getItem: () => stored } });
    const layout = manager.loadLayout();
    assert.deepEqual(layout.find(({ id }) => id === "sources"),
        { id: "sources", x: 0, y: 11, w: 6, h: 6 });
    assert.deepEqual(layout.find(({ id }) => id === "schedule"),
        { id: "schedule", x: 0, y: 18, w: 12, h: 8 });
    assert.equal(manager.collapsedIds.has("schedule"), true);
});

test("Schedule Workspace entry cannot instantiate a second scheduler authority", async () => {
    const source = await readFile(new URL("../public/js/entries/schedule-app.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /SchedulerEngine|StudioRenderer|ProgramOutputManager|AdaptivePlayer/);
    assert.match(source, /\["logo", "still"\]\.includes\(asset\.kind\)/,
        "workspace must reject removal when live graphics usage cannot be verified");
});

test("Control summary applies external store snapshots to its scheduler authority", () => {
    const nodes = new Map(["#studio-schedule-toggle", "#studio-schedule-status",
        "#studio-schedule-now", "#studio-schedule-current", "#studio-schedule-next"]
        .map((selector) => [selector, { textContent: "", addEventListener() {},
            removeEventListener() {}, setAttribute() {} }]));
    let storeListener;
    const applied = [];
    const engine = {
        setSchedule: (schedule) => applied.push(schedule),
        subscribe: () => () => {},
        getSnapshot: () => ({ enabled: false, status: "OFF", activeItem: null, nextItem: null })
    };
    const ui = new StudioScheduleSummaryUI({
        root: { querySelector: (selector) => nodes.get(selector) }, engine,
        store: { subscribe: (listener) => { storeListener = listener; return () => {}; } },
        catalog: { getDefinition: () => null }, setTimer: () => 1, clearTimer: () => {}
    });
    assert.equal(ui.start(), true);
    const external = createSchedule([item("external", "2026-08-23T10:00:00+02:00", 60)]);
    storeListener({ schedule: external, issues: [] });
    assert.equal(applied.at(-1), external);
    ui.destroy();
});
