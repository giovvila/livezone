const EXIT_CONTROL_TIMEOUT_MS = 3000;

export default class PublicShellController {
    constructor({ page, composition, fullscreenButton }) {
        this.page = page;
        this.composition = composition;
        this.fullscreenButton = fullscreenButton;
        this.exitButton = composition?.querySelector(".public-program__fullscreen-exit") || null;
        this.fallbackActive = false;
        this.started = false;
        this.exitHideTimer = null;
        this.handleFullscreenClick = this.handleFullscreenClick.bind(this);
        this.handleExitClick = this.handleExitClick.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handlePointerMove = this.handlePointerMove.bind(this);
        this.handlePointerDown = this.handlePointerDown.bind(this);
        this.handleExitFocus = this.handleExitFocus.bind(this);
        this.handleExitBlur = this.handleExitBlur.bind(this);
    }

    start() {
        if (this.started || !this.page || !this.composition || !this.fullscreenButton) return;
        this.started = true;
        this.fullscreenButton.addEventListener("click", this.handleFullscreenClick);
        this.exitButton?.addEventListener("click", this.handleExitClick);
        this.exitButton?.addEventListener("focus", this.handleExitFocus);
        this.exitButton?.addEventListener("blur", this.handleExitBlur);
        this.composition.addEventListener("pointermove", this.handlePointerMove);
        this.composition.addEventListener("pointerdown", this.handlePointerDown);
        document.addEventListener("fullscreenchange", this.handleFullscreenChange);
        document.addEventListener("keydown", this.handleKeyDown);
        this.syncPresentationState();
    }

    destroy() {
        if (!this.started) return;
        this.started = false;
        this.fullscreenButton?.removeEventListener("click", this.handleFullscreenClick);
        this.exitButton?.removeEventListener("click", this.handleExitClick);
        this.exitButton?.removeEventListener("focus", this.handleExitFocus);
        this.exitButton?.removeEventListener("blur", this.handleExitBlur);
        this.composition?.removeEventListener("pointermove", this.handlePointerMove);
        this.composition?.removeEventListener("pointerdown", this.handlePointerDown);
        document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
        document.removeEventListener("keydown", this.handleKeyDown);
        this.clearExitHideTimer();
        this.setFallbackMode(false);
    }

    handleFullscreenClick() {
        if (this.fallbackActive) {
            this.setFallbackMode(false);
            return;
        }

        if (typeof this.composition.requestFullscreen !== "function") {
            this.setFallbackMode(true);
            return;
        }

        const request = this.composition.requestFullscreen();
        request?.catch?.(() => this.setFallbackMode(true));
    }

    handleFullscreenChange() {
        if (document.fullscreenElement === this.composition) {
            this.setFallbackMode(false);
        }
        this.syncPresentationState();
    }

    handleExitClick(event) {
        event.stopPropagation();
        this.clearExitHideTimer();
        this.exitButton?.classList.remove("is-auto-hidden");
        this.composition.classList.remove("is-controls-idle");
        if (document.fullscreenElement) {
            void document.exitFullscreen?.();
            return;
        }
        if (this.fallbackActive) this.setFallbackMode(false);
    }

    handleKeyDown(event) {
        if (event.key === "Escape" && this.fallbackActive) {
            this.setFallbackMode(false);
        }
    }

    handlePointerMove(event) {
        if (event.pointerType === "mouse") this.revealExitControl();
    }

    handlePointerDown() {
        this.revealExitControl();
    }

    handleExitFocus() {
        this.revealExitControl();
    }

    handleExitBlur() {
        this.revealExitControl();
    }

    setFallbackMode(active) {
        this.fallbackActive = Boolean(active);
        this.page.classList.toggle("is-tv-mode", this.fallbackActive);
        this.fullscreenButton.textContent = this.fallbackActive
            ? "ESCI DA TUTTO SCHERMO"
            : "GUARDA A TUTTO SCHERMO";
        this.fullscreenButton.setAttribute(
            "aria-label",
            this.fallbackActive
                ? "Esci dalla modalità a tutto schermo"
                : "Guarda LIVEZONE a tutto schermo"
        );
        this.fullscreenButton.setAttribute("aria-pressed", String(this.fallbackActive));
        this.syncPresentationState();
    }

    syncPresentationState() {
        if (!this.exitButton) return;
        if (this.isPresentationActive()) {
            this.exitButton.hidden = false;
            this.revealExitControl();
            return;
        }
        this.clearExitHideTimer();
        this.exitButton.classList.remove("is-auto-hidden");
        this.composition.classList.remove("is-controls-idle");
        this.exitButton.hidden = true;
    }

    revealExitControl() {
        if (!this.exitButton || !this.isPresentationActive()) return;
        this.clearExitHideTimer();
        this.exitButton.classList.remove("is-auto-hidden");
        this.composition.classList.remove("is-controls-idle");
        if (document.activeElement === this.exitButton) return;
        this.exitHideTimer = setTimeout(() => {
            this.exitHideTimer = null;
            if (document.activeElement !== this.exitButton && this.isPresentationActive()) {
                this.exitButton.classList.add("is-auto-hidden");
                this.composition.classList.add("is-controls-idle");
            }
        }, EXIT_CONTROL_TIMEOUT_MS);
    }

    clearExitHideTimer() {
        clearTimeout(this.exitHideTimer);
        this.exitHideTimer = null;
    }

    isPresentationActive() {
        return document.fullscreenElement === this.composition || this.fallbackActive;
    }
}
