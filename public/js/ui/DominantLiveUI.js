export default class DominantLiveUI {
    constructor({ root, config, controller } = {}) { this.root = root; this.config = config;
        this.controller = controller; this.handleChange = this.handleChange.bind(this); }
    start() { if (this.started || !this.root || !this.config || !this.controller) return false;
        this.toggle = this.root.querySelector("#dominant-live-armed");
        this.status = this.root.querySelector("#dominant-live-status");
        this.source = this.root.querySelector("#dominant-live-source");
        this.consent = this.root.querySelector("#dominant-live-consent");
        this.progress = this.root.querySelector("#dominant-live-progress");
        this.technical = this.root.querySelector("#autolive-controller-diagnostics");
        if (!this.toggle || !this.status || !this.source) return false; this.started = true;
        this.toggle.addEventListener("change", this.handleChange);
        this.unsubscribe = this.controller.subscribe((snapshot) => this.render(snapshot)); return true; }
    destroy() { if (!this.started) return; this.toggle.removeEventListener("change", this.handleChange);
        this.unsubscribe?.(); this.started = false; }
    async handleChange() {
        const pending=this.config.setArmed(this.toggle.checked);
        if(pending?.then)await pending;
        // A native checkbox changes before persistence; restore the confirmed
        // model even when no config notification was emitted by a failed write.
        this.render(this.controller.getSnapshot());
        if (this.config.lastWrite?.ok === false) {
            this.status.setAttribute?.("aria-live", "polite");
            this.status.textContent = "CONFIGURAZIONE NON SALVATA";
            this.root.dataset.dominantState = "warning";
            if (this.consent) this.consent.textContent = "ATTENZIONE";
        }
    }
    render(snapshot) { this.toggle.checked = snapshot.armed;
        this.toggle.setAttribute("aria-checked", String(snapshot.armed));

        const diagnostics = snapshot.diagnostics || {};
        const adoption = diagnostics.retainedAdoption;
        const preparing = snapshot.phase === "PREPARING";
        const required = Math.max(1, (diagnostics.entryRequiredMs || 30000) / 1000);
        const elapsed = Math.min(required, Math.max(0, Math.floor((diagnostics.entryElapsedMs || 0) / 1000)));
        let label = "", warning = false;
        if (snapshot.armed) {
            if (preparing) label = 'PREPARAZIONE ' + elapsed + '/' + required;
            else if (snapshot.status === "RECOVERING" || diagnostics.acquisitionState === "RECOVERING") {
                label = "RECUPERO"; warning = true;
            } else if (snapshot.phase === "LOSS_GRACE") {
                label = ["CHECKING", "UNKNOWN", "UNCERTAIN"].includes(snapshot.health) ? "VERIFICA SEGNALE" : "RECUPERO";
                warning = label === "RECUPERO";
            } else if (snapshot.phase === "LIVE" && snapshot.session) {
                label = snapshot.health === "ONLINE" ? "LIVE" : "VERIFICA SEGNALE";
            } else if (adoption?.retainedPending) label = "RIPRISTINO IN CORSO";
            else if (!snapshot.authorizedSourceName) { label = "SELEZIONA SORGENTE"; warning = true; }
            else if (snapshot.status === "WAITING FOR SCHEDULER") { label = "AUTOLIVE NON CONSENTITO"; warning = true; }
            else if (snapshot.status === "ERROR" || snapshot.status?.includes("BLOCKED")) { label = "VERIFICA CONFIGURAZIONE"; warning = true; }
            else if (["ARMED — WAITING", "ARMED — CHECKING", "ARMED — RETRY", "ARMED — ONLINE/STABILIZING", "ARMED — ACQUIRING", "ARMED — READY", "ACTIVATING"].includes(snapshot.status)) label = "IN ATTESA";
            else { label = "VERIFICA STATO"; warning = true; }
        }
        if (this.consent) this.consent.textContent = warning ? "ATTENZIONE" : snapshot.armed ? "ON" : "OFF";
        this.status.textContent = label;
        if (this.status.dataset) this.status.dataset.tone = label === 'RECUPERO' || snapshot.status === 'ERROR' ? 'error' :
            label === 'LIVE' ? 'live' : warning || preparing || label === 'VERIFICA SEGNALE' ? 'attention' : 'neutral';
        this.source.textContent = snapshot.authorizedSourceName || "";
        if (this.progress) {
            this.progress.hidden = !preparing;
            this.progress.max = required; this.progress.value = elapsed;
            this.status.setAttribute("aria-live", preparing ? "off" : "polite");
        }
        if (this.technical) this.technical.textContent = JSON.stringify({status:snapshot.status, phase:snapshot.phase, diagnostics}, null, 2);
        this.root.dataset.dominantState = warning ? "warning" : snapshot.armed ? "armed" : "off";
    }
}
