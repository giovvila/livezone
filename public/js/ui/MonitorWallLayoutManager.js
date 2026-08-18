const STORAGE_KEY = "livezone.monitorWall.layout.v1";
const SCHEMA_VERSION = 1;
const WALL_MIN = 50;
const WALL_MAX = 100;
const WALL_STEP = 1;
const PROPORTION_STEP = 1;
const MINIMUMS = Object.freeze({ program: 25, preview: 25, technical: 10 });
const DEFAULT_GEOMETRY = Object.freeze({
    widthPercent: 68,
    program: 40,
    preview: 40,
    technical: 20
});

export default class MonitorWallLayoutManager {

    constructor({ root, storage } = {}) {
        this.root = root;
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
        this.started = false;
        this.editMode = false;
        this.operation = null;
        this.geometry = { ...DEFAULT_GEOMETRY };

        this.handleWidthClick = this.handleWidthClick.bind(this);
        this.handlePointerDown = this.handlePointerDown.bind(this);
        this.handlePointerMove = this.handlePointerMove.bind(this);
        this.handlePointerEnd = this.handlePointerEnd.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    start() {
        if (this.started || !this.root) {
            return false;
        }

        this.widthValue = this.root.querySelector("#monitor-wall-width-value");
        this.widthDecrease = this.root.querySelector("#monitor-wall-width-decrease");
        this.widthIncrease = this.root.querySelector("#monitor-wall-width-increase");
        this.handles = Array.from(
            this.root.querySelectorAll("[data-monitor-separator]")
        );

        if (!this.widthValue || !this.widthDecrease || !this.widthIncrease ||
            this.handles.length !== 2) {
            return false;
        }

        this.widthDecrease.addEventListener("click", this.handleWidthClick);
        this.widthIncrease.addEventListener("click", this.handleWidthClick);
        this.root.addEventListener("pointerdown", this.handlePointerDown);
        this.root.addEventListener("pointermove", this.handlePointerMove);
        this.root.addEventListener("pointerup", this.handlePointerEnd);
        this.root.addEventListener("pointercancel", this.handlePointerEnd);
        this.root.addEventListener("keydown", this.handleKeyDown);
        this.geometry = this.loadGeometry();
        this.started = true;
        this.applyGeometry();
        this.setEditMode(false);
        return true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.cancelOperation();
        this.widthDecrease.removeEventListener("click", this.handleWidthClick);
        this.widthIncrease.removeEventListener("click", this.handleWidthClick);
        this.root.removeEventListener("pointerdown", this.handlePointerDown);
        this.root.removeEventListener("pointermove", this.handlePointerMove);
        this.root.removeEventListener("pointerup", this.handlePointerEnd);
        this.root.removeEventListener("pointercancel", this.handlePointerEnd);
        this.root.removeEventListener("keydown", this.handleKeyDown);
        this.setEditMode(false);
        this.started = false;
    }

    setEditMode(enabled) {
        this.editMode = Boolean(enabled);
        this.root?.classList.toggle("is-monitor-layout-editing", this.editMode);
        [this.widthDecrease, this.widthIncrease].forEach((button) => {
            if (button) {
                button.disabled = !this.editMode;
            }
        });
        this.handles?.forEach((handle) => {
            handle.tabIndex = this.editMode ? 0 : -1;
        });

        if (!this.editMode) {
            this.cancelOperation();
        }
    }

    reset() {
        this.cancelOperation();
        this.removePersistedGeometry();
        this.geometry = { ...DEFAULT_GEOMETRY };
        this.applyGeometry();
        return this.getGeometry();
    }

    getGeometry() {
        return Object.freeze({ ...this.geometry });
    }

    handleWidthClick(event) {
        if (!this.editMode) {
            return;
        }

        const direction = event.currentTarget === this.widthIncrease ? 1 : -1;
        this.geometry.widthPercent = this.clamp(
            this.geometry.widthPercent + direction * WALL_STEP,
            WALL_MIN,
            WALL_MAX
        );
        this.commitGeometry();
    }

    handlePointerDown(event) {
        const handle = event.target.closest("[data-monitor-separator]");

        if (!this.editMode || !handle || !this.root.contains(handle) ||
            event.button !== 0) {
            return;
        }

        event.preventDefault();
        handle.setPointerCapture?.(event.pointerId);
        this.operation = {
            handle,
            pointerId: event.pointerId,
            separator: handle.dataset.monitorSeparator,
            startX: event.clientX,
            startGeometry: { ...this.geometry }
        };
        handle.classList.add("is-monitor-resize-active");
    }

    handlePointerMove(event) {
        if (!this.operation || event.pointerId !== this.operation.pointerId) {
            return;
        }

        const wallWidth = this.root.getBoundingClientRect().width;

        if (!(wallWidth > 0)) {
            return;
        }

        const delta = ((event.clientX - this.operation.startX) / wallWidth) * 100;
        this.geometry = this.resizePair(
            this.operation.startGeometry,
            this.operation.separator,
            delta
        );
        this.applyGeometry();
    }

    handlePointerEnd(event) {
        if (!this.operation || event.pointerId !== this.operation.pointerId) {
            return;
        }

        this.operation.handle.releasePointerCapture?.(event.pointerId);
        this.operation.handle.classList.remove("is-monitor-resize-active");
        this.operation = null;
        this.commitGeometry();
    }

    handleKeyDown(event) {
        const handle = event.target.closest("[data-monitor-separator]");

        if (!this.editMode || !handle ||
            !["ArrowLeft", "ArrowRight"].includes(event.key)) {
            return;
        }

        event.preventDefault();
        const delta = event.key === "ArrowRight"
            ? PROPORTION_STEP
            : -PROPORTION_STEP;
        this.geometry = this.resizePair(
            this.geometry,
            handle.dataset.monitorSeparator,
            delta
        );
        this.commitGeometry();
    }

    resizePair(geometry, separator, delta) {
        const next = { ...geometry };

        if (separator === "program-preview") {
            const pairTotal = geometry.program + geometry.preview;
            next.program = this.clamp(
                geometry.program + delta,
                MINIMUMS.program,
                pairTotal - MINIMUMS.preview
            );
            next.preview = pairTotal - next.program;
        }
        else if (separator === "preview-technical") {
            const pairTotal = geometry.preview + geometry.technical;
            next.preview = this.clamp(
                geometry.preview + delta,
                MINIMUMS.preview,
                pairTotal - MINIMUMS.technical
            );
            next.technical = pairTotal - next.preview;
        }

        return this.normalizeGeometry(next);
    }

    normalizeGeometry(geometry) {
        const program = this.round(geometry.program);
        const preview = this.round(geometry.preview);
        const technical = this.round(100 - program - preview);

        return {
            widthPercent: this.round(this.clamp(
                geometry.widthPercent,
                WALL_MIN,
                WALL_MAX
            )),
            program,
            preview,
            technical
        };
    }

    isValidGeometry(value) {
        if (!value || [value.widthPercent, value.program, value.preview,
            value.technical].some((item) => !Number.isFinite(item))) {
            return false;
        }

        const sum = value.program + value.preview + value.technical;
        return value.widthPercent >= WALL_MIN && value.widthPercent <= WALL_MAX &&
            value.program >= MINIMUMS.program &&
            value.preview >= MINIMUMS.preview &&
            value.technical >= MINIMUMS.technical &&
            Math.abs(sum - 100) < 0.001;
    }

    applyGeometry() {
        const { widthPercent, program, preview, technical } = this.geometry;
        this.root.style.setProperty("--monitor-wall-width", `${widthPercent}%`);
        this.root.style.setProperty("--monitor-program-share", `${program}%`);
        this.root.style.setProperty("--monitor-preview-share", `${preview}%`);
        this.root.style.setProperty("--monitor-technical-share", `${technical}%`);
        if (this.widthValue) {
            this.widthValue.value = `${widthPercent}%`;
            this.widthValue.textContent = `${widthPercent}%`;
        }
    }

    commitGeometry() {
        this.geometry = this.normalizeGeometry(this.geometry);
        this.applyGeometry();
        this.persistGeometry();
    }

    loadGeometry() {
        try {
            const payload = JSON.parse(this.storage?.getItem(STORAGE_KEY));
            const geometry = payload?.monitorWall;

            if (payload?.version === SCHEMA_VERSION &&
                this.isValidGeometry(geometry)) {
                return this.normalizeGeometry(geometry);
            }
        }
        catch {
            // Invalid or unavailable persistence falls back to defaults.
        }

        return { ...DEFAULT_GEOMETRY };
    }

    persistGeometry() {
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify({
                version: SCHEMA_VERSION,
                monitorWall: { ...this.geometry }
            }));
        }
        catch {
            // Storage availability must not interrupt live operation.
        }
    }

    removePersistedGeometry() {
        try {
            this.storage?.removeItem(STORAGE_KEY);
        }
        catch {
            // Storage availability must not block reset.
        }
    }

    cancelOperation() {
        if (!this.operation) {
            return;
        }

        this.operation.handle.releasePointerCapture?.(this.operation.pointerId);
        this.operation.handle.classList.remove("is-monitor-resize-active");
        this.operation = null;
    }

    getDefaultStorage() {
        try {
            return globalThis.localStorage;
        }
        catch {
            return null;
        }
    }

    clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    round(value) {
        return Math.round(value * 1000) / 1000;
    }
}
