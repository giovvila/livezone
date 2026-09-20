import { expectedPlaybackTime, validateProgramOutputSnapshot } from
    "../program-output/ProgramOutputContract.js";
import trace, { programTraceFields } from "../core/RuntimeTrace.js";

export const MAX_CONTINUITY_AGE_MS = 6 * 60 * 60 * 1000;

// Bootstrap identity from the same retained authority before projecting a cue.
// AutoLive authorization and Preview are deliberately not inputs to this choice.
export function restoreRetainedProgramIdentity(candidate, { stateManager, catalog,
    sourceManager, now = Date.now(), trustedDurable = null }) {
    const snapshot = validateProgramOutputSnapshot(candidate);
    const reject = reason => {
        trace.record("continuity", "identity-rejected", { ...programTraceFields(snapshot),
            reason, previousSceneId: stateManager.getProgramSceneId() });
        return false;
    };
    if (!snapshot) return reject("retained-unavailable");
    const age = now - Date.parse(snapshot.publishedAt);
    if (age < 0 || (age > MAX_CONTINUITY_AGE_MS && trustedDurable?.(candidate) !== true) || Date.parse(snapshot.playback.startedAt) > now)
        return reject("retained-stale");
    const sceneId = snapshot.scene?.id ?? null;
    if (sceneId !== null) {
        const definition = catalog.getDefinition(sceneId);
        if (!definition || !stateManager.getScene(sceneId)) return reject("scene-unavailable");
        if (snapshot.source.kind === "break") {
            if (definition.renderer.kind !== "slate" || snapshot.source.id !== sceneId || definition.renderer.title !== snapshot.source.title ||
                definition.renderer.message !== snapshot.source.message || definition.renderer.logo !== snapshot.source.logoUrl)
                return reject("source-mismatch");
        } else {
            const source = definition.renderer.kind === "source"
                ? sourceManager.getSource(definition.renderer.sourceId) : null;
            const urlField = snapshot.source.kind === "audio" ? "audioUrl" : "url";
            if (!source || source.id !== snapshot.source.id || source.kind !== snapshot.source.kind ||
                source[urlField] !== snapshot.source[urlField] || source.kind === 'audio' &&
                ['stillUrl','motionUrl'].some(field=>(source[field]??null)!==(snapshot.source[field]??null))) return reject("source-mismatch");
        }
    }
    const previousSceneId = stateManager.getProgramSceneId();
    if (sceneId !== previousSceneId) {
        const context = { source: "program-output", reason: "retained-bootstrap" };
        if (sceneId === null) stateManager.releaseProgram(context);
        else stateManager.setProgramScene(sceneId, context);
    }
    if (stateManager.getProgramSceneId() !== sceneId) return reject("identity-guarded");
    trace.record("continuity", "identity-accepted", { ...programTraceFields(snapshot), previousSceneId });
    return true;
}

// Reconstruct from the existing output authority. Selection storage never owns a cue.
export function programPlaybackContinuity(candidate, { stateManager, catalog,
    sourceManager, now = Date.now(), trustedDurable = null }) {
    const snapshot = validateProgramOutputSnapshot(candidate);
    const sceneId = stateManager.getProgramSceneId();
    if (!snapshot || snapshot.scene?.id !== sceneId ||
        !["media", "audio"].includes(snapshot.source?.kind)) return null;
    const age = now - Date.parse(snapshot.publishedAt);
    if (age < 0 || (age > MAX_CONTINUITY_AGE_MS && trustedDurable?.(candidate) !== true) ||
        Date.parse(snapshot.playback.startedAt) > now ||
        !["playing", "paused", "ended"].includes(snapshot.playback.state)) return null;
    const definition = catalog.getDefinition(sceneId);
    const source = definition?.renderer?.kind === "source"
        ? sourceManager.getSource(definition.renderer.sourceId) : null;
    const mediaUrl = source?.kind === "audio" ? "audioUrl" : "url";
    if (!source || source.id !== snapshot.source.id || source.kind !== snapshot.source.kind ||
        source[mediaUrl] !== snapshot.source[mediaUrl] || source.kind === 'audio' &&
        ['stillUrl','motionUrl'].some(field=>(source[field]??null)!==(snapshot.source[field]??null))) return null;
    const cue = expectedPlaybackTime(snapshot, now);
    const ended = snapshot.playback.ended || snapshot.playback.duration !== null &&
        cue >= snapshot.playback.duration;
    trace.record("continuity", "retained-cue", { ...programTraceFields(snapshot), expectedTime: cue });
    return Object.freeze({ sceneId, sourceId: source.id, transportCueTime: cue,
        transportInitialPlayback: snapshot.playback.playing && !ended ? "playing" : "paused",
        transportInitialEnded: ended });
}
