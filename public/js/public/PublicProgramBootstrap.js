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
        let transport = null;
        try {
            transport = await createTransport(request.signal);
            clearTimer(deadline);
            if (stopped) { transport.destroy(); return; }
            trace.record("public", "bootstrap-ready");
            await onConnected(transport);
        } catch {
            transport?.destroy();
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

// BFCache restores the document without re-evaluating its module scripts.
export function maintainPublicPage({start,stop,eventTarget=globalThis}) {
    let active=false;
    const resume=()=>{if(active)return;active=true;start();};
    const suspend=()=>{if(!active)return;active=false;stop();};
    const show=event=>{if(event.persisted)resume();};
    eventTarget.addEventListener('pagehide',suspend);
    eventTarget.addEventListener('pageshow',show);
    resume();
    return ()=>{eventTarget.removeEventListener('pagehide',suspend);eventTarget.removeEventListener('pageshow',show);suspend();};
}
