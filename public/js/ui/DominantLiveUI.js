export default class DominantLiveUI {
    constructor({ root, config, controller } = {}) { this.root = root; this.config = config;
        this.controller = controller; this.handleChange = this.handleChange.bind(this); }
    start() { if (this.started || !this.root || !this.config || !this.controller) return false;
        this.toggle = this.root.querySelector("#dominant-live-armed");
        this.status = this.root.querySelector("#dominant-live-status");
        this.source = this.root.querySelector("#dominant-live-source");
        if (!this.toggle || !this.status || !this.source) return false; this.started = true;
        this.toggle.addEventListener("change", this.handleChange);
        this.unsubscribe = this.controller.subscribe((snapshot) => this.render(snapshot)); return true; }
    destroy() { if (!this.started) return; this.toggle.removeEventListener("change", this.handleChange);
        this.unsubscribe?.(); this.started = false; }
    handleChange() {
        this.config.setArmed(this.toggle.checked);
        // A native checkbox changes before persistence; restore the confirmed
        // model even when no config notification was emitted by a failed write.
        this.render(this.controller.getSnapshot());
        if (this.config.lastWrite?.ok === false) {
            this.status.textContent = "CONFIG NOT SAVED";
        }
    }
    render(snapshot) { this.toggle.checked = snapshot.armed;
        this.toggle.setAttribute("aria-checked", String(snapshot.armed));
        this.status.textContent = snapshot.phase === "PREPARING"
            ? `AUTOLIVE · PREPARING · STABLE ${Math.floor(snapshot.diagnostics.entryElapsedMs / 1000)} / ${snapshot.diagnostics.entryRequiredMs / 1000} s`
            : snapshot.status; this.source.textContent = snapshot.authorizedSourceName || "NO AUTHORIZED SOURCE";
        this.root.dataset.dominantState = snapshot.status.toLowerCase().replaceAll(" ", "-"); }
}
