const STORAGE_KEY = "livezone.controlDesk.layout.v1";
const SCHEMA_VERSION = 1;
const BASE_COLUMNS = 12;
const GRID_GAP = 12;
const GRID_ROW_STEP = 48;

const MODULE_DEFINITIONS = Object.freeze([
    Object.freeze({ id: "scenes", label: "Scenes", x: 0, y: 0, w: 6, h: 4, minW: 4, minH: 3 }),
    Object.freeze({ id: "sources", label: "Sources", x: 0, y: 11, w: 6, h: 6, minW: 4, minH: 4 }),
    Object.freeze({ id: "assets", label: "Assets", x: 6, y: 11, w: 6, h: 7, minW: 4, minH: 5 }),
    Object.freeze({ id: "transition", label: "Transition", x: 6, y: 0, w: 2, h: 3, minW: 2, minH: 2 }),
    Object.freeze({ id: "take", label: "Take", x: 8, y: 0, w: 2, h: 3, minW: 2, minH: 2 }),
    Object.freeze({ id: "broadcast", label: "Broadcast", x: 10, y: 0, w: 2, h: 3, minW: 2, minH: 3 }),
    Object.freeze({ id: "media-preview", label: "Media Preview", x: 0, y: 4, w: 3, h: 4, minW: 3, minH: 3 }),
    Object.freeze({ id: "lower-third", label: "Lower Third", x: 3, y: 4, w: 3, h: 7, minW: 3, minH: 6 }),
    Object.freeze({ id: "channel-logo", label: "Channel Logo", x: 6, y: 4, w: 4, h: 7, minW: 3, minH: 6 }),
    Object.freeze({ id: "mon", label: "MON", x: 10, y: 4, w: 2, h: 3, minW: 2, minH: 2 })
]);

const MODULE_BY_ID = new Map(
    MODULE_DEFINITIONS.map((definition) => [definition.id, definition])
);

export default class ControlDeskLayoutManager {

    constructor({
        root,
        storage,
        ResizeObserverImpl = globalThis.ResizeObserver,
        requestFrame = globalThis.requestAnimationFrame,
        cancelFrame = globalThis.cancelAnimationFrame,
        onEditModeChange = null,
        onReset = null
    } = {}) {
        this.root = root;
        this.storage = storage === undefined
            ? this.getDefaultStorage()
            : storage;
        this.ResizeObserverImpl = ResizeObserverImpl;
        this.requestFrame = typeof requestFrame === "function"
            ? requestFrame.bind(globalThis)
            : (callback) => {
                callback();
                return null;
            };
        this.cancelFrame = typeof cancelFrame === "function"
            ? cancelFrame.bind(globalThis)
            : () => {};
        this.onEditModeChange = typeof onEditModeChange === "function"
            ? onEditModeChange
            : () => {};
        this.onReset = typeof onReset === "function" ? onReset : () => {};
        this.started = false;
        this.editMode = false;
        this.columns = BASE_COLUMNS;
        this.modules = new Map();
        this.baseLayout = this.createDefaultLayout();
        this.activeLayout = [];
        this.operation = null;
        this.frameId = null;

        this.handleEditClick = this.handleEditClick.bind(this);
        this.handleResetClick = this.handleResetClick.bind(this);
        this.handlePointerDown = this.handlePointerDown.bind(this);
        this.handlePointerMove = this.handlePointerMove.bind(this);
        this.handlePointerEnd = this.handlePointerEnd.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
        this.handleResize = this.handleResize.bind(this);
    }

    start() {
        if (this.started || !this.root) {
            return false;
        }

        this.workspace = this.root.querySelector("#control-desk-workspace");
        this.editButton = this.root.querySelector("#control-desk-edit");
        this.resetButton = this.root.querySelector("#control-desk-reset");

        if (!this.workspace || !this.editButton || !this.resetButton ||
            !this.registerModules()) {
            return false;
        }

        this.installHandles();
        this.editButton.addEventListener("click", this.handleEditClick);
        this.resetButton.addEventListener("click", this.handleResetClick);
        this.workspace.addEventListener("pointerdown", this.handlePointerDown);
        this.workspace.addEventListener("pointermove", this.handlePointerMove);
        this.workspace.addEventListener("pointerup", this.handlePointerEnd);
        this.workspace.addEventListener("pointercancel", this.handlePointerEnd);
        this.workspace.addEventListener("keydown", this.handleKeyDown);

        if (typeof this.ResizeObserverImpl === "function") {
            this.resizeObserver = new this.ResizeObserverImpl(this.handleResize);
            this.resizeObserver.observe(this.workspace);
        }

        this.baseLayout = this.loadLayout();
        this.started = true;
        this.applyLayout();
        this.setEditMode(false);
        return true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.cancelOperation({ revert: true });
        this.editButton.removeEventListener("click", this.handleEditClick);
        this.resetButton.removeEventListener("click", this.handleResetClick);
        this.workspace.removeEventListener("pointerdown", this.handlePointerDown);
        this.workspace.removeEventListener("pointermove", this.handlePointerMove);
        this.workspace.removeEventListener("pointerup", this.handlePointerEnd);
        this.workspace.removeEventListener("pointercancel", this.handlePointerEnd);
        this.workspace.removeEventListener("keydown", this.handleKeyDown);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.setEditMode(false);
        this.modules.forEach(({ dragHandle, resizeHandle }) => {
            dragHandle.remove();
            resizeHandle.remove();
        });
        this.modules.clear();
        this.started = false;
        this.workspace = null;
        this.editButton = null;
        this.resetButton = null;
    }

    reset() {
        this.cancelOperation({ revert: false });
        this.removePersistedLayout();
        this.baseLayout = this.createDefaultLayout();
        this.applyLayout();
        this.onReset();
        return this.getLayout();
    }

    getLayout() {
        return Object.freeze({
            version: SCHEMA_VERSION,
            columns: this.columns,
            modules: Object.freeze(this.activeLayout.map((item) =>
                Object.freeze({ ...item })
            ))
        });
    }

    setEditMode(enabled) {
        this.editMode = Boolean(enabled);
        this.root?.classList.toggle("is-layout-editing", this.editMode);
        this.editButton?.setAttribute("aria-pressed", String(this.editMode));
        if (this.editButton) {
            this.editButton.textContent = this.editMode
                ? "FINISH LAYOUT"
                : "EDIT LAYOUT";
        }

        if (!this.editMode) {
            this.cancelOperation({ revert: false });
        }

        this.onEditModeChange(this.editMode);
    }

    registerModules() {
        const elements = Array.from(
            this.workspace.querySelectorAll("[data-control-module]")
        );

        if (elements.length !== MODULE_DEFINITIONS.length) {
            return false;
        }

        for (const element of elements) {
            const id = element.dataset.controlModule;

            if (!MODULE_BY_ID.has(id) || this.modules.has(id)) {
                return false;
            }

            this.modules.set(id, { element });
        }

        return MODULE_DEFINITIONS.every(({ id }) => this.modules.has(id));
    }

    installHandles() {
        const document = this.workspace.ownerDocument;

        MODULE_DEFINITIONS.forEach(({ id, label }) => {
            const module = this.modules.get(id);
            const dragHandle = document.createElement("button");
            const resizeHandle = document.createElement("button");

            dragHandle.type = "button";
            dragHandle.className = "control-desk__drag-handle";
            dragHandle.dataset.layoutAction = "move";
            dragHandle.textContent = "⠿";
            dragHandle.title = `Move ${label}`;
            dragHandle.setAttribute("aria-label", `Move ${label}`);

            resizeHandle.type = "button";
            resizeHandle.className = "control-desk__resize-handle";
            resizeHandle.dataset.layoutAction = "resize";
            resizeHandle.textContent = "↘";
            resizeHandle.title = `Resize ${label}`;
            resizeHandle.setAttribute("aria-label", `Resize ${label}`);

            const legend = module.element.matches("fieldset")
                ? module.element.querySelector(":scope > legend")
                : null;

            if (legend) {
                legend.after(dragHandle);
            }
            else {
                module.element.prepend(dragHandle);
            }

            module.element.append(resizeHandle);
            module.dragHandle = dragHandle;
            module.resizeHandle = resizeHandle;
        });
    }

    handleEditClick() {
        this.setEditMode(!this.editMode);
    }

    handleResetClick() {
        this.reset();
    }

    handlePointerDown(event) {
        const handle = event.target.closest("[data-layout-action]");

        if (!this.editMode || !handle || !this.workspace.contains(handle)) {
            return;
        }

        const element = handle.closest("[data-control-module]");
        const id = element?.dataset.controlModule;
        const item = this.baseLayout.find((candidate) => candidate.id === id);

        if (!item) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture?.(event.pointerId);
        element.classList.add("is-layout-active");
        this.operation = {
            id,
            mode: handle.dataset.layoutAction,
            pointerId: event.pointerId,
            target: handle,
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            startLayout: this.cloneLayout(this.baseLayout)
        };
    }

    handlePointerMove(event) {
        if (!this.operation || event.pointerId !== this.operation.pointerId) {
            return;
        }

        event.preventDefault();
        this.operation.lastX = event.clientX;
        this.operation.lastY = event.clientY;

        if (this.frameId === null) {
            this.frameId = this.requestFrame(() => {
                this.frameId = null;
                this.applyOperation();
            });
        }
    }

    handlePointerEnd(event) {
        if (!this.operation || event.pointerId !== this.operation.pointerId) {
            return;
        }

        event.preventDefault();
        this.flushOperation();
        this.finishOperation();
        this.persistLayout();
    }

    handleKeyDown(event) {
        const handle = event.target.closest("[data-layout-action]");

        if (!this.editMode || !handle || !event.key.startsWith("Arrow")) {
            return;
        }

        const id = handle.closest("[data-control-module]")?.dataset.controlModule;
        const item = this.baseLayout.find((candidate) => candidate.id === id);

        if (!item) {
            return;
        }

        event.preventDefault();
        const next = this.cloneLayout(this.baseLayout);
        const target = next.find((candidate) => candidate.id === id);
        const horizontalStep = Math.max(1, Math.round(BASE_COLUMNS / this.columns));
        const resize = handle.dataset.layoutAction === "resize";

        if (resize) {
            target.w += event.key === "ArrowRight" ? horizontalStep
                : event.key === "ArrowLeft" ? -horizontalStep : 0;
            target.h += event.key === "ArrowDown" ? 1
                : event.key === "ArrowUp" ? -1 : 0;
        }
        else {
            target.x += event.key === "ArrowRight" ? horizontalStep
                : event.key === "ArrowLeft" ? -horizontalStep : 0;
            target.y += event.key === "ArrowDown" ? 1
                : event.key === "ArrowUp" ? -1 : 0;
        }

        this.baseLayout = this.normalizeBaseLayout(next, id);
        this.applyLayout();
        this.persistLayout();
    }

    handleResize(entries) {
        const width = entries?.[0]?.contentRect?.width ||
            this.workspace?.clientWidth || 0;
        const nextColumns = this.getColumnCount(width);

        if (nextColumns !== this.columns) {
            this.cancelOperation({ revert: true });
            this.columns = nextColumns;
        }

        this.applyLayout();
    }

    applyOperation() {
        const operation = this.operation;

        if (!operation) {
            return;
        }

        const next = this.cloneLayout(operation.startLayout);
        const item = next.find((candidate) => candidate.id === operation.id);
        const cellWidth = this.getCellWidth();
        const columnDelta = Math.round(
            (operation.lastX - operation.startX) / cellWidth
        );
        const baseColumnDelta = Math.round(
            columnDelta * BASE_COLUMNS / this.columns
        );
        const rowDelta = Math.round(
            (operation.lastY - operation.startY) / GRID_ROW_STEP
        );

        if (operation.mode === "resize") {
            item.w += baseColumnDelta;
            item.h += rowDelta;
        }
        else {
            item.x += baseColumnDelta;
            item.y += rowDelta;
        }

        this.baseLayout = this.normalizeBaseLayout(next, operation.id);
        this.applyLayout();
    }

    flushOperation() {
        if (this.frameId !== null) {
            this.cancelFrame(this.frameId);
            this.frameId = null;
            this.applyOperation();
        }
    }

    finishOperation() {
        const operation = this.operation;

        if (!operation) {
            return;
        }

        try {
            operation.target.releasePointerCapture?.(operation.pointerId);
        }
        catch {
            // Pointer capture may already be released by the browser.
        }

        this.modules.get(operation.id)?.element.classList.remove(
            "is-layout-active"
        );
        this.operation = null;
    }

    cancelOperation({ revert } = { revert: false }) {
        if (!this.operation) {
            return;
        }

        if (this.frameId !== null) {
            this.cancelFrame(this.frameId);
            this.frameId = null;
        }

        if (revert) {
            this.baseLayout = this.operation.startLayout;
        }

        this.finishOperation();
        this.applyLayout();
    }

    applyLayout() {
        if (!this.workspace) {
            return;
        }

        this.columns = this.getColumnCount(this.workspace.clientWidth);
        this.activeLayout = this.createResponsiveLayout(
            this.baseLayout,
            this.columns
        );
        this.workspace.style.setProperty(
            "--control-desk-columns",
            String(this.columns)
        );

        this.activeLayout.forEach((item) => {
            const element = this.modules.get(item.id)?.element;

            if (!element) {
                return;
            }

            element.style.gridColumn = `${item.x + 1} / span ${item.w}`;
            element.style.gridRow = `${item.y + 1} / span ${item.h}`;
        });
    }

    createResponsiveLayout(baseLayout, columns) {
        const scale = columns / BASE_COLUMNS;
        const requested = baseLayout.map((item) => {
            const definition = MODULE_BY_ID.get(item.id);
            const minWidth = Math.min(
                columns,
                Math.max(1, Math.ceil(definition.minW * scale))
            );
            const width = columns === 1
                ? 1
                : this.clamp(Math.round(item.w * scale), minWidth, columns);

            return {
                id: item.id,
                x: columns === 1
                    ? 0
                    : this.clamp(Math.floor(item.x * scale), 0, columns - width),
                y: item.y,
                w: width,
                h: Math.max(definition.minH, item.h)
            };
        });

        return this.packLayout(requested, columns);
    }

    normalizeBaseLayout(layout, priorityId = null) {
        const normalized = layout.map((item) => {
            const definition = MODULE_BY_ID.get(item.id);
            const width = this.clamp(
                Math.round(item.w),
                definition.minW,
                BASE_COLUMNS
            );

            return {
                id: item.id,
                x: this.clamp(Math.round(item.x), 0, BASE_COLUMNS - width),
                y: Math.max(0, Math.round(item.y)),
                w: width,
                h: Math.max(definition.minH, Math.round(item.h))
            };
        });

        return this.packLayout(normalized, BASE_COLUMNS, priorityId);
    }

    packLayout(layout, columns, priorityId = null) {
        const order = new Map(
            MODULE_DEFINITIONS.map(({ id }, index) => [id, index])
        );
        const requested = this.cloneLayout(layout).sort((left, right) => {
            if (left.id === priorityId) {
                return -1;
            }

            if (right.id === priorityId) {
                return 1;
            }

            return left.y - right.y || left.x - right.x ||
                order.get(left.id) - order.get(right.id);
        });
        const placed = [];

        requested.forEach((item) => {
            const width = this.clamp(item.w, 1, columns);
            const candidate = {
                ...item,
                x: this.clamp(item.x, 0, columns - width),
                y: Math.max(0, item.y),
                w: width
            };
            const position = this.findAvailablePosition(
                candidate,
                placed,
                columns
            );

            placed.push({ ...candidate, ...position });
        });

        return placed.sort((left, right) =>
            order.get(left.id) - order.get(right.id)
        );
    }

    findAvailablePosition(item, placed, columns) {
        for (let y = item.y; ; y += 1) {
            const firstX = y === item.y ? item.x : 0;

            for (let x = firstX; x <= columns - item.w; x += 1) {
                const candidate = { ...item, x, y };

                if (!placed.some((other) => this.overlaps(candidate, other))) {
                    return { x, y };
                }
            }
        }
    }

    overlaps(left, right) {
        return left.x < right.x + right.w &&
            left.x + left.w > right.x &&
            left.y < right.y + right.h &&
            left.y + left.h > right.y;
    }

    loadLayout() {
        let parsed;

        try {
            const value = this.storage?.getItem(STORAGE_KEY);

            if (!value) {
                return this.createDefaultLayout();
            }

            parsed = JSON.parse(value);
        }
        catch {
            return this.createDefaultLayout();
        }

        if (!parsed || parsed.version !== SCHEMA_VERSION ||
            !Array.isArray(parsed.modules)) {
            return this.createDefaultLayout();
        }

        const known = new Map();

        for (const item of parsed.modules) {
            if (!item || !MODULE_BY_ID.has(item.id)) {
                continue;
            }

            if (known.has(item.id) || ![item.x, item.y, item.w, item.h]
                .every(Number.isInteger)) {
                return this.createDefaultLayout();
            }

            const definition = MODULE_BY_ID.get(item.id);

            if (item.x < 0 || item.y < 0 || item.w < definition.minW ||
                item.h < definition.minH || item.w > BASE_COLUMNS ||
                item.x + item.w > BASE_COLUMNS) {
                return this.createDefaultLayout();
            }

            known.set(item.id, {
                id: item.id,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h
            });
        }

        let appendY = Math.max(
            0,
            ...Array.from(known.values(), (item) => item.y + item.h)
        );
        const merged = MODULE_DEFINITIONS.map((definition) => {
            const saved = known.get(definition.id);
            if (saved) {
                return saved;
            }

            const geometry = this.createGeometry(definition);
            geometry.x = 0;
            geometry.y = appendY;
            appendY += geometry.h;
            return geometry;
        });

        return this.normalizeBaseLayout(merged);
    }

    persistLayout() {
        const payload = {
            version: SCHEMA_VERSION,
            modules: this.baseLayout.map((item) => ({ ...item }))
        };

        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(payload));
            return true;
        }
        catch {
            return false;
        }
    }

    removePersistedLayout() {
        try {
            this.storage?.removeItem(STORAGE_KEY);
        }
        catch {
            // Storage availability must not block layout reset.
        }
    }

    getDefaultStorage() {
        try {
            return globalThis.localStorage;
        }
        catch {
            return null;
        }
    }

    createDefaultLayout() {
        return MODULE_DEFINITIONS.map((definition) =>
            this.createGeometry(definition)
        );
    }

    createGeometry({ id, x, y, w, h }) {
        return { id, x, y, w, h };
    }

    cloneLayout(layout) {
        return layout.map((item) => ({ ...item }));
    }

    getColumnCount(width) {
        if (width >= 1050) {
            return 12;
        }

        if (width >= 760) {
            return 8;
        }

        if (width >= 520) {
            return 6;
        }

        return 1;
    }

    getCellWidth() {
        const width = this.workspace?.clientWidth || 1;
        return Math.max(
            1,
            (width - GRID_GAP * (this.columns - 1)) / this.columns + GRID_GAP
        );
    }

    clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }
}
