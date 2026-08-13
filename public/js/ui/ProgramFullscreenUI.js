export default class ProgramFullscreenUI {

    constructor({ target, button } = {}) {
        this.target = target;
        this.button = button;
        this.started = false;

        this.handleToggle = this.handleToggle.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
    }

    start() {
        if (this.started || !this.target || !this.button) {
            return;
        }

        if (typeof this.target.requestFullscreen !== "function" ||
            typeof document.exitFullscreen !== "function") {
            this.button.hidden = true;
            return;
        }

        this.button.hidden = false;
        this.button.addEventListener("click", this.handleToggle);
        document.addEventListener(
            "fullscreenchange",
            this.handleFullscreenChange
        );
        this.started = true;
        this.renderFromState();
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.button.removeEventListener("click", this.handleToggle);
        document.removeEventListener(
            "fullscreenchange",
            this.handleFullscreenChange
        );
        this.started = false;
        this.renderFromState();
    }

    async handleToggle() {
        try {
            if (document.fullscreenElement === this.target) {
                await document.exitFullscreen();
                return;
            }

            await this.target.requestFullscreen();

            if (document.fullscreenElement === this.target) {
                await this.lockLandscape();
            }
        }
        catch {
            this.renderFromState();
        }
    }

    handleFullscreenChange() {
        if (document.fullscreenElement !== this.target) {
            this.unlockOrientation();
        }

        this.renderFromState();
    }

    renderFromState() {
        if (!this.button) {
            return;
        }

        const isFullscreen = document.fullscreenElement === this.target;
        const action = isFullscreen
            ? "Exit Program fullscreen"
            : "Enter Program fullscreen";

        this.button.setAttribute("aria-pressed", String(isFullscreen));
        this.button.setAttribute("aria-label", action);
        this.button.title = action;
        this.button.textContent = isFullscreen ? "EXIT" : "FULLSCREEN";
    }

    async lockLandscape() {
        try {
            await globalThis.screen?.orientation?.lock?.("landscape");
        }
        catch {
            // Fullscreen remains valid when orientation locking is unavailable.
        }
    }

    unlockOrientation() {
        try {
            globalThis.screen?.orientation?.unlock?.();
        }
        catch {
            // Some platforms expose unlock() but reject or restrict its use.
        }
    }
}
