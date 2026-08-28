import StudioHlsSurface from "./renderers/StudioHlsSurface.js";

export function createDominantLiveConsumerFactory(root, onDiagnostics = () => {}) {
    let nextId = 1;
    return (source, handlers) => {
        const surface = new StudioHlsSurface({
            sourceId: source.id,
            sourceUrl: source.url,
            instanceId: `dominant-live-health-${nextId++}`,
            consumer: "dominant-live-health"
        });
        let unsubscribe = null;
        let video = null;
        let online = false;
        let degraded = false;
        let lastHealthyAt = null;
        let lossAt = null;
        let recoveryAt = null;
        const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
        const events = ["loadedmetadata", "loadeddata", "canplay", "play", "pause"];
        const publishDiagnostics = () => onDiagnostics(Object.freeze({
            sourceId: source.id,
            readyState: video?.readyState ?? 0,
            paused: video?.paused ?? true,
            width: video?.videoWidth ?? 0,
            height: video?.videoHeight ?? 0,
            rvfcSupported: surface.usesVideoFrameCallback,
            rvfcReceived: surface.usesVideoFrameCallback && surface.firstFramePresented,
            lastHealthyAt, lossAt, recoveryAt
        }));
        return {
            async start() {
                unsubscribe = surface.subscribeHealth((health) => {
                    publishDiagnostics();
                    if (health.state === "error") handlers.error(health.reason);
                    else if (online && health.state === "stalled") {
                        degraded = true; lossAt = monotonicNow();
                        publishDiagnostics();
                        handlers.offline({ recoverInPlace: true });
                    }
                    else if (online && health.state === "ended") {
                        degraded = true; lossAt = monotonicNow(); publishDiagnostics();
                        handlers.offline();
                    }
                    else if (online && degraded && health.state === "ready") {
                        degraded = false; recoveryAt = monotonicNow(); lastHealthyAt = recoveryAt;
                        publishDiagnostics();
                        handlers.online({ width: video?.videoWidth, height: video?.videoHeight });
                    }
                });
                await surface.start(root);
                video = surface.video;
                events.forEach((event) => video?.addEventListener(event, publishDiagnostics));
                publishDiagnostics();
                surface.waitUntilReady({ timeoutMs: 12000 }).then(() => {
                    video = surface.video;
                    online = true;
                    lastHealthyAt = monotonicNow();
                    publishDiagnostics();
                    handlers.online({ width: video?.videoWidth, height: video?.videoHeight });
                }).catch((error) => {
                    publishDiagnostics();
                    if (error?.code === "readiness-timeout") handlers.offline();
                    else handlers.error(surface.getHealth()?.reason);
                });
            },
            destroy() {
                events.forEach((event) => video?.removeEventListener(event, publishDiagnostics));
                unsubscribe?.();
                surface.destroy();
                video = null;
            }
        };
    };
}
