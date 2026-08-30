const STORAGE_KEY = "livezone.studio.textCrawl.v1";

const DEFAULT_STATE = Object.freeze({ enabled: false, mode: "crawl", text: "",
    direction: "rtl", speed: "medium", position: "bottom", background: true });

export default class StudioTextCrawlUI {
    constructor({ root, graphicsManager, graphicId = "program-text-crawl",
        storage = globalThis.localStorage } = {}) {
        Object.assign(this, { root, graphicsManager, graphicId, storage });
        this.state = { ...DEFAULT_STATE };
        this.handleShow = this.handleShow.bind(this);
        this.handleHide = this.handleHide.bind(this);
        this.handleUpdate = this.handleUpdate.bind(this);
    }

    start() {
        if (!this.root || this.started) return;
        this.text = this.root.querySelector("#studio-text-crawl-text");
        this.mode = this.root.querySelector("#studio-text-crawl-mode");
        this.direction = this.root.querySelector("#studio-text-crawl-direction");
        this.speed = this.root.querySelector("#studio-text-crawl-speed");
        this.position = this.root.querySelector("#studio-text-crawl-position");
        this.background = this.root.querySelector("#studio-text-crawl-background");
        this.showButton = this.root.querySelector("#studio-text-crawl-show");
        this.hideButton = this.root.querySelector("#studio-text-crawl-hide");
        this.updateButton = this.root.querySelector("#studio-text-crawl-update");
        this.status = this.root.querySelector("#studio-text-crawl-status");
        if (![this.text, this.mode, this.direction, this.speed, this.position,
            this.background, this.showButton, this.hideButton, this.updateButton,
            this.status].every(Boolean)) return;
        this.state = this.readState();
        this.writeInputs(this.state);
        this.showButton.addEventListener("click", this.handleShow);
        this.hideButton.addEventListener("click", this.handleHide);
        this.updateButton.addEventListener("click", this.handleUpdate);
        this.started = true;
        if (this.state.text) this.apply(this.state.enabled);
        else this.renderStatus();
    }

    destroy() {
        if (!this.started) return;
        this.showButton.removeEventListener("click", this.handleShow);
        this.hideButton.removeEventListener("click", this.handleHide);
        this.updateButton.removeEventListener("click", this.handleUpdate);
        this.started = false;
    }

    handleShow() { this.apply(true); }
    handleHide() {
        const draft = this.readInputs();
        if (!draft.text && !this.state.text) {
            this.state = { ...this.state, enabled: false };
            this.persist();
            this.renderStatus();
            return;
        }
        if (!draft.text) {
            const next = { ...draft, text: this.state.text, enabled: false };
            this.graphicsManager.show(this.graphicId, {
                consumer: "program", payload: next
            });
            this.state = next;
            this.persist();
            this.renderStatus();
            return;
        }
        this.apply(false);
    }
    handleUpdate() { this.apply(this.state.enabled); }

    apply(enabled) {
        const draft = this.readInputs();
        if (!draft.text) {
            this.status.textContent = "TEXT REQUIRED";
            return false;
        }
        const next = { ...draft, enabled };
        const result = this.graphicsManager.show(this.graphicId, {
            consumer: "program", payload: next
        });
        this.state = next;
        this.persist();
        this.renderStatus();
        return Boolean(result);
    }

    readInputs() {
        return { enabled: this.state.enabled, text: this.text.value.trim(),
            mode: this.mode.value, direction: this.direction.value,
            speed: this.speed.value, position: this.position.value,
            background: this.background.checked };
    }

    writeInputs(value) {
        this.text.value = value.text;
        this.mode.value = value.mode;
        this.direction.value = value.direction;
        this.speed.value = value.speed;
        this.position.value = value.position;
        this.background.checked = value.background;
    }

    readState() {
        try {
            const value = JSON.parse(this.storage?.getItem(STORAGE_KEY));
            if (!value || value.version !== 1) return { ...DEFAULT_STATE };
            const candidate = value.textCrawl;
            if (!candidate || typeof candidate.enabled !== "boolean" ||
                typeof candidate.text !== "string" ||
                !["crawl", "fixed"].includes(candidate.mode) ||
                !["rtl", "ltr"].includes(candidate.direction) ||
                !["slow", "medium", "fast"].includes(candidate.speed) ||
                !["top", "bottom"].includes(candidate.position) ||
                typeof candidate.background !== "boolean") return { ...DEFAULT_STATE };
            return { ...candidate, text: candidate.text.trim() };
        }
        catch { return { ...DEFAULT_STATE }; }
    }

    persist() {
        try { this.storage?.setItem(STORAGE_KEY,
            JSON.stringify({ version: 1, textCrawl: this.state })); }
        catch { /* Persistence is optional at runtime. */ }
    }

    renderStatus() {
        this.status.textContent = this.state.enabled ? "ON AIR" : "HIDDEN";
    }
}

export { STORAGE_KEY as STUDIO_TEXT_CRAWL_STORAGE_KEY };
