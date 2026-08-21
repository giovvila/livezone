import { PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY } from
    "../program-output/ProgramOutputTransportFactory.js";

const STATUS_LABELS = Object.freeze({
    local: "OUTPUT · LOCAL",
    "token-missing": "OUTPUT · NETWORK TOKEN MISSING",
    "token-ready": "OUTPUT · NETWORK TOKEN CONFIGURED",
    connected: "OUTPUT · NETWORK CONNECTED",
    "auth-error": "OUTPUT · NETWORK AUTH ERROR",
    "publishing-error": "OUTPUT · NETWORK ERROR",
    disconnected: "OUTPUT · NETWORK DISCONNECTED"
});

export default class ProgramOutputSetupUI {
    constructor({ root = globalThis.document, transport,
        storage = getSessionStorage() } = {}) {
        this.root = root;
        this.transport = transport;
        this.storage = storage;
        this.started = false;
        this.handleToggle = this.handleToggle.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleClear = this.handleClear.bind(this);
        this.handleStatus = this.handleStatus.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.transport) return;
        this.status = this.root.getElementById("program-output-status");
        this.toggle = this.root.getElementById("program-output-setup-toggle");
        this.panel = this.root.getElementById("program-output-setup-panel");
        this.form = this.root.getElementById("program-output-token-form");
        this.input = this.root.getElementById("program-output-token");
        this.clearButton = this.root.getElementById("program-output-token-clear");
        if (!this.status || !this.toggle || !this.panel || !this.form ||
            !this.input || !this.clearButton) return;
        this.started = true;
        if (this.transport.mode === "local") {
            this.handleStatus("local");
            this.toggle.hidden = true;
            return;
        }
        this.toggle.addEventListener("click", this.handleToggle);
        this.form.addEventListener("submit", this.handleSubmit);
        this.clearButton.addEventListener("click", this.handleClear);
        this.unsubscribeStatus = this.transport.subscribeStatus?.(this.handleStatus);
    }

    destroy() {
        if (!this.started) return;
        this.toggle?.removeEventListener("click", this.handleToggle);
        this.form?.removeEventListener("submit", this.handleSubmit);
        this.clearButton?.removeEventListener("click", this.handleClear);
        this.unsubscribeStatus?.();
        this.input && (this.input.value = "");
        this.started = false;
    }

    handleToggle() {
        const open = this.panel.hidden;
        this.panel.hidden = !open;
        this.toggle.setAttribute("aria-expanded", String(open));
        if (open) this.input.focus();
    }

    handleSubmit(event) {
        event.preventDefault();
        const token = this.input.value.trim();
        if (!token) return;
        try { storePublisherToken(this.storage, token); }
        catch { this.handleStatus("publishing-error"); return; }
        this.input.value = "";
        this.transport.refreshPublisherCredential?.();
    }

    handleClear() {
        try { clearPublisherToken(this.storage); }
        catch { this.handleStatus("publishing-error"); return; }
        this.input.value = "";
        this.transport.refreshPublisherCredential?.();
    }

    handleStatus(state) {
        if (!this.status) return;
        this.status.textContent = STATUS_LABELS[state] || STATUS_LABELS.disconnected;
        this.status.dataset.state = state;
        this.toggle?.classList.toggle("is-attention",
            state === "token-missing" || state === "auth-error");
    }
}

function getSessionStorage() {
    try { return globalThis.sessionStorage; }
    catch { return null; }
}

export function storePublisherToken(storage, token) {
    const value = typeof token === "string" ? token.trim() : "";
    if (!value) return false;
    storage?.setItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY, value);
    return true;
}

export function clearPublisherToken(storage) {
    storage?.removeItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY);
}
