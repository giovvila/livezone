import trace from "../core/RuntimeTrace.js";

// Reuse observations, not ownership of the operator's Technical Monitor surface.
// Called only after SourcePresenceMonitor has classified the endpoint as external.
export function shareTechnicalLiveHealth(monitor, fallbackFactory) {
    return (source, handlers, options) => {
        let unsubscribe, fallback, stopped = false, usingTechnical = false, generation = 0;
        const matches = snapshot => snapshot.sourceId === source.id && snapshot.endpoint === source.url;
        const observe = snapshot => {
            if (stopped) return;
            if (!matches(snapshot)) {
                usingTechnical = false;
                if (!fallback) {
                    const epoch = ++generation;
                    const guarded = Object.fromEntries(Object.entries(handlers).map(([name, fn]) =>
                        [name, (...args) => { if (!stopped && !usingTechnical && epoch === generation) fn(...args); }]));
                    fallback = fallbackFactory(source, guarded, options);
                    Promise.resolve(fallback.start()).catch(() => guarded.error("NETWORK"));
                }
                return;
            }
            ++generation;
            fallback?.destroy(); fallback = null;
            if (!usingTechnical) trace.record("autolive", "technical-health-reused", { sourceId: source.id });
            usingTechnical = true;
            if (snapshot.state === "ONLINE") handlers.online({ width: snapshot.width, height: snapshot.height });
            else if (snapshot.state === "OFFLINE") handlers.offline();
            else if (snapshot.uncertain) handlers.uncertain?.();
            else if (snapshot.state === "ERROR") handlers.error(snapshot.errorCategory);
        };
        return {
            start() { unsubscribe = monitor.subscribe(observe); if (stopped) unsubscribe(); },
            destroy() { stopped = true; unsubscribe?.(); fallback?.destroy(); fallback = null; }
        };
    };
}
