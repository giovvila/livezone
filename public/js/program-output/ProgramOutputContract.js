const VERSION = 1;
const SOURCE_KINDS = new Set(["hls", "media", "audio", "break"]);
const POSITIONS = new Set([
    "top-left", "top-right", "bottom-left", "bottom-right"
]);
const MAX_TEXT = 500;
const MAX_URL = 4096;

export const PROGRAM_OUTPUT_VERSION = VERSION;

export function validateProgramOutputSnapshot(candidate) {
    if (!isObject(candidate) || candidate.version !== VERSION ||
        !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 ||
        !isText(candidate.publisherSessionId, 120) ||
        !isTimestamp(candidate.publishedAt) || !isTimestamp(candidate.committedAt)) {
        return null;
    }

    const isEmpty = candidate.scene === null && candidate.source === null;
    const scene = isEmpty ? null : validateScene(candidate.scene);
    const source = isEmpty ? null : validateSource(candidate.source);
    const playback = validatePlayback(candidate.playback);
    const graphics = validateGraphics(candidate.graphics);
    const transition = validateTransition(candidate.transition);

    if ((!isEmpty && (!scene || !source)) || !playback || !graphics ||
        !transition || (!isEmpty &&
        (scene.type === "SLATE") !== (source.kind === "break"))) {
        return null;
    }

    return deepFreeze({
        version: VERSION,
        revision: candidate.revision,
        publisherSessionId: candidate.publisherSessionId.trim(),
        publishedAt: candidate.publishedAt,
        committedAt: candidate.committedAt,
        scene,
        source,
        playback,
        graphics,
        transition
    });
}

export function expectedPlaybackTime(snapshot, now = Date.now()) {
    const playback = snapshot?.playback;
    if (!playback || !["media", "audio"].includes(snapshot.source?.kind)) {
        return 0;
    }
    const elapsed = playback.playing && !playback.ended
        ? Math.max(0, now - Date.parse(playback.startedAt)) / 1000
        : 0;
    const expected = playback.initialTime + elapsed;
    return playback.duration === null
        ? expected
        : Math.min(expected, playback.duration);
}

function validateScene(value) {
    return isObject(value) && isText(value.id, 120) &&
        isText(value.name, 120) && isText(value.type, 40)
        ? { id: value.id.trim(), name: value.name.trim(), type: value.type.trim() }
        : null;
}

function validateSource(value) {
    if (!isObject(value) || !isText(value.id, 120) ||
        !SOURCE_KINDS.has(value.kind)) return null;
    const source = { id: value.id.trim(), kind: value.kind };
    if (["hls", "media"].includes(value.kind)) {
        const url = validateUrl(value.url);
        return url ? { ...source, url } : null;
    }
    if (value.kind === "audio") {
        const audioUrl = validateUrl(value.audioUrl);
        const stillUrl = validateUrl(value.stillUrl);
        return audioUrl && stillUrl ? { ...source, audioUrl, stillUrl } : null;
    }
    if (!isText(value.title, 200) || !isText(value.message, MAX_TEXT)) return null;
    const logoUrl = validateUrl(value.logoUrl);
    return logoUrl ? {
        ...source, title: value.title.trim(), message: value.message.trim(), logoUrl
    } : null;
}

function validatePlayback(value) {
    if (!isObject(value) || !Number.isFinite(value.initialTime) ||
        value.initialTime < 0 || (value.duration !== null &&
        (!Number.isFinite(value.duration) || value.duration < 0)) ||
        typeof value.playing !== "boolean" || typeof value.ended !== "boolean" ||
        !isTimestamp(value.startedAt) ||
        !["ready", "playing", "paused", "ended", "error"].includes(value.state)) {
        return null;
    }
    return {
        initialTime: value.initialTime,
        duration: value.duration,
        playing: value.playing,
        ended: value.ended,
        state: value.state,
        startedAt: value.startedAt
    };
}

function validateGraphics(value) {
    if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 8) {
        return null;
    }
    const items = value.items.map((item) => {
        if (!isObject(item) || !isText(item.id, 120) ||
            !["image", "lower-third"].includes(item.kind) ||
            !POSITIONS.has(item.position)) return null;
        if (item.kind === "image") {
            const url = validateUrl(item.url);
            return url ? { id: item.id.trim(), kind: item.kind, position: item.position, url } : null;
        }
        return isText(item.title, 80) && typeof item.subtitle === "string" &&
            Array.from(item.subtitle).length <= 120
            ? { id: item.id.trim(), kind: item.kind, position: item.position,
                title: item.title.trim(), subtitle: item.subtitle.trim() }
            : null;
    });
    return items.every(Boolean) ? { items } : null;
}

function validateTransition(value) {
    if (!isObject(value) || !["cut", "dissolve"].includes(value.type) ||
        !Number.isFinite(value.durationMs) ||
        (value.type === "cut" && value.durationMs !== 0) ||
        (value.type === "dissolve" && value.durationMs !== 400)) return null;
    return { type: value.type, durationMs: value.durationMs };
}

function validateUrl(value) {
    if (!isText(value, MAX_URL)) return null;
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    }
    catch { return null; }
}

function isTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isText(value, limit) {
    return typeof value === "string" && Boolean(value.trim()) &&
        Array.from(value).length <= limit;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}
