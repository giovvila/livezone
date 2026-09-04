import { validateSchedule } from "../../public/js/scheduler/ScheduleContract.js";

const SCHEMA_VERSION = 1;
const MAX_ID_LENGTH = 120;
const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 4096;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const SOURCE_KINDS = new Set(["media", "image", "audio", "hls"]);
const SCENE_TYPES = new Set(["MEDIA", "VIDEO", "IMAGE", "AUDIO", "LIVE", "SLATE"]);
const TOP_LEVEL_KEYS = ["schemaVersion", "revision", "stateId", "initialized",
    "updatedAt", "sources", "scenes", "scheduler", "globalOverlays", "dominantLive"];

export { SCHEMA_VERSION as AUTHORITATIVE_STATE_SCHEMA_VERSION };

export function createUninitializedState({ stateId, updatedAt } = {}) {
    const candidate = {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        stateId,
        initialized: false,
        updatedAt,
        sources: [],
        scenes: [],
        scheduler: { version: 1, timezone: "Europe/Rome", items: [], enabled: false },
        globalOverlays: { textCrawl: null },
        dominantLive: { armed: false, authorizedSourceId: null }
    };
    return validateAuthoritativeState(candidate);
}

export function createInitializedState(domains, { stateId, updatedAt, revision = 1 } = {}) {
    if (!isObject(domains) || !hasExactKeys(domains,
        ["sources", "scenes", "scheduler", "globalOverlays", "dominantLive"])) return null;
    return validateAuthoritativeState({ schemaVersion: SCHEMA_VERSION, revision,
        stateId, initialized: true, updatedAt, ...domains });
}

export function validateAuthoritativeState(candidate) {
    if (!isObject(candidate) || !hasExactKeys(candidate, TOP_LEVEL_KEYS) ||
        candidate.schemaVersion !== SCHEMA_VERSION ||
        !Number.isSafeInteger(candidate.revision) || candidate.revision < 0 ||
        !validId(candidate.stateId) || !validTimestamp(candidate.updatedAt) ||
        typeof candidate.initialized !== "boolean" || !Array.isArray(candidate.sources) ||
        !Array.isArray(candidate.scenes)) return null;
    if (!candidate.initialized && candidate.revision !== 0) return null;

    const sources = candidate.sources.map(validateLegacySource);
    const scenes = candidate.scenes.map(validateLegacyScene);
    if (sources.some((item) => !item) || scenes.some((item) => !item) ||
        hasDuplicateIds(sources) || hasDuplicateIds(scenes)) return null;
    const sourceIds = new Set(sources.map(({ id }) => id));
    if (scenes.some((scene) => scene.renderer.kind === "source" &&
        !sourceIds.has(scene.renderer.sourceId))) return null;

    const scheduler = validateScheduler(candidate.scheduler);
    const globalOverlays = validateGlobalOverlays(candidate.globalOverlays);
    const dominantLive = validateDominantLive(candidate.dominantLive, sources);
    if (!scheduler || !globalOverlays || !dominantLive) return null;
    const sceneIds = new Set(scenes.map(({ id }) => id));
    if (scheduler.items.some((item) => item.sceneId
        ? !sceneIds.has(item.sceneId)
        : item.target?.kind === "scene" ? !sceneIds.has(item.target.id)
        : !sourceIds.has(item.target?.id))) return null;
    if (!candidate.initialized && (sources.length || scenes.length || scheduler.items.length ||
        scheduler.enabled || globalOverlays.textCrawl !== null || dominantLive.armed ||
        dominantLive.authorizedSourceId !== null)) return null;

    return deepFreeze({ schemaVersion: SCHEMA_VERSION, revision: candidate.revision,
        stateId: candidate.stateId, initialized: candidate.initialized,
        updatedAt: candidate.updatedAt, sources, scenes, scheduler, globalOverlays,
        dominantLive });
}

function validateLegacySource(value) {
    if (!isObject(value) || !validId(value.id) ||
        !validText(value.name, MAX_NAME_LENGTH) || !SOURCE_KINDS.has(value.kind) ||
        value.origin !== undefined && !["base", "operator"].includes(value.origin)) return null;
    const common = ["id", "name", "kind"];
    const optionalOrigin = value.origin === undefined ? [] : ["origin"];
    if (["media", "image"].includes(value.kind)) {
        const authority = exactlyOne(value, "assetId", "url");
        if (!authority || !hasExactKeys(value, [...common, authority, ...optionalOrigin]) ||
            authority === "assetId" && !validId(value.assetId) ||
            authority === "url" && !validHttpUrl(value.url)) return null;
    }
    else if (value.kind === "audio") {
        const managed = Object.hasOwn(value, "audioAssetId");
        const allowed = managed ? ["audioAssetId", "stillAssetId", "motionAssetId"]
            : ["audioUrl", "stillUrl"];
        if (!hasAllowedKeys(value, [...common, managed ? "audioAssetId" : "audioUrl"],
            [...allowed.slice(1), ...optionalOrigin]) ||
            managed && !validId(value.audioAssetId) ||
            !managed && !validHttpUrl(value.audioUrl)) return null;
        if (managed && ["stillAssetId", "motionAssetId"].some((key) =>
            value[key] !== undefined && !validId(value[key]))) return null;
        if (!managed && value.stillUrl !== undefined && !validHttpUrl(value.stillUrl)) return null;
    }
    else {
        const authority = exactlyOne(value, "url", "configRef");
        if (!authority || !hasExactKeys(value,
            [...common, authority, "enabled", ...optionalOrigin]) ||
            authority === "url" && !validHttpUrl(value.url) ||
            authority === "configRef" && !validText(value.configRef, 200) ||
            typeof value.enabled !== "boolean") return null;
    }
    return clone(value);
}

function validateLegacyScene(value) {
    if (!isObject(value) || !hasAllowedKeys(value, ["id", "name", "type", "renderer"],
        ["origin"]) || !validId(value.id) || !validText(value.name, MAX_NAME_LENGTH) ||
        !SCENE_TYPES.has(value.type) || !isObject(value.renderer)) return null;
    let renderer;
    if (value.renderer.kind === "source" && hasExactKeys(value.renderer, ["kind", "sourceId"]) &&
        validId(value.renderer.sourceId)) renderer = clone(value.renderer);
    else if (value.renderer.kind === "slate" && hasExactKeys(value.renderer,
        ["kind", "title", "message", "logo"]) && validText(value.renderer.title, 200) &&
        typeof value.renderer.message === "string" && value.renderer.message.length <= 500 &&
        validHttpUrl(value.renderer.logo)) renderer = clone(value.renderer);
    else return null;
    if (value.origin !== undefined && !["base", "operator"].includes(value.origin)) return null;
    return { id: value.id, name: value.name.trim(), type: value.type, renderer,
        ...(value.origin ? { origin: value.origin } : {}) };
}

function validateScheduler(value) {
    if (!isObject(value) || !hasExactKeys(value,
        ["version", "timezone", "items", "enabled"]) || value.version !== 1 ||
        !validText(value.timezone, 80) || !validTimezone(value.timezone) ||
        !Array.isArray(value.items) || value.items.length > 500 ||
        typeof value.enabled !== "boolean") return null;
    const result = validateSchedule({ version: value.version, timezone: value.timezone,
        items: value.items });
    if (!result.ok) return null;
    return { version: 1, timezone: result.schedule.timezone,
        items: result.schedule.items.map(stripDerivedScheduleFields), enabled: value.enabled };
}

function stripDerivedScheduleFields(item) {
    return { id: item.id, title: item.title, startMode: item.startMode,
        behavior: item.behavior, resumePolicy: item.resumePolicy,
        ...(item.startMode === "ABSOLUTE" ? { start: item.start } : {}),
        durationSeconds: item.durationSeconds,
        ...(Object.hasOwn(item, "sceneId") ? { sceneId: item.sceneId }
            : { target: { kind: item.target.kind, id: item.target.id } }),
        transition: item.transition };
}

function validateGlobalOverlays(value) {
    if (!isObject(value) || !hasExactKeys(value, ["textCrawl"])) return null;
    if (value.textCrawl === null) return { textCrawl: null };
    const item = value.textCrawl;
    if (!isObject(item) || !hasExactKeys(item,
        ["enabled", "mode", "text", "direction", "speed", "position", "background"]) ||
        typeof item.enabled !== "boolean" || !["crawl", "fixed"].includes(item.mode) ||
        typeof item.text !== "string" || item.text.length > 500 ||
        !["rtl", "ltr"].includes(item.direction) ||
        !["slow", "medium", "fast"].includes(item.speed) ||
        !["top", "bottom"].includes(item.position) || typeof item.background !== "boolean") return null;
    return { textCrawl: clone(item) };
}

function validateDominantLive(value, sources) {
    if (!isObject(value) || !hasExactKeys(value, ["armed", "authorizedSourceId"]) ||
        typeof value.armed !== "boolean") return null;
    const source = value.authorizedSourceId === null ? null
        : sources.find(({ id }) => id === value.authorizedSourceId);
    if (value.authorizedSourceId !== null && (!validId(value.authorizedSourceId) ||
        source?.kind !== "hls")) return null;
    return { armed: value.armed, authorizedSourceId: value.authorizedSourceId };
}

function validId(value) { return typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value); }
function validText(value, limit) { return typeof value === "string" && Boolean(value.trim()) && value.length <= limit; }
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validTimezone(value) { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }
function validHttpUrl(value) { if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return false;
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function hasExactKeys(value, keys) { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function hasAllowedKeys(value, required, optional) { const keys = Object.keys(value); return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
function exactlyOne(value, left, right) { const hasLeft = Object.hasOwn(value, left);
    const hasRight = Object.hasOwn(value, right); return hasLeft === hasRight ? null : hasLeft ? left : right; }
function hasDuplicateIds(values) { return new Set(values.map(({ id }) => id)).size !== values.length; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
