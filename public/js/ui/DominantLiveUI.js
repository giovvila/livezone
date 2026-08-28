export default class DominantLiveUI {
    constructor({ root, config, controller } = {}) { this.root = root; this.config = config;
        this.controller = controller; this.handleChange = this.handleChange.bind(this); }
    start() { if (this.started || !this.root || !this.config || !this.controller) return false;
        this.toggle = this.root.querySelector("#dominant-live-armed");
        this.status = this.root.querySelector("#dominant-live-status");
        this.source = this.root.querySelector("#dominant-live-source");
        this.diagnostics = this.root.querySelector("#dominant-live-diagnostics");
        if (!this.toggle || !this.status || !this.source || !this.diagnostics) return false; this.started = true;
        this.toggle.addEventListener("change", this.handleChange);
        this.unsubscribe = this.controller.subscribe((snapshot) => this.render(snapshot)); return true; }
    destroy() { if (!this.started) return; this.toggle.removeEventListener("change", this.handleChange);
        this.unsubscribe?.(); this.started = false; }
    handleChange() { this.config.setArmed(this.toggle.checked); }
    render(snapshot) { this.toggle.checked = snapshot.armed;
        this.toggle.setAttribute("aria-checked", String(snapshot.armed));
        this.status.textContent = snapshot.status; this.source.textContent = snapshot.authorizedSourceName || "NO AUTHORIZED SOURCE";
        const diagnostic = snapshot.diagnostics || {};
        this.diagnostics.textContent = `DEV · STATE ${diagnostic.acquisitionState || "WAITING"}` +
            ` · HEALTH ${snapshot.health} · READY ${diagnostic.readyState ?? 0}` +
            ` · SESSION ${diagnostic.sessionState || "NONE"}` +
            ` · ${diagnostic.paused === false ? "PLAYING" : "PAUSED"}` +
            ` · ${diagnostic.width || 0}×${diagnostic.height || 0}` +
            ` · RVFC ${diagnostic.rvfcReceived ? "YES" : "NO"}` +
            ` · GEN ${diagnostic.generation ?? 0}` +
            ` · HEALTH GEN ${diagnostic.healthGeneration ?? "—"}` +
            ` · SCENE ${diagnostic.resolvedSceneId || "—"}` +
            ` · SCHEDULER ${diagnostic.schedulerStatus || "—"}` +
            ` · ACTIVE ITEM ${diagnostic.activeItemId || "null"}` +
            ` · INTERRUPTION ${diagnostic.interruptionState || "NONE"}` +
            ` · LATCH ${diagnostic.latched ? "YES" : "NO"}` +
            ` · BUSY ${diagnostic.transitionBusy ? "YES" : "NO"}` +
            ` · BEGIN ${diagnostic.beginResult || "NOT_CALLED"}` +
            ` · CONTEXT ${diagnostic.contextType || "—"}` +
            ` · PREVIEW ${diagnostic.previewReady ? "READY" : "NOT_READY"}` +
            ` · COMMAND ${diagnostic.commandResult || "NOT_CALLED"}` +
            ` · PROGRAM ${diagnostic.programCommitted ? "COMMITTED" : "NOT_COMMITTED"}` +
            ` · REASON ${diagnostic.recoveryFailure || diagnostic.blockReason || diagnostic.lastError || diagnostic.waitingReason || "—"}` +
            ` · LOSS TIMER ${diagnostic.lossTimerActive ? "ON" : "OFF"}` +
            ` · RETRY ${diagnostic.retryActive ? "ON" : "OFF"}` +
            ` · AGE L/O/R/N ${formatAge(diagnostic.lossElapsedMs)}/` +
                `${formatAge(diagnostic.offlineElapsedMs)}/${formatAge(diagnostic.retryElapsedMs)}/` +
                `${formatAge(diagnostic.onlineElapsedMs)}` +
            ` · END ${diagnostic.endResult || "—"}` +
            ` · RECOVERY ${diagnostic.recoveryResult || diagnostic.recoveryState || "IDLE"}` +
            ` · STABLE TIMER ${diagnostic.stableTimerActive ? "ON" : "OFF"}`;
        this.root.dataset.dominantState = snapshot.status.toLowerCase().replaceAll(" ", "-"); }
}

function formatAge(value) {
    return Number.isFinite(value) ? `${value}ms` : "—";
}
