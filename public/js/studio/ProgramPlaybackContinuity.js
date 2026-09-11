import { expectedPlaybackTime, validateProgramOutputSnapshot } from
    "../program-output/ProgramOutputContract.js";
import trace, { programTraceFields } from "../core/RuntimeTrace.js";

export const MAX_CONTINUITY_AGE_MS = 6 * 60 * 60 * 1000;

// Reconstruct from the existing output authority. Selection storage never owns a cue.
export function programPlaybackContinuity(candidate, { stateManager, catalog,
    sourceManager, now = Date.now() }) {
    const snapshot = validateProgramOutputSnapshot(candidate);
    const sceneId = stateManager.getProgramSceneId();
    if (!snapshot || snapshot.scene?.id !== sceneId ||
        !["media", "audio"].includes(snapshot.source?.kind)) return null;
    const age = now - Date.parse(snapshot.publishedAt);
    if (age < 0 || age > MAX_CONTINUITY_AGE_MS ||
        Date.parse(snapshot.playback.startedAt) > now ||
        !["playing", "paused", "ended"].includes(snapshot.playback.state)) return null;
    const definition = catalog.getDefinition(sceneId);
    const source = definition?.renderer?.kind === "source"
        ? sourceManager.getSource(definition.renderer.sourceId) : null;
    const mediaUrl = source?.kind === "audio" ? "audioUrl" : "url";
    if (!source || source.id !== snapshot.source.id || source.kind !== snapshot.source.kind ||
        source[mediaUrl] !== snapshot.source[mediaUrl]) return null;
    const cue = expectedPlaybackTime(snapshot, now);
    const ended = snapshot.playback.ended || snapshot.playback.duration !== null &&
        cue >= snapshot.playback.duration;
    trace.record("continuity", "retained-cue", { ...programTraceFields(snapshot), expectedTime: cue });
    return Object.freeze({ sceneId, sourceId: source.id, transportCueTime: cue,
        transportInitialPlayback: snapshot.playback.playing && !ended ? "playing" : "paused",
        transportInitialEnded: ended });
}
