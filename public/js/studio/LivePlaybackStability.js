import trace from "../core/RuntimeTrace.js";
import { waitForEntryHealthyPlayback } from "./EntryHealthyPlayback.js";

export const LIVE_PLAYBACK_PROGRESS_GAP_MS = 1500;

// Gate the actual prepared Program surface, not a different health player.
export function waitForLivePlaybackStability(surface, { windowMs = 3000,
    timeoutMs = 12000, onProgress = () => {}, signal = null, isSourceOnline = () => true, getHealthEpoch = () => 0, clock = () => Date.now(),
    entryGate = false, getSourceHealth, subscribeSourceHealth, consumerGeneration,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis) } = {}) {
    if (entryGate) return waitForEntryHealthyPlayback(surface, { windowMs, onProgress, signal,
        getSourceHealth, subscribeSourceHealth, consumerGeneration, clock, setTimer, clearTimer });
    return new Promise((resolve, reject) => {
        const video = surface.video;
        let startAt = null, startTime = null, lastAt = null, lastTime = video?.currentTime;
        let deadline = null, gapTimer = null, unsubscribe = null, settled = false;
        let healthEpoch = getHealthEpoch();
        const record = (event, reason) => trace.record("preroll", event, {
            sourceId: surface.sourceId, instanceId: surface.instanceId,
            currentTime: video?.currentTime, readyState: video?.readyState,
            networkState: video?.networkState, reason });
        const reset = reason => {
            if (startAt !== null) record("stability-reset", reason);
            startAt = startTime = lastAt = null;
            lastTime = video?.currentTime;
            clearTimer(gapTimer); gapTimer = null;
            onProgress({ elapsedMs: 0, healthy: false, reason });
        };
        const cleanup = () => {
            clearTimer(deadline); clearTimer(gapTimer); unsubscribe?.();
            signal?.removeEventListener("abort", aborted);
            video?.removeEventListener("timeupdate", progress);
            for (const event of ["waiting", "stalled", "pause", "ended", "error"])
                video?.removeEventListener(event, failure);
        };
        const finish = error => {
            if (settled) return; settled = true; cleanup();
            if (error) { record("failed", error); const failure = new Error(error);
                failure.code = error; reject(failure); }
            else { record("stable"); resolve(); }
        };
        const aborted = () => finish("preroll-cancelled");
        const failure = event => {
            if (event.type === "error" || event.type === "ended") finish("preroll-source-failed");
            else reset(event.type);
        };
        const progress = () => {
            if (settled) return;
            const now = clock(), currentTime = Number(video?.currentTime);
            if (getHealthEpoch() !== healthEpoch) {
                const previousTime = lastTime;
                healthEpoch = getHealthEpoch(); reset("source-health-edge");
                lastTime = previousTime;
            }
            if (!isSourceOnline() || surface.readinessState !== "ready" ||
                video.readyState < 2 || video.paused || video.ended || !Number.isFinite(currentTime)) {
                reset("not-ready"); return;
            }
            if (lastTime !== null && currentTime < lastTime) { reset("timeline-reset"); return; }
            if (lastTime !== null && currentTime <= lastTime + 0.01) return;
            if (lastAt !== null && now - lastAt > LIVE_PLAYBACK_PROGRESS_GAP_MS) reset("progress-gap");
            if (startAt === null) { startAt = now; startTime = currentTime; record("stability-start"); }
            lastAt = now; lastTime = currentTime;
            clearTimer(gapTimer);
            gapTimer = setTimer(() => reset("progress-gap"), LIVE_PLAYBACK_PROGRESS_GAP_MS);
            onProgress({ elapsedMs: now - startAt, healthy: true });
            // Both wall time and advancing media are required. A timer or one
            // decoded frame alone cannot authorize a TAKE.
            if (now - startAt >= windowMs && currentTime - startTime >= windowMs / 1000 * 0.8)
                finish();
        };
        if (!video || timeoutMs !== null && timeoutMs <= 0) { finish("preroll-timeout"); return; }
        video.addEventListener("timeupdate", progress);
        for (const event of ["waiting", "stalled", "pause", "ended", "error"])
            video.addEventListener(event, failure);
        if (timeoutMs !== null) deadline = setTimer(() => finish("preroll-timeout"), timeoutMs);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) { aborted(); return; }
        unsubscribe = surface.subscribeHealth(health => {
            if (["error", "destroyed", "ended"].includes(health.state)) finish("preroll-source-failed");
            else if (health.state === "stalled") reset("stalled");
        });
        if (settled) unsubscribe?.();
    });
}
