import StudioHlsSurface from "./renderers/StudioHlsSurface.js";
import trace from "../core/RuntimeTrace.js";

export const LIVE_PROGRESS_STALL_MS = 5000;

export function createLiveHlsConsumerFactory(root, onDiagnostics = () => {}, {
    setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
    progressStallMs = LIVE_PROGRESS_STALL_MS, consumer = "dominant-live-health"
} = {}) {
    let nextId = 1;
    return (source, handlers, { monitorGeneration = null } = {}) => {
        const consumerGeneration = nextId;
        const surface = new StudioHlsSurface({
            sourceId: source.id,
            sourceUrl: source.url,
            instanceId: `${consumer}-${nextId++}`,
            consumer
        });
        trace.record("live-player", "consumer-created", { sourceId: source.id,
            consumerGeneration, monitorGeneration, instanceId: surface.instanceId, consumer });
        let unsubscribe = null;
        let video = null;
        let online = false;
        let degraded = false;
        let ready = false;
        let destroyed = false;
        let lastHealthyAt = null;
        let lossAt = null;
        let recoveryAt = null;
        let progressTimer = null;
        let lastProgressTime = null;
        let watchdogDeadline = null;
        let lastTraceAt = -Infinity;
        const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
        const events = ["loadedmetadata", "loadeddata", "canplay", "play", "playing", "pause", "waiting", "stalled", "error"];
        const edge = (event) => {
            const current = video || surface.video;
            trace.record("live-player", event, { sourceId: source.id, consumer,
                consumerGeneration, hlsGeneration: consumerGeneration, monitorGeneration,
                currentTime: current?.currentTime, readyState: current?.readyState,
                networkState: current?.networkState, paused: current?.paused,
                ended: current?.ended, lastProgressTime, lastHealthyAt,
                state: surface.getHealth()?.state, watchdogDeadline });
        };
        const clearProgressWatchdog = () => {
            if (progressTimer !== null) clearTimer(progressTimer);
            progressTimer = null;
            watchdogDeadline = null;
        };
        const reportLoss = (retry = false) => {
            if (destroyed) return;
            if (degraded) { if (retry) handlers.uncertain?.({ retry }); return; }
            degraded = true; lossAt = monotonicNow(); clearProgressWatchdog();
            edge("uncertain");
            publishDiagnostics();
            if (handlers.uncertain) handlers.uncertain({ retry });
            else handlers.offline({ recoverInPlace: true });
        };
        const armProgressWatchdog = () => {
            clearProgressWatchdog();
            if (!online || degraded || !Number.isFinite(progressStallMs) || progressStallMs <= 0) return;
            watchdogDeadline = Date.now() + progressStallMs;
            progressTimer = setTimer(() => { progressTimer = null; reportLoss(); }, progressStallMs);
        };
        const handleProgress = () => {
            const currentTime = Number(video?.currentTime);
            // HLS discontinuities may reset media time; establish a new baseline
            // then require subsequent forward progress rather than waiting for
            // the old timeline to catch up.
            if (Number.isFinite(currentTime) && lastProgressTime !== null && currentTime < lastProgressTime) {
                lastProgressTime = currentTime; edge("timeline-reset"); return;
            }
            if (destroyed || !ready || !Number.isFinite(currentTime) ||
                lastProgressTime !== null && currentTime <= lastProgressTime + 0.01) return;
            lastProgressTime = currentTime;
            lastHealthyAt = monotonicNow();
            if (!online || degraded) {
                if (degraded) recoveryAt = lastHealthyAt;
                online = true; degraded = false;
                edge("online");
                handlers.online({ width: video?.videoWidth, height: video?.videoHeight });
            }
            armProgressWatchdog();
            publishDiagnostics();
        };
        const observe = event => {
            edge(event.type);
            if (event.type === "stalled" && online) reportLoss();
            publishDiagnostics();
        };
        const publishDiagnostics = () => {
            const currentVideo = video || surface.video;
            const at = Date.now();
            if (at - lastTraceAt >= 1000) {
                lastTraceAt = at;
                let bufferedSeconds = 0;
                try { const buffer = currentVideo?.buffered;
                    if (buffer?.length) bufferedSeconds = Math.max(0,
                        buffer.end(buffer.length - 1) - currentVideo.currentTime); } catch {}
                trace.record("live-player", "sample", { sourceId: source.id, consumerGeneration,
                    currentTime: currentVideo?.currentTime, lastProgressTime,
                    readyState: currentVideo?.readyState, paused: currentVideo?.paused,
                    ended: currentVideo?.ended, bufferedSeconds, watchdogDeadline,
                    mode: surface.hls ? "hlsjs" : "native", state: surface.getHealth()?.state });
            }
            onDiagnostics(Object.freeze({
            sourceId: source.id,
            readyState: video?.readyState ?? 0,
            paused: video?.paused ?? true,
            width: video?.videoWidth ?? 0,
            height: video?.videoHeight ?? 0,
            rvfcSupported: surface.usesVideoFrameCallback,
            rvfcReceived: surface.usesVideoFrameCallback && surface.firstFramePresented,
            lastHealthyAt, lossAt, recoveryAt
        })); };
        return {
            async start() {
                unsubscribe = surface.subscribeHealth((health) => {
                    edge("health-transition");
                    publishDiagnostics();
                    if (health.state === "error") {
                        if (online) reportLoss(true);
                        else handlers.error(health.reason);
                    }
                    else if (online && health.state === "stalled") {
                        reportLoss();
                    }
                    else if (online && health.state === "ended") {
                        reportLoss(true);
                    }
                    // Decoded readiness alone is not recovery: retained HLS can replay
                    // a frozen frame. Only advancing playback may clear loss grace.
                });
                // Native play() can remain pending while the media already emits
                // readiness/progress. Register observers without awaiting it.
                void surface.start(root).catch(() => {
                    if (!destroyed) handlers.error(surface.getHealth()?.reason);
                });
                if (destroyed) return;
                video = surface.video;
                events.forEach((event) => video?.addEventListener(event, observe));
                video?.addEventListener("timeupdate", handleProgress);
                publishDiagnostics();
                surface.waitUntilReady({ timeoutMs: 12000 }).then(() => {
                    if (destroyed) return;
                    video = surface.video;
                    ready = true;
                    lastProgressTime = Number.isFinite(video?.currentTime)
                        ? video.currentTime : null;
                    publishDiagnostics();
                }).catch((error) => {
                    if (destroyed) return;
                    publishDiagnostics();
                    if (error?.code === "readiness-timeout") handlers.offline();
                    else handlers.error(surface.getHealth()?.reason);
                });
            },
            destroy() {
                destroyed = true;
                clearProgressWatchdog();
                events.forEach((event) => video?.removeEventListener(event, observe));
                video?.removeEventListener("timeupdate", handleProgress);
                unsubscribe?.();
                surface.destroy();
                video = null;
            }
        };
    };
}
