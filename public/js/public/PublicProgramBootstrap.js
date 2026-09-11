import trace from "../core/RuntimeTrace.js";

export function bootstrapPublicProgram({ createTransport, onConnected, onWaiting = () => {},
    setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
    timeoutMs = 8000, retryMs = 1000 }) {
    let stopped = false, timer = null, deadline = null, request = null;
    const attempt = async () => {
        if (stopped) return;
        request = new AbortController();
        trace.record("public", "bootstrap-start");
        deadline = setTimer(() => request.abort(), timeoutMs);
        try {
            const transport = await createTransport(request.signal);
            clearTimer(deadline);
            if (stopped) { transport.destroy(); return; }
            trace.record("public", "bootstrap-ready");
            onConnected(transport);
        } catch {
            clearTimer(deadline);
            if (stopped) return;
            trace.record("public", "bootstrap-retry");
            onWaiting();
            timer = setTimer(() => void attempt(), retryMs);
        }
    };
    void attempt();
    return () => { stopped = true; clearTimer(timer); clearTimer(deadline); request?.abort(); };
}
