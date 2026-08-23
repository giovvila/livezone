import { DEFAULT_TIMEZONE, validateSchedule, zonedLocalToIso } from "../scheduler/ScheduleContract.js";

export default class StudioScheduleUI {
    constructor({ root, engine, store, catalog, assetLibrary = null,
        uuidFactory = () => globalThis.crypto?.randomUUID?.() } = {}) {
        this.root = root;
        this.engine = engine;
        this.store = store;
        this.catalog = catalog;
        this.assetLibrary = assetLibrary;
        this.uuidFactory = uuidFactory;
        this.schedule = null;
        this.editingId = null;
        this.started = false;
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleToggle = this.handleToggle.bind(this);
        this.handleListClick = this.handleListClick.bind(this);
        this.handleStartModeChange = this.handleStartModeChange.bind(this);
        this.handleBehaviorChange = this.handleBehaviorChange.bind(this);
        this.handleSceneChange = this.handleSceneChange.bind(this);
        this.render = this.render.bind(this);
        this.tick = this.tick.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.engine || !this.store || !this.catalog) return false;
        this.form = this.root.querySelector("#studio-schedule-form");
        this.toggle = this.root.querySelector("#studio-schedule-toggle");
        this.list = this.root.querySelector("#studio-schedule-list");
        this.sceneSelect = this.root.querySelector("#studio-schedule-scene");
        this.startMode = this.root.querySelector("#studio-schedule-start-mode");
        this.behavior = this.root.querySelector("#studio-schedule-behavior");
        this.absoluteFields = this.root.querySelector("#studio-schedule-absolute-fields");
        this.feedback = this.root.querySelector("#studio-schedule-feedback");
        this.status = this.root.querySelector("#studio-schedule-status");
        this.now = this.root.querySelector("#studio-schedule-now");
        this.current = this.root.querySelector("#studio-schedule-current");
        this.next = this.root.querySelector("#studio-schedule-next");
        if ([this.form, this.toggle, this.list, this.sceneSelect, this.feedback,
            this.status, this.now, this.current, this.next, this.startMode,
            this.behavior, this.absoluteFields].some((item) => !item)) return false;

        const loaded = this.store.load();
        this.schedule = loaded.schedule;
        this.engine.setSchedule(this.schedule);
        if (loaded.issues.length) this.feedback.textContent = "Stored schedule was invalid and was not loaded.";
        this.form.addEventListener("submit", this.handleSubmit);
        this.toggle.addEventListener("click", this.handleToggle);
        this.list.addEventListener("click", this.handleListClick);
        this.startMode.addEventListener("change", this.handleStartModeChange);
        this.behavior.addEventListener("change", this.handleBehaviorChange);
        this.sceneSelect.addEventListener("change", this.handleSceneChange);
        this.unsubscribeEngine = this.engine.subscribe(this.render);
        this.unsubscribeCatalog = this.catalog.subscribe(this.render);
        this.started = true;
        this.render();
        this.updateStartFields();
        this.prefillMediaDuration();
        this.tick();
        return true;
    }

    destroy() {
        if (!this.started) return;
        this.form.removeEventListener("submit", this.handleSubmit);
        this.toggle.removeEventListener("click", this.handleToggle);
        this.list.removeEventListener("click", this.handleListClick);
        this.startMode.removeEventListener("change", this.handleStartModeChange);
        this.behavior.removeEventListener("change", this.handleBehaviorChange);
        this.sceneSelect.removeEventListener("change", this.handleSceneChange);
        this.unsubscribeEngine?.();
        this.unsubscribeCatalog?.();
        if (this.clockTimer !== null) clearTimeout(this.clockTimer);
        this.clockTimer = null;
        this.started = false;
    }

    handleToggle() {
        if (this.engine.getSnapshot().enabled) this.engine.stop();
        else this.engine.start();
        this.render();
    }

    handleSubmit(event) {
        event.preventDefault();
        const data = new FormData(this.form);
        const startMode = String(data.get("startMode") || "ABSOLUTE");
        const behavior = String(data.get("behavior") || "NORMAL");
        const start = startMode === "ABSOLUTE"
            ? zonedLocalToIso(data.get("date"), data.get("time"), this.schedule.timezone)
            : null;
        const durationSeconds = parseDuration(data.get("duration"));
        const id = this.editingId || this.uuidFactory?.();
        if (!id || (startMode === "ABSOLUTE" && !start) || !durationSeconds) {
            return this.showFeedback("Invalid date, time or HH:MM:SS duration.");
        }

        const item = {
            id: `schedule-${id}`.slice(0, 120),
            title: String(data.get("title") || "").trim(),
            startMode,
            behavior,
            ...(start ? { start } : {}),
            durationSeconds,
            sceneId: String(data.get("sceneId") || ""),
            transition: String(data.get("transition") || "CUT")
        };
        if (this.editingId) item.id = this.editingId;
        const items = this.schedule.items.filter(({ id: itemId }) => itemId !== this.editingId)
            .map(stripDerived);
        items.push(item);
        const result = validateSchedule({ version: 1, timezone: this.schedule.timezone, items });
        if (!result.ok) return this.showFeedback(`Schedule rejected: ${result.issues.join(", ")}`);
        const saved = this.store.save(result.schedule);
        if (!saved.ok) return this.showFeedback("Schedule could not be persisted.");
        this.schedule = saved.schedule;
        this.engine.setSchedule(this.schedule);
        this.editingId = null;
        this.form.reset();
        this.form.elements.transition.value = "CUT";
        this.updateStartFields();
        this.showFeedback("Schedule saved.");
        this.render();
    }

    handleListClick(event) {
        const button = event.target.closest("button[data-schedule-action]");
        const item = button && this.schedule.items.find(({ id }) => id === button.dataset.scheduleId);
        if (!item) return;
        if (button.dataset.scheduleAction === "remove") {
            const result = validateSchedule({ version: 1, timezone: this.schedule.timezone,
                items: this.schedule.items.filter(({ id }) => id !== item.id).map(stripDerived) });
            const saved = this.store.save(result.schedule);
            if (!saved.ok) return this.showFeedback("Schedule could not be persisted.");
            this.schedule = saved.schedule;
            this.engine.setSchedule(this.schedule);
            this.showFeedback("Item removed.");
            this.render();
            return;
        }
        this.editingId = item.id;
        this.form.elements.title.value = item.title;
        this.form.elements.startMode.value = item.startMode;
        this.form.elements.behavior.value = item.behavior;
        this.form.elements.date.value = item.start?.slice(0, 10) || "";
        this.form.elements.time.value = getScheduleEditorTime(item.start);
        this.form.elements.duration.value = formatDuration(item.durationSeconds);
        this.form.elements.sceneId.value = item.sceneId;
        this.form.elements.transition.value = item.transition;
        this.updateStartFields();
        this.showFeedback(`Editing ${item.title}.`);
    }

    render() {
        if (!this.list) return;
        const snapshot = this.engine.getSnapshot();
        const scenes = this.catalog.getDefinitions();
        const selected = this.sceneSelect.value;
        this.sceneSelect.replaceChildren();
        scenes.forEach((scene) => {
            const option = document.createElement("option");
            option.value = scene.id;
            option.textContent = `${scene.name} (${scene.id})`;
            this.sceneSelect.appendChild(option);
        });
        if (scenes.some(({ id }) => id === selected)) this.sceneSelect.value = selected;

        this.status.textContent = snapshot.status;
        this.toggle.textContent = snapshot.enabled ? "SCHEDULER OFF" : "SCHEDULER ON";
        this.toggle.setAttribute("aria-pressed", String(snapshot.enabled));
        this.current.textContent = describeItem(snapshot.activeItem, this.catalog);
        this.next.textContent = describeItem(snapshot.nextItem, this.catalog);
        this.list.replaceChildren();
        this.schedule.items.forEach((item) => this.list.appendChild(
            this.createItem(item, snapshot.activeItem?.id === item.id)));
    }

    createItem(item, active) {
        const row = document.createElement("li");
        const summary = document.createElement("div");
        const actions = document.createElement("div");
        const badges = document.createElement("div");
        const activeBadge = document.createElement("strong");
        const edit = document.createElement("button");
        const remove = document.createElement("button");
        const scene = this.catalog.getDefinition(item.sceneId);
        row.className = ["studio-schedule__item", scene ? "" : "is-unresolved",
            active ? "is-active" : ""].filter(Boolean).join(" ");
        row.dataset.scheduleItemId = item.id;
        summary.textContent = `${formatScheduleTime(item.effectiveStart, this.schedule.timezone)} — ${item.title} · ${formatDuration(item.durationSeconds)} · ${scene?.name || "UNRESOLVED"} · ${item.transition}`;
        badges.className = "studio-schedule__badges";
        activeBadge.textContent = "ACTIVE";
        activeBadge.dataset.scheduleActiveBadge = "";
        activeBadge.hidden = !active;
        badges.appendChild(activeBadge);
        if (item.behavior === "INTERRUPT") {
            const interruptBadge = document.createElement("strong");
            interruptBadge.textContent = "INTERRUPT";
            badges.appendChild(interruptBadge);
        }
        edit.type = remove.type = "button";
        edit.textContent = "EDIT";
        remove.textContent = "REMOVE";
        edit.dataset.scheduleAction = "edit";
        remove.dataset.scheduleAction = "remove";
        edit.dataset.scheduleId = remove.dataset.scheduleId = item.id;
        actions.className = "studio-schedule__item-actions";
        actions.append(edit, remove);
        row.append(summary, badges, actions);
        return row;
    }

    tick() {
        if (!this.started) return;
        this.now.textContent = new Intl.DateTimeFormat("it-IT", {
            timeZone: this.schedule?.timezone || DEFAULT_TIMEZONE,
            dateStyle: "short", timeStyle: "medium"
        }).format(new Date());
        this.refreshTimelinePresentation();
        this.clockTimer = setTimeout(this.tick, 1000);
    }

    showFeedback(message) { this.feedback.textContent = message; return false; }

    handleStartModeChange() { this.updateStartFields(); }

    handleBehaviorChange() {
        if (this.behavior.value === "INTERRUPT") this.startMode.value = "ABSOLUTE";
        this.startMode.querySelector('option[value="AFTER_PREVIOUS"]').disabled =
            this.behavior.value === "INTERRUPT";
        this.updateStartFields();
    }

    handleSceneChange() { this.prefillMediaDuration(); }

    updateStartFields() {
        const afterOption = this.startMode.querySelector('option[value="AFTER_PREVIOUS"]');
        afterOption.disabled = this.behavior.value === "INTERRUPT";
        if (afterOption.disabled && this.startMode.value === "AFTER_PREVIOUS") {
            this.startMode.value = "ABSOLUTE";
        }
        const absolute = this.startMode.value === "ABSOLUTE";
        this.absoluteFields.hidden = !absolute;
        this.form.elements.date.disabled = !absolute;
        this.form.elements.time.disabled = !absolute;
        this.form.elements.date.required = absolute;
        this.form.elements.time.required = absolute;
    }

    prefillMediaDuration() {
        const definition = this.catalog.getDefinition(this.sceneSelect.value);
        if (definition?.renderer?.kind !== "source") return;
        const source = this.catalog.getSources().find(({ id }) =>
            id === definition.renderer.sourceId);
        if (source?.kind !== "media") return;
        const asset = source.assetId ? this.assetLibrary?.getAsset(source.assetId) :
            this.assetLibrary?.getAssets("video").find(({ url }) => url === source.url);
        if (!Number.isFinite(asset?.durationSeconds) || asset.durationSeconds <= 0) return;
        this.form.elements.duration.value = formatDuration(Math.ceil(asset.durationSeconds));
        this.showFeedback("Duration prefilled from MEDIA metadata (AUTO). You may edit it.");
    }

    refreshTimelinePresentation() {
        const snapshot = this.engine.getSnapshot();
        this.current.textContent = describeItem(snapshot.activeItem, this.catalog);
        this.next.textContent = describeItem(snapshot.nextItem, this.catalog);
        this.list.querySelectorAll("[data-schedule-item-id]").forEach((row) => {
            const active = row.dataset.scheduleItemId === snapshot.activeItem?.id;
            row.classList.toggle("is-active", active);
            const badge = row.querySelector("[data-schedule-active-badge]");
            if (badge) badge.hidden = !active;
        });
    }
}

function stripDerived({ id, title, startMode, behavior, start, durationSeconds, sceneId, transition }) {
    return { id, title, startMode, behavior,
        ...(startMode === "ABSOLUTE" ? { start } : {}), durationSeconds, sceneId, transition };
}
function parseDuration(value) {
    const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const [, hours, minutes, seconds] = match.map(Number);
    if (minutes > 59 || seconds > 59) return null;
    const total = hours * 3600 + minutes * 60 + seconds;
    return total > 0 ? total : null;
}
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return [hours, minutes, seconds % 60].map((value) => String(value).padStart(2, "0")).join(":");
}
function formatScheduleTime(start, timezone) {
    return new Intl.DateTimeFormat("it-IT", {
        timeZone: timezone, dateStyle: "short", timeStyle: "medium"
    }).format(new Date(start));
}
function describeItem(item, catalog) {
    if (!item) return "—";
    return `${item.title} · ${catalog.getDefinition(item.sceneId)?.name || "UNRESOLVED"}`;
}

export function getScheduleEditorTime(start) {
    return typeof start === "string" ? start.slice(11, 19) : "";
}
