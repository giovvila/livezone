export const SCHEDULE_VERSION = 1;
export const DEFAULT_TIMEZONE = "Europe/Rome";
export const MAX_SCHEDULE_ITEMS = 500;
export const DEFAULT_RESUME_POLICY = "RESUME_FIXED";

const MAX_TITLE_LENGTH = 120;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const ISO_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TRANSITIONS = new Set(["CUT", "DISSOLVE"]);
const START_MODES = new Set(["ABSOLUTE", "AFTER_PREVIOUS"]);
const BEHAVIORS = new Set(["NORMAL", "INTERRUPT"]);
const RESUME_POLICIES = new Set(["RESUME_SHIFT", "RESUME_FIXED", "FILLER"]);

export function createEmptySchedule(timezone = DEFAULT_TIMEZONE) {
    return Object.freeze({ version: SCHEDULE_VERSION, timezone, items: Object.freeze([]) });
}

export function validateSchedule(value) {
    const issues = [];

    if (!isPlainObject(value) || value.version !== SCHEDULE_VERSION ||
        !hasExactKeys(value, ["version", "timezone", "items"])) {
        return failure("invalid-schedule");
    }

    if (!isValidTimezone(value.timezone)) issues.push("invalid-timezone");
    if (!Array.isArray(value.items) || value.items.length > MAX_SCHEDULE_ITEMS) {
        issues.push("invalid-items");
    }

    const ids = new Set();
    let previousNormal = null;
    const items = [];
    if (Array.isArray(value.items)) value.items.forEach((item, index) => {
        const canonical = canonicalItem(item, index, ids, issues, previousNormal);
        if (canonical) {
            items.push(canonical);
            if (canonical.behavior === "NORMAL") previousNormal = canonical;
        }
    });

    if (items.some((item) => !item)) issues.push("invalid-item");

    const sorted = items.filter(Boolean).sort((left, right) =>
        left.startMs - right.startMs || left.id.localeCompare(right.id));

    validateBehaviorOverlaps(sorted, "NORMAL", issues);
    validateBehaviorOverlaps(sorted, "INTERRUPT", issues);

    if (issues.length) return Object.freeze({ ok: false, schedule: null, issues: Object.freeze([...new Set(issues)]) });

    return Object.freeze({
        ok: true,
        issues: Object.freeze([]),
        schedule: Object.freeze({
            version: SCHEDULE_VERSION,
            timezone: value.timezone,
            items: Object.freeze(sorted)
        })
    });
}

export function getActiveItem(schedule, now = Date.now()) {
    const timestamp = toTimestamp(now);
    if (!schedule || !Number.isFinite(timestamp)) return null;
    return getActiveInterruptItem(schedule, timestamp) ||
        getActiveNormalItem(schedule, timestamp);
}

export function getNextItem(schedule, now = Date.now()) {
    const timestamp = toTimestamp(now);
    if (!schedule || !Number.isFinite(timestamp)) return null;
    return getNextAuthorityTransition(schedule, timestamp)?.item || null;
}

export function getActiveNormalItem(schedule, now = Date.now()) {
    return getActiveByBehavior(schedule, now, "NORMAL");
}

export function getActiveInterruptItem(schedule, now = Date.now()) {
    return getActiveByBehavior(schedule, now, "INTERRUPT");
}

export function getNextAuthorityTransition(schedule, now = Date.now()) {
    const timestamp = toTimestamp(now);
    if (!schedule || !Number.isFinite(timestamp)) return null;
    const currentId = getActiveItem(schedule, timestamp)?.id || null;
    const boundaries = [...new Set(schedule.items.flatMap((item) =>
        [item.startMs, item.endMs]).filter((value) => value > timestamp))].sort((a, b) => a - b);
    for (const boundary of boundaries) {
        const item = getActiveItem(schedule, boundary);
        if ((item?.id || null) !== currentId) return Object.freeze({ timestamp: boundary, item });
    }
    return null;
}

export function getNextBoundary(schedule, now = Date.now()) {
    const timestamp = toTimestamp(now);
    const active = getActiveItem(schedule, timestamp);
    const next = getNextItem(schedule, timestamp);
    const candidates = [active?.endMs, next?.startMs]
        .filter((value) => Number.isFinite(value) && value > timestamp);
    return candidates.length ? Math.min(...candidates) : null;
}

export function resolveScheduleItems(schedule, sceneResolver) {
    return Object.freeze(schedule.items.map((item) => Object.freeze({
        ...item,
        resolved: Boolean(sceneResolver?.(item.sceneId))
    })));
}

export function zonedLocalToIso(dateValue, timeValue, timezone = DEFAULT_TIMEZONE) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || "");
    const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue || "");
    if (!match || !time || !isValidTimezone(timezone)) return null;

    const parts = [...match.slice(1), time[1], time[2], time[3] || "00"].map(Number);
    if (parts[5] > 59) return null;
    const wallMs = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    let instantMs = wallMs - timezoneOffsetMs(wallMs, timezone);
    instantMs = wallMs - timezoneOffsetMs(instantMs, timezone);
    const actual = zonedParts(instantMs, timezone);

    if (actual.some((value, index) => value !== parts[index])) return null;

    const offsetMinutes = timezoneOffsetMs(instantMs, timezone) / 60000;
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(offsetMinutes);
    const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
    return `${dateValue}T${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5])}${offset}`;
}

function canonicalItem(item, index, ids, issues, previousNormal) {
    const requiredKeys = ["id", "title", "durationSeconds", "sceneId"];
    if (!isPlainObject(item) || !hasAllowedKeys(item, requiredKeys,
        ["start", "transition", "startMode", "behavior", "resumePolicy"])) {
        issues.push(`item-structure:${index}`);
        return null;
    }

    const title = typeof item.title === "string" ? item.title.trim() : "";
    const transition = item.transition === undefined ? "CUT"
        : typeof item.transition === "string" ? item.transition.toUpperCase() : "";
    const startMode = item.startMode === undefined ? "ABSOLUTE"
        : typeof item.startMode === "string" ? item.startMode.toUpperCase() : "";
    const behavior = item.behavior === undefined ? "NORMAL"
        : typeof item.behavior === "string" ? item.behavior.toUpperCase() : "";
    const resumePolicy = item.resumePolicy === undefined ? DEFAULT_RESUME_POLICY
        : typeof item.resumePolicy === "string" ? item.resumePolicy.toUpperCase() : "";
    const absoluteStartMs = typeof item.start === "string" && ISO_WITH_ZONE_PATTERN.test(item.start)
        ? Date.parse(item.start) : NaN;

    if (!ID_PATTERN.test(item.id || "") || ids.has(item.id)) issues.push(`item-id:${index}`);
    if (!title || title.length > MAX_TITLE_LENGTH) issues.push(`item-title:${index}`);
    if (!ID_PATTERN.test(item.sceneId || "")) issues.push(`item-scene:${index}`);
    if (!Number.isInteger(item.durationSeconds) || item.durationSeconds < 1 ||
        item.durationSeconds > MAX_DURATION_SECONDS) issues.push(`item-duration:${index}`);
    if (!TRANSITIONS.has(transition)) issues.push(`item-transition:${index}`);
    if (!START_MODES.has(startMode)) issues.push(`item-start-mode:${index}`);
    if (!BEHAVIORS.has(behavior)) issues.push(`item-behavior:${index}`);
    if (!RESUME_POLICIES.has(resumePolicy)) issues.push(`item-resume-policy:${index}`);
    if (behavior === "INTERRUPT" && resumePolicy === "FILLER") {
        issues.push(`item-interrupt-filler:${index}`);
    }
    if (startMode === "ABSOLUTE" && !Number.isFinite(absoluteStartMs)) issues.push(`item-start:${index}`);
    if (startMode === "AFTER_PREVIOUS" && (!previousNormal || behavior !== "NORMAL")) {
        issues.push(`item-after-previous:${index}`);
    }
    ids.add(item.id);

    if (issues.some((issue) => issue.endsWith(`:${index}`))) return null;
    const startMs = startMode === "AFTER_PREVIOUS" ? previousNormal.endMs : absoluteStartMs;
    const endMs = startMs + item.durationSeconds * 1000;
    return Object.freeze({ id: item.id, title, startMode, behavior, resumePolicy,
        start: startMode === "ABSOLUTE" ? item.start : null,
        effectiveStart: new Date(startMs).toISOString(), durationSeconds: item.durationSeconds,
        sceneId: item.sceneId, transition, startMs, endMs });
}

function getActiveByBehavior(schedule, now, behavior) {
    const timestamp = toTimestamp(now);
    if (!schedule || !Number.isFinite(timestamp)) return null;
    return schedule.items.find((item) => item.behavior === behavior &&
        item.startMs <= timestamp && timestamp < item.endMs) || null;
}

function validateBehaviorOverlaps(items, behavior, issues) {
    const filtered = items.filter((item) => item.behavior === behavior);
    for (let index = 1; index < filtered.length; index += 1) {
        if (filtered[index].startMs < filtered[index - 1].endMs) {
            issues.push(`overlap:${filtered[index - 1].id}:${filtered[index].id}`);
        }
    }
}

function timezoneOffsetMs(timestamp, timezone) {
    const parts = zonedParts(timestamp, timezone);
    return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]) - timestamp;
}

function zonedParts(timestamp, timezone) {
    const values = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(timestamp));
    const map = Object.fromEntries(values.map(({ type, value }) => [type, value]));
    return [map.year, map.month, map.day, map.hour, map.minute, map.second].map(Number);
}

function isValidTimezone(value) {
    if (typeof value !== "string" || value.length > 80) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
    catch { return false; }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && keys.slice().sort()
        .every((key, index) => key === actual[index]);
}

function hasAllowedKeys(value, required, optional) {
    const keys = Object.keys(value);
    return required.every((key) => keys.includes(key)) &&
        keys.every((key) => required.includes(key) || optional.includes(key));
}

function toTimestamp(value) { return value instanceof Date ? value.getTime() : Number(value); }
function pad(value) { return String(value).padStart(2, "0"); }
function failure(issue) { return Object.freeze({ ok: false, schedule: null, issues: Object.freeze([issue]) }); }
