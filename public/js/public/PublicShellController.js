export default class PublicShellController {
    constructor({ page, composition, fullscreenButton, audioUnlock = null }) {
        this.page = page;
        this.composition = composition;
        this.fullscreenButton = fullscreenButton;
        this.audioUnlock = typeof audioUnlock === "function" ? audioUnlock : null;
        this.fallbackActive = false;
        this.handleFullscreenClick = this.handleFullscreenClick.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    start() {
        if (!this.page || !this.composition || !this.fullscreenButton) return;
        this.fullscreenButton.addEventListener("click", this.handleFullscreenClick);
        document.addEventListener("fullscreenchange", this.handleFullscreenChange);
        document.addEventListener("keydown", this.handleKeyDown);
    }

    destroy() {
        this.fullscreenButton?.removeEventListener("click", this.handleFullscreenClick);
        document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
        document.removeEventListener("keydown", this.handleKeyDown);
        this.setFallbackMode(false);
    }

    handleFullscreenClick() {
        if (this.fallbackActive) {
            this.setFallbackMode(false);
            return;
        }

        this.audioUnlock?.();

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
    }

    handleKeyDown(event) {
        if (event.key === "Escape" && this.fallbackActive) {
            this.setFallbackMode(false);
        }
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
    }
}
