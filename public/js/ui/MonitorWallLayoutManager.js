const STORAGE_KEY = "livezone.monitorWall.layout.v1";
const SCHEMA_VERSION = 2;
const WALL_MIN = 50, WALL_MAX = 100, WALL_STEP = 1;
const WIDTH_MIN = 24, WIDTH_MAX = 100, HEIGHT_MIN = 190, HEIGHT_MAX = 720;
const DEFAULT_GEOMETRY = Object.freeze({ wallWidthPercent: 78,
    program: Object.freeze({ widthPercent: 49, heightPx: 360 }),
    preview: Object.freeze({ widthPercent: 49, heightPx: 360 }) });

export default class MonitorWallLayoutManager {
    constructor({ root, storage } = {}) {
        this.root = root; this.storage = storage === undefined ? this.getDefaultStorage() : storage;
        this.geometry = this.cloneGeometry(DEFAULT_GEOMETRY); this.started = false;
        this.handleWidthClick = this.handleWidthClick.bind(this);
        this.handlePointerDown = this.handlePointerDown.bind(this);
        this.handlePointerMove = this.handlePointerMove.bind(this);
        this.handlePointerEnd = this.handlePointerEnd.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }
    start() {
        if (this.started || !this.root) return false;
        this.widthValue = this.root.querySelector("#monitor-wall-width-value");
        this.widthDecrease = this.root.querySelector("#monitor-wall-width-decrease");
        this.widthIncrease = this.root.querySelector("#monitor-wall-width-increase");
        this.handles = Array.from(this.root.querySelectorAll("[data-monitor-resize]"));
        if (!this.widthValue || !this.widthDecrease || !this.widthIncrease || this.handles.length !== 2) return false;
        this.widthDecrease.addEventListener("click", this.handleWidthClick);
        this.widthIncrease.addEventListener("click", this.handleWidthClick);
        this.root.addEventListener("pointerdown", this.handlePointerDown);
        this.root.addEventListener("pointermove", this.handlePointerMove);
        this.root.addEventListener("pointerup", this.handlePointerEnd);
        this.root.addEventListener("pointercancel", this.handlePointerEnd);
        this.root.addEventListener("keydown", this.handleKeyDown);
        this.geometry = this.loadGeometry(); this.started = true; this.applyGeometry(); this.setEditMode(false);
        return true;
    }
    destroy() {
        if (!this.started) return; this.cancelOperation();
        this.widthDecrease.removeEventListener("click", this.handleWidthClick);
        this.widthIncrease.removeEventListener("click", this.handleWidthClick);
        this.root.removeEventListener("pointerdown", this.handlePointerDown);
        this.root.removeEventListener("pointermove", this.handlePointerMove);
        this.root.removeEventListener("pointerup", this.handlePointerEnd);
        this.root.removeEventListener("pointercancel", this.handlePointerEnd);
        this.root.removeEventListener("keydown", this.handleKeyDown); this.setEditMode(false); this.started = false;
    }
    setEditMode(enabled) {
        this.editMode = Boolean(enabled); this.root?.classList.toggle("is-monitor-layout-editing", this.editMode);
        [this.widthDecrease, this.widthIncrease].forEach((button) => { if (button) button.disabled = !this.editMode; });
        this.handles?.forEach((handle) => { handle.tabIndex = this.editMode ? 0 : -1; });
        if (!this.editMode) this.cancelOperation();
    }
    reset() { this.cancelOperation(); this.removePersistedGeometry();
        this.geometry = this.cloneGeometry(DEFAULT_GEOMETRY); this.applyGeometry(); return this.getGeometry(); }
    getGeometry() { return this.freezeGeometry(this.geometry); }
    handleWidthClick(event) { if (!this.editMode) return;
        const direction = event.currentTarget === this.widthIncrease ? 1 : -1;
        this.geometry.wallWidthPercent = this.clamp(this.geometry.wallWidthPercent + direction * WALL_STEP,
            WALL_MIN, WALL_MAX); this.commitGeometry(); }
    handlePointerDown(event) {
        const handle = event.target.closest("[data-monitor-resize]");
        if (!this.editMode || !handle || !this.root.contains(handle) || event.button !== 0) return;
        event.preventDefault(); handle.setPointerCapture?.(event.pointerId);
        this.operation = { handle, pointerId: event.pointerId, monitorId: handle.dataset.monitorResize,
            startX: event.clientX, startY: event.clientY, startGeometry: this.cloneGeometry(this.geometry) };
        handle.classList.add("is-monitor-resize-active");
    }
    handlePointerMove(event) {
        if (!this.operation || event.pointerId !== this.operation.pointerId) return;
        const wallWidth = this.root.getBoundingClientRect().width; if (!(wallWidth > 0)) return;
        this.geometry = this.resizeMonitor(this.operation.startGeometry, this.operation.monitorId, {
            widthDelta: (event.clientX - this.operation.startX) / wallWidth * 100,
            heightDelta: event.clientY - this.operation.startY }); this.applyGeometry();
    }
    handlePointerEnd(event) {
        if (!this.operation || event.pointerId !== this.operation.pointerId) return; event.preventDefault();
        this.operation.handle.releasePointerCapture?.(event.pointerId);
        this.operation.handle.classList.remove("is-monitor-resize-active"); this.operation = null; this.commitGeometry();
    }
    handleKeyDown(event) {
        const handle = event.target.closest("[data-monitor-resize]");
        if (!this.editMode || !handle || !event.key.startsWith("Arrow")) return; event.preventDefault();
        this.geometry = this.resizeMonitor(this.geometry, handle.dataset.monitorResize, {
            widthDelta: event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0,
            heightDelta: event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0 });
        this.commitGeometry();
    }
    resizeMonitor(geometry, monitorId, { widthDelta = 0, heightDelta = 0 } = {}) {
        const next = this.cloneGeometry(geometry); if (!next[monitorId]) return next;
        next[monitorId].widthPercent = this.clamp(next[monitorId].widthPercent + widthDelta, WIDTH_MIN, WIDTH_MAX);
        next[monitorId].heightPx = this.clamp(next[monitorId].heightPx + heightDelta, HEIGHT_MIN, HEIGHT_MAX);
        return this.normalizeGeometry(next);
    }
    normalizeGeometry(value) { return { wallWidthPercent: this.round(this.clamp(value.wallWidthPercent,
        WALL_MIN, WALL_MAX)), program: this.normalizeMonitor(value.program), preview: this.normalizeMonitor(value.preview) }; }
    normalizeMonitor(value) { return { widthPercent: this.round(this.clamp(value.widthPercent, WIDTH_MIN,
        WIDTH_MAX)), heightPx: Math.round(this.clamp(value.heightPx, HEIGHT_MIN, HEIGHT_MAX)) }; }
    isValidGeometry(value) { return value && Number.isFinite(value.wallWidthPercent) &&
        [value.program, value.preview].every((monitor) => monitor && Number.isFinite(monitor.widthPercent) &&
            Number.isFinite(monitor.heightPx)); }
    applyGeometry() {
        const { wallWidthPercent, program, preview } = this.geometry;
        this.root.style.setProperty("--monitor-wall-width", `${wallWidthPercent}%`);
        this.root.style.setProperty("--monitor-program-width", `${program.widthPercent}%`);
        this.root.style.setProperty("--monitor-program-height", `${program.heightPx}px`);
        this.root.style.setProperty("--monitor-preview-width", `${preview.widthPercent}%`);
        this.root.style.setProperty("--monitor-preview-height", `${preview.heightPx}px`);
        if (this.widthValue) { this.widthValue.value = `${wallWidthPercent}%`;
            this.widthValue.textContent = `${wallWidthPercent}%`; }
    }
    commitGeometry() { this.geometry = this.normalizeGeometry(this.geometry);
        this.applyGeometry(); this.persistGeometry(); }
    loadGeometry() {
        try { const payload = JSON.parse(this.storage?.getItem(STORAGE_KEY));
            if (payload?.version === SCHEMA_VERSION && this.isValidGeometry(payload.monitorWall))
                return this.normalizeGeometry(payload.monitorWall);
            if (payload?.version === 1 && this.isLegacyGeometry(payload.monitorWall))
                return this.migrateLegacyGeometry(payload.monitorWall);
        } catch { /* Invalid persistence falls back to defaults. */ }
        return this.cloneGeometry(DEFAULT_GEOMETRY);
    }
    isLegacyGeometry(value) { return value && [value.widthPercent, value.program, value.preview]
        .every(Number.isFinite) && value.program > 0 && value.preview > 0; }
    migrateLegacyGeometry(value) { const total = value.program + value.preview;
        return this.normalizeGeometry({ wallWidthPercent: value.widthPercent,
            program: { widthPercent: value.program / total * 98, heightPx: DEFAULT_GEOMETRY.program.heightPx },
            preview: { widthPercent: value.preview / total * 98, heightPx: DEFAULT_GEOMETRY.preview.heightPx } }); }
    persistGeometry() { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION,
        monitorWall: this.cloneGeometry(this.geometry) })); } catch {} }
    removePersistedGeometry() { try { this.storage?.removeItem(STORAGE_KEY); } catch {} }
    cancelOperation() { if (!this.operation) return;
        this.operation.handle.releasePointerCapture?.(this.operation.pointerId);
        this.operation.handle.classList.remove("is-monitor-resize-active"); this.operation = null; }
    cloneGeometry(value) { return { wallWidthPercent: value.wallWidthPercent,
        program: { ...value.program }, preview: { ...value.preview } }; }
    freezeGeometry(value) { return Object.freeze({ wallWidthPercent: value.wallWidthPercent,
        program: Object.freeze({ ...value.program }), preview: Object.freeze({ ...value.preview }) }); }
    getDefaultStorage() { try { return globalThis.localStorage; } catch { return null; } }
    clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
    round(value) { return Math.round(value * 1000) / 1000; }
}
