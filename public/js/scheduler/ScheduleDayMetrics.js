import { zonedLocalToIso } from "./ScheduleContract.js";

export function getDayWindow(date, timezone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return null;
    const nextDate = addLocalDays(date, 1);
    const start = zonedLocalToIso(date, "00:00:00", timezone);
    const end = zonedLocalToIso(nextDate, "00:00:00", timezone);
    const startMs = start ? Date.parse(start) : NaN;
    const endMs = end ? Date.parse(end) : NaN;
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? Object.freeze({ date, timezone, startMs, endMs,
            durationSeconds: (endMs - startMs) / 1000 }) : null;
}

export function calculateDayMetrics(schedule, date, timezone = schedule?.timezone) {
    const window = getDayWindow(date, timezone);
    if (!window) return null;
    const items = (schedule?.items || []).filter((item) =>
        item.startMs < window.endMs && item.endMs > window.startMs);
    const intervals = items.map((item) => ({
        startMs: Math.max(item.startMs, window.startMs),
        endMs: Math.min(item.endMs, window.endMs)
    })).filter(({ startMs, endMs }) => endMs > startMs);
    const merged = mergeIntervals(intervals);
    const coveredSeconds = merged.reduce((total, interval) =>
        total + (interval.endMs - interval.startMs) / 1000, 0);
    const uncoveredSeconds = Math.max(0, window.durationSeconds - coveredSeconds);
    const coveragePercent = window.durationSeconds
        ? Math.min(100, coveredSeconds / window.durationSeconds * 100) : 0;
    return Object.freeze({ ...window, items: Object.freeze(items),
        intervals: Object.freeze(merged.map(Object.freeze)), coveredSeconds,
        uncoveredSeconds, coveragePercent,
        status: coveredSeconds === 0 ? "EMPTY"
            : uncoveredSeconds === 0 ? "FULL" : "PARTIAL" });
}

export function mergeIntervals(intervals) {
    const sorted = intervals.map(({ startMs, endMs }) => ({ startMs, endMs }))
        .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    const merged = [];
    sorted.forEach((interval) => {
        const previous = merged.at(-1);
        if (!previous || interval.startMs > previous.endMs) merged.push(interval);
        else previous.endMs = Math.max(previous.endMs, interval.endMs);
    });
    return merged;
}

export function addLocalDays(date, amount) {
    const [year, month, day] = String(date).split("-").map(Number);
    if (![year, month, day, amount].every(Number.isFinite)) return null;
    const value = new Date(Date.UTC(year, month - 1, day + amount));
    return value.toISOString().slice(0, 10);
}
