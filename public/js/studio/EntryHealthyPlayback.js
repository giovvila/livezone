import trace from "../core/RuntimeTrace.js";
import { LIVE_SOURCE_UNCERTAINTY_MS } from "./LiveSourceMonitor.js";

// Match the existing source uncertainty boundary; a fragment wait is not loss.
export const ENTRY_UNCERTAINTY_MS = LIVE_SOURCE_UNCERTAINTY_MS;
const PROGRESS_GAP_MS = 1500;

export function waitForEntryHealthyPlayback(surface, { windowMs, onProgress, signal,
    getSourceHealth = () => ({ state: "ONLINE" }), subscribeSourceHealth = () => () => {},
    consumerGeneration, clock, setTimer, clearTimer }) {
    return new Promise((resolve, reject) => {
        const video = surface.video;
        let elapsed = 0, lastAt = null, lastTime = video?.currentTime;
        let state = "PAUSED", settled = false, gapTimer, uncertaintyTimer;
        let unsubscribePlayer, unsubscribeSource;
        let gapEpoch = 0, uncertaintyEpoch = 0;
        const report = (action, reason) => {
            trace.record("autolive-entry", action, {
                sourceId: surface.sourceId, instanceId: surface.instanceId, consumerGeneration,
                stableElapsed: elapsed, sourceState: getSourceHealth().state,
                playerState: surface.getHealth?.().state || surface.readinessState,
                reason, currentTime: video?.currentTime, lastProgressAge: lastAt === null ? 0 : clock() - lastAt,
                readyState: video?.readyState, waiting: reason === "waiting", stalled: reason === "stalled",
                error: reason === "error", state: action });
            onProgress({ elapsedMs: elapsed, healthy: action === "RESUMED", reason });
        };
        const reset = reason => {
            if (settled) return;
            elapsed = 0; state = "RESET"; clearTimer(gapTimer);
            ++gapEpoch; ++uncertaintyEpoch;
            clearTimer(uncertaintyTimer); uncertaintyTimer = null;
            report("RESET", reason);
        };
        const pause = reason => {
            if (settled || state === "RESET") return;
            state = "PAUSED"; report("PAUSED", reason);
            if (uncertaintyTimer == null) {
                const epoch = ++uncertaintyEpoch;
                uncertaintyTimer = setTimer(() => {
                    if (!settled && epoch === uncertaintyEpoch) reset("uncertainty-expired");
                }, ENTRY_UNCERTAINTY_MS);
            }
        };
        const finish = reason => {
            if (settled) return;
            if (reason) reset(reason);
            settled = true; clearTimer(gapTimer); clearTimer(uncertaintyTimer);
            unsubscribePlayer?.(); unsubscribeSource?.();
            signal?.removeEventListener("abort", abort);
            video?.removeEventListener("timeupdate", progress);
            for (const name of ["waiting", "stalled", "pause", "error", "ended"]) video?.removeEventListener(name, failure);
            if (reason) reject(Object.assign(new Error(reason), { code: reason })); else resolve();
        };
        const abort = () => finish("preroll-cancelled");
        const failure = event => {
            if (["error", "ended"].includes(event.type)) finish(event.type);
            else pause(event.type);
        };
        const sourceChanged = () => {
            if (settled) return;
            const health = getSourceHealth();
            if (health.state === "OFFLINE" || health.state === "ERROR" && !health.uncertain) reset("source-offline");
            else if (health.state !== "ONLINE") pause("source-uncertain");
        };
        const progress = () => {
            if (settled) return;
            sourceChanged();
            const now = clock(), current = Number(video.currentTime);
            if (getSourceHealth().state !== "ONLINE" || surface.readinessState !== "ready" ||
                video.readyState < 2 || video.paused || video.ended || !Number.isFinite(current)) { pause("not-ready"); return; }
            if (current < lastTime) { reset("timeline-reset"); lastTime = current; return; }
            if (current <= lastTime + 0.01) return;
            // Only intervals bounded by advancing healthy samples contribute.
            // First recovery sample starts a new interval; buffering earns no time.
            if (state === "STABLE" && lastAt !== null && now - lastAt <= PROGRESS_GAP_MS)
                elapsed += Math.min(now - lastAt, Math.round((current - lastTime) * 1000000) / 1000);
            const resumed = state !== "STABLE";
            state = "STABLE"; lastAt = now; lastTime = current;
            ++uncertaintyEpoch;
            clearTimer(uncertaintyTimer); uncertaintyTimer = null;
            const epoch = ++gapEpoch;
            clearTimer(gapTimer); gapTimer = setTimer(() => {
                if (!settled && epoch === gapEpoch) pause("progress-gap");
            }, PROGRESS_GAP_MS);
            if (resumed) report("RESUMED", "playback-progress");
            else onProgress({ elapsedMs: elapsed, healthy: true });
            if (elapsed >= windowMs) finish();
        };
        if (!video) { finish("preroll-source-failed"); return; }
        video.addEventListener("timeupdate", progress);
        for (const name of ["waiting", "stalled", "pause", "error", "ended"]) video.addEventListener(name, failure);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        unsubscribeSource = subscribeSourceHealth(sourceChanged);
        unsubscribePlayer = surface.subscribeHealth(health => {
            if (settled) return;
            if (["error", "destroyed", "ended"].includes(health.state)) finish(health.state);
            else if (health.state === "stalled") pause("stalled");
        });
        if (settled) { unsubscribeSource?.(); unsubscribePlayer?.(); }
    });
}
