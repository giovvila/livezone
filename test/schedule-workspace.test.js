import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSchedule } from "../public/js/scheduler/ScheduleContract.js";
import { calculateDayMetrics, getDayWindow } from
    "../public/js/scheduler/ScheduleDayMetrics.js";
import ScheduleStore from "../public/js/scheduler/ScheduleStore.js";
import ControlDeskLayoutManager from "../public/js/ui/ControlDeskLayoutManager.js";
import StudioScheduleSummaryUI from "../public/js/ui/StudioScheduleSummaryUI.js";
import ScheduleWorkspaceUI, { formatClock } from "../public/js/ui/ScheduleWorkspaceUI.js";
import MonitorWallLayoutManager from "../public/js/ui/MonitorWallLayoutManager.js";
import ScheduleClock from "../public/js/ui/ScheduleClock.js";

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

test("editorial clock preserves HH:MM:SS in Europe/Rome with one aligned timeout", () => {
    const timestamp = Date.parse("2026-08-25T08:37:24.250Z");
    assert.equal(formatClock(timestamp, "Europe/Rome"), "10:37:24");
    const timers = [];
    const ui = new ScheduleWorkspaceUI({ clock: () => timestamp,
        setTimer: (callback, delay) => { timers.push({ callback, delay }); return 9; },
        clearTimer() {} });
    ui.started = true;
    ui.liveClock = { textContent: "", dateTime: "" };
    ui.clockTimezone = { textContent: "" };
    ui.tickClock();
    assert.equal(ui.liveClock.textContent, "10:37:24");
    assert.equal(ui.clockTimezone.textContent, "EUROPE/ROME");
    assert.deepEqual(timers.map(({ delay }) => delay), [750]);
});

test("Control schedule summary and day view share one aligned clock timeout", () => {
    const timers = [];
    const ticker = new ScheduleClock({ clock: () => 1250,
        setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
        clearTimer() {} });
    const received = [[], []];
    const first = ticker.subscribe((value) => received[0].push(value));
    const second = ticker.subscribe((value) => received[1].push(value));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 750);
    assert.deepEqual(received, [[1250], [1250]]);
    first(); second();
});

test("monitor geometry changes Program and Preview independently", () => {
    const manager = new MonitorWallLayoutManager({ root: null, storage: null });
    const initial = manager.getGeometry();
    const program = manager.resizeMonitor(initial, "program",
        { widthDelta: -20, heightDelta: -100 });
    assert.equal(program.program.widthPercent, 29);
    assert.equal(program.program.heightPx, 260);
    assert.deepEqual(program.preview, initial.preview);
    const preview = manager.resizeMonitor(program, "preview",
        { widthDelta: 15, heightDelta: -80 });
    assert.deepEqual(preview.program, program.program);
    assert.equal(preview.preview.widthPercent, 64);
    assert.equal(preview.preview.heightPx, 280);
});

test("monitor geometry migrates v1, persists v2, reloads and resets", () => {
    let stored = JSON.stringify({ version: 1, monitorWall: {
        widthPercent: 68, program: 60, preview: 30, technical: 10 } });
    const storage = { getItem: () => stored,
        setItem: (_key, value) => { stored = value; }, removeItem: () => { stored = null; } };
    const manager = new MonitorWallLayoutManager({
        root: { style: { setProperty() {} } }, storage
    });
    const migrated = manager.loadGeometry();
    assert.equal(migrated.wallWidthPercent, 68);
    assert.equal(Math.round(migrated.program.widthPercent), 65);
    assert.equal(Math.round(migrated.preview.widthPercent), 33);
    manager.geometry = manager.resizeMonitor(migrated, "preview", { heightDelta: 50 });
    manager.persistGeometry();
    assert.equal(JSON.parse(stored).version, 2);
    assert.deepEqual(manager.loadGeometry(), manager.geometry);
    manager.reset();
    assert.equal(manager.getGeometry().wallWidthPercent, 78);
    assert.equal(manager.getGeometry().program.widthPercent, 49);
    assert.equal(manager.getGeometry().preview.widthPercent, 49);
    assert.equal(manager.getGeometry().program.heightPx, 360);
    assert.equal(manager.getGeometry().preview.heightPx, 360);
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

test("Control layout drops legacy schedule geometry without moving other modules", () => {
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
    assert.deepEqual(layout.find(({ id }) => id === "technical-monitor"),
        { id: "technical-monitor", x: 0, y: 17, w: 6, h: 7 });
    assert.equal(layout.some(({ id }) => id === "schedule"), false);
    assert.equal(manager.collapsedIds.has("schedule"), false);
    assert.equal(manager.collapsedIds.has("assets"), false);
});

test("Control DOM registers one Technical Monitor and one unified operational schedule", async () => {
    const html = await readFile(new URL("../public/control/index.html", import.meta.url), "utf8");
    const moduleIds = Array.from(html.matchAll(/data-control-module="([^"]+)"/g),
        (match) => match[1]);
    assert.equal(new Set(moduleIds).size, moduleIds.length);
    assert.equal(moduleIds.filter((id) => id === "technical-monitor").length, 1);
    assert.equal(moduleIds.includes("schedule"), false);
    ["studio-schedule-status", "studio-schedule-now", "studio-schedule-current",
        "studio-schedule-next", "studio-schedule-toggle"].forEach((id) =>
        assert.match(html, new RegExp(`id="${id}"`)));
    ["control-schedule-view", "schedule-live-clock", "schedule-item-list",
        "schedule-timeline", "schedule-week"].forEach((id) =>
        assert.match(html, new RegExp(`id="${id}"`)));
    assert.match(html, /href="\.\/schedule\/">ADD \/ EDIT PALINSESTO/);
    const deskEnd = html.indexOf("</aside>", html.indexOf('id="studio-panel"'));
    const scheduleStart = html.indexOf('id="control-schedule-view"');
    assert.ok(deskEnd > 0 && scheduleStart > deskEnd,
        "the unified schedule must be a sibling after the complete ControlDesk");
    const workspaceStart = html.indexOf('id="control-desk-workspace"');
    const workspaceEnd = deskEnd;
    const workspaceMarkup = html.slice(workspaceStart, workspaceEnd);
    const deskMarkers = Array.from(workspaceMarkup.matchAll(
        /data-control-desk-module="([^"]+)"/g), (match) => match[1]);
    assert.equal(deskMarkers.length, 9);
    assert.deepEqual(new Set(deskMarkers), new Set([
        "scenes", "sources", "transition", "take", "broadcast",
        "media-preview", "lower-third", "channel-logo", "technical-monitor"
    ]));
    assert.equal(workspaceMarkup.includes("control-schedule-view"), false);
    assert.match(html, /<\/aside>\s*<section id="control-schedule-view"/);
    ["scenes", "sources", "transition", "take", "broadcast", "media-preview",
        "lower-third", "channel-logo", "technical-monitor"].forEach((id) =>
        assert.equal(moduleIds.filter((moduleId) => moduleId === id).length, 1));
    assert.equal((html.match(/id="studio-take"/g) || []).length, 1);
});

test("Control three-row flow gives ControlDesk intrinsic height before schedule", async () => {
    const css = await readFile(new URL("../public/css/studio.css", import.meta.url), "utf8");
    assert.match(css, /\.control-room-console\s*\{[^}]*grid-template-rows:\s*max-content max-content max-content/s);
    assert.doesNotMatch(css, /\.control-room-console\s*\{[^}]*grid-template-rows:\s*auto auto auto/s);
    assert.match(css, /\.studio-panel\s*\{[^}]*min-height:\s*min-content;[^}]*overflow:\s*visible;/s);
    assert.doesNotMatch(css, /\.control-room-console\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
});

test("ControlDesk materializes the active module bottom boundary as workspace height", () => {
    const manager = new ControlDeskLayoutManager({ root: null, storage: null });
    const clean = manager.createResponsiveLayout(manager.createDefaultLayout(), 12);
    assert.ok(manager.calculateWorkspaceHeight(clean) > 0);
    assert.equal(manager.calculateWorkspaceHeight([{ id: "take", x: 0, y: 2, w: 2, h: 1 }]),
        132);
    manager.collapsedIds = new Set(clean.map(({ id }) => id));
    const collapsed = manager.createResponsiveLayout(manager.createDefaultLayout(), 12);
    assert.ok(collapsed.every(({ h }) => h === 1));
    assert.ok(manager.calculateWorkspaceHeight(collapsed) > 0);
    assert.equal(manager.calculateCompactWorkspaceHeight(9), 84);
    assert.equal(manager.calculateCompactWorkspaceHeight(5), 176);
    assert.equal(manager.calculateCompactWorkspaceHeight(3), 268);
    assert.equal(manager.calculateCompactWorkspaceHeight(2), 452);
    assert.equal(manager.calculateCompactWorkspaceHeight(1), 820);
    assert.equal(manager.calculateWorkspaceHeight([
        { id: "take", x: 0, y: 6, w: 2, h: 4 }
    ]), 468);
});

test("clean and reset ControlDesk use a visible one-row compact module strip", () => {
    const manager = new ControlDeskLayoutManager({ root: null,
        storage: { getItem: () => null, removeItem() {} } });
    const layout = manager.loadLayout();
    assert.equal(manager.collapsedIds.size, 9);
    const compact = manager.createResponsiveLayout(layout, 12);
    assert.equal(new Set(compact.map(({ y }) => y)).size, 1);
    assert.equal(compact.reduce((total, { w }) => total + w, 0), 12);
    assert.equal(manager.calculateWorkspaceHeight(compact), 36);
    assert.equal(manager.getCompactColumnCount(1600), 9);
    assert.equal(manager.getCompactColumnCount(1000), 5);
    assert.equal(manager.getCompactColumnCount(700), 3);
    assert.equal(manager.getCompactColumnCount(440), 2);
    assert.equal(manager.getCompactColumnCount(300), 1);
    assert.equal(manager.calculateCompactWorkspaceHeight(
        manager.getCompactColumnCount(1600)
    ), 84);
});

test("normal ControlDesk expansion keeps sibling cards in the intrinsic grid", async () => {
    const css = await readFile(new URL("../public/css/studio.css", import.meta.url), "utf8");
    const managerSource = await readFile(new URL(
        "../public/js/ui/ControlDeskLayoutManager.js", import.meta.url), "utf8");

    assert.match(css,
        /\.studio-panel:not\(\.is-layout-editing\) \.control-desk__workspace\s*\{[^}]*grid-auto-rows:\s*max-content;[^}]*align-items:\s*start;[^}]*height:\s*max-content !important;/s);
    assert.match(css,
        /@media \(max-width: 760px\)\s*\{[\s\S]*?\.control-room-console\s*\{[^}]*grid-template-rows:\s*max-content max-content max-content;[^}]*grid-auto-rows:\s*max-content;/s);
    assert.match(css,
        /\.studio-panel:not\(\.is-layout-editing\) \.control-desk__module\.is-collapsed\s*\{[^}]*height:\s*84px;/s);
    assert.match(css,
        /\.studio-panel:not\(\.is-layout-editing\) \.control-desk__module\s*\{[^}]*align-self:\s*start;[^}]*height:\s*auto;/s);
    assert.match(managerSource,
        /if \(this\.editMode\) \{[\s\S]*element\.style\.gridColumn[\s\S]*else \{\s*element\.style\.gridColumn = "";\s*element\.style\.gridRow = "";/);
    assert.match(managerSource,
        /if \(this\.editMode\) \{[\s\S]*this\.workspace\.style\.height = `\$\{height\}px`;[\s\S]*else \{\s*this\.workspace\.style\.height = "";\s*this\.workspace\.style\.minHeight = "";/);
});

test("Control entry reuses one store and clock without duplicate runtime authorities", async () => {
    const source = await readFile(new URL("../public/js/entries/control-room-app.js",
        import.meta.url), "utf8");
    assert.equal((source.match(/new SchedulerEngine\(/g) || []).length, 1);
    assert.equal((source.match(/new ScheduleStore\(/g) || []).length, 1);
    assert.equal((source.match(/new ScheduleClock\(/g) || []).length, 1);
    assert.equal((source.match(/new TechnicalLiveMonitorUI\(/g) || []).length, 1);
    assert.equal((source.match(/new StudioRenderer\(/g) || []).length, 1);
    assert.match(source,
        /studioScheduleUI\.start\(\);\s*schedulerEngine\.restoreEnabledState\(\);/);
});

test("Schedule Workspace entry cannot instantiate a second scheduler authority", async () => {
    const source = await readFile(new URL("../public/js/entries/schedule-app.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /SchedulerEngine|StudioRenderer|ProgramOutputManager|AdaptivePlayer/);
    assert.match(source, /\["logo", "still"\]\.includes\(asset\.kind\)/,
        "workspace must reject removal when live graphics usage cannot be verified");
    assert.match(source, /dataset\.schedulerEnabled\s*=\s*String\(schedulerRuntimeState\.load\(\)\.enabled\)/);
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

test("Scheduler label reflects enabled state instead of the inverse action", () => {
    const toggle = { textContent: "", addEventListener() {}, removeEventListener() {},
        setAttribute() {} };
    const nodes = new Map([
        ["#studio-schedule-toggle", toggle],
        ["#studio-schedule-status", { textContent: "" }],
        ["#studio-schedule-now", { textContent: "" }],
        ["#studio-schedule-current", { textContent: "" }],
        ["#studio-schedule-next", { textContent: "" }]
    ]);
    let enabled = false;
    const ui = new StudioScheduleSummaryUI({
        root: { querySelector: (selector) => nodes.get(selector) },
        engine: { getSnapshot: () => ({ enabled, activeItem: null, nextItem: null }),
            subscribe: () => () => {}, setSchedule() {} },
        store: { subscribe: () => () => {} }, catalog: { getDefinition: () => null }
    });
    assert.equal(ui.start(), true);
    ui.render(); assert.equal(toggle.textContent, "SCHEDULER OFF");
    enabled = true; ui.render(); assert.equal(toggle.textContent, "SCHEDULER ON");
    ui.destroy();
});
