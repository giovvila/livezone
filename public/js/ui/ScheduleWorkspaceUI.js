import { getActiveItem, getNextItem, validateSchedule,
    zonedLocalToIso } from "../scheduler/ScheduleContract.js";
import { addLocalDays, calculateDayMetrics } from "../scheduler/ScheduleDayMetrics.js";

export default class ScheduleWorkspaceUI {
    constructor({ root, store, catalog, assetLibrary = null,
        clock = () => Date.now(), uuidFactory = () => globalThis.crypto?.randomUUID?.() } = {}) {
        this.root = root;
        this.store = store;
        this.catalog = catalog;
        this.assetLibrary = assetLibrary;
        this.clock = clock;
        this.uuidFactory = uuidFactory;
        this.schedule = null;
        this.selectedDate = null;
        this.editingId = null;
        this.started = false;
        this.handleDateChange = this.handleDateChange.bind(this);
        this.handleFormSubmit = this.handleFormSubmit.bind(this);
        this.handleListClick = this.handleListClick.bind(this);
        this.handleBehaviorChange = this.handleBehaviorChange.bind(this);
        this.handleStartModeChange = this.handleStartModeChange.bind(this);
        this.handleSceneChange = this.handleSceneChange.bind(this);
        this.handleSchedule = this.handleSchedule.bind(this);
        this.renderSources = this.renderSources.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.store || !this.catalog) return false;
        this.dateInput = this.root.querySelector("#schedule-selected-date");
        this.previous = this.root.querySelector("#schedule-previous-day");
        this.todayButton = this.root.querySelector("#schedule-today");
        this.next = this.root.querySelector("#schedule-next-day");
        this.week = this.root.querySelector("#schedule-week");
        this.covered = this.root.querySelector("#schedule-covered");
        this.uncovered = this.root.querySelector("#schedule-uncovered");
        this.coverage = this.root.querySelector("#schedule-coverage");
        this.dayStatus = this.root.querySelector("#schedule-day-status");
        this.timeline = this.root.querySelector("#schedule-timeline");
        this.gaps = this.root.querySelector("#schedule-gaps");
        this.planNowNext = this.root.querySelector("#schedule-plan-now-next");
        this.list = this.root.querySelector("#schedule-item-list");
        this.empty = this.root.querySelector("#schedule-empty");
        this.form = this.root.querySelector("#schedule-item-form");
        this.feedback = this.root.querySelector("#schedule-feedback");
        this.cancel = this.root.querySelector("#schedule-item-cancel");
        this.startMode = this.root.querySelector("#schedule-item-start-mode");
        this.behavior = this.root.querySelector("#schedule-item-behavior");
        this.absoluteFields = this.root.querySelector("#schedule-item-absolute-fields");
        this.sceneSelect = this.root.querySelector("#schedule-item-scene");
        this.sourceList = this.root.querySelector("#schedule-source-list");
        if ([this.dateInput, this.previous, this.todayButton, this.next, this.week,
            this.covered, this.uncovered, this.coverage, this.dayStatus, this.timeline,
            this.gaps, this.planNowNext, this.list, this.empty, this.form, this.feedback,
            this.cancel, this.startMode, this.behavior, this.absoluteFields,
            this.sceneSelect, this.sourceList].some((node) => !node)) return false;

        this.started = true;
        this.dateInput.addEventListener("change", this.handleDateChange);
        this.previous.addEventListener("click", () => this.selectDate(addLocalDays(this.selectedDate, -1)));
        this.todayButton.addEventListener("click", () => this.selectDate(todayInTimezone(this.schedule?.timezone, this.clock())));
        this.next.addEventListener("click", () => this.selectDate(addLocalDays(this.selectedDate, 1)));
        this.week.addEventListener("click", (event) => {
            const button = event.target.closest("button[data-date]");
            if (button) this.selectDate(button.dataset.date);
        });
        this.form.addEventListener("submit", this.handleFormSubmit);
        this.list.addEventListener("click", this.handleListClick);
        this.cancel.addEventListener("click", () => this.resetEditor());
        this.startMode.addEventListener("change", this.handleStartModeChange);
        this.behavior.addEventListener("change", this.handleBehaviorChange);
        this.sceneSelect.addEventListener("change", this.handleSceneChange);
        this.unsubscribeStore = this.store.subscribe(this.handleSchedule);
        this.unsubscribeCatalog = this.catalog.subscribe(() => {
            this.renderScenes(); this.renderSources(); this.render();
        });
        this.renderSources();
        return true;
    }

    destroy() {
        if (!this.started) return;
        this.dateInput.removeEventListener("change", this.handleDateChange);
        this.form.removeEventListener("submit", this.handleFormSubmit);
        this.list.removeEventListener("click", this.handleListClick);
        this.startMode.removeEventListener("change", this.handleStartModeChange);
        this.behavior.removeEventListener("change", this.handleBehaviorChange);
        this.sceneSelect.removeEventListener("change", this.handleSceneChange);
        this.unsubscribeStore?.();
        this.unsubscribeCatalog?.();
        this.started = false;
    }

    handleSchedule({ schedule, issues }) {
        if (!schedule) return;
        this.schedule = schedule;
        if (!this.selectedDate) this.selectedDate = todayInTimezone(schedule.timezone, this.clock());
        this.dateInput.value = this.selectedDate;
        if (issues?.length) this.showFeedback("Il palinsesto persistito non è valido.", true);
        this.renderScenes();
        this.render();
    }

    handleDateChange() { this.selectDate(this.dateInput.value); }

    selectDate(date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return;
        this.selectedDate = date;
        this.dateInput.value = date;
        if (!this.editingId) this.form.elements.date.value = date;
        this.render();
    }

    handleFormSubmit(event) {
        event.preventDefault();
        const data = new FormData(this.form);
        const startMode = String(data.get("startMode") || "ABSOLUTE");
        const behavior = String(data.get("behavior") || "NORMAL");
        const start = startMode === "ABSOLUTE"
            ? zonedLocalToIso(String(data.get("date")), String(data.get("time")), this.schedule.timezone)
            : null;
        const durationSeconds = parseDuration(data.get("duration"));
        const uuid = this.editingId || this.uuidFactory?.();
        if (!uuid || !durationSeconds || (startMode === "ABSOLUTE" && !start)) {
            return this.showFeedback("Data, ora o durata non valide.", true);
        }
        const item = {
            id: this.editingId || `schedule-${uuid}`.slice(0, 120),
            title: String(data.get("title") || "").trim(), startMode, behavior,
            resumePolicy: String(data.get("resumePolicy") || "RESUME_FIXED"),
            ...(start ? { start } : {}), durationSeconds,
            sceneId: String(data.get("sceneId") || ""),
            transition: String(data.get("transition") || "CUT")
        };
        const items = this.schedule.items.filter(({ id }) => id !== this.editingId)
            .map(stripDerived);
        items.push(item);
        const result = validateSchedule({ version: 1, timezone: this.schedule.timezone, items });
        if (!result.ok) return this.showFeedback(`Elemento rifiutato: ${result.issues.join(", ")}`, true);
        const saved = this.store.save(result.schedule);
        if (!saved.ok) return this.showFeedback("Salvataggio non riuscito.", true);
        this.schedule = saved.schedule;
        this.resetEditor();
        this.showFeedback("Palinsesto salvato. La Regia riceverà l'aggiornamento.", false);
    }

    handleListClick(event) {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const item = this.schedule.items.find(({ id }) => id === button.dataset.id);
        if (!item) return;
        if (button.dataset.action === "remove") {
            const result = validateSchedule({ version: 1, timezone: this.schedule.timezone,
                items: this.schedule.items.filter(({ id }) => id !== item.id).map(stripDerived) });
            if (!result.ok) return this.showFeedback("Rimozione non valida.", true);
            const saved = this.store.save(result.schedule);
            if (!saved.ok) return this.showFeedback("Rimozione non persistita.", true);
            this.schedule = saved.schedule;
            if (this.editingId === item.id) this.resetEditor();
            return this.showFeedback("Elemento rimosso.", false);
        }
        this.editingId = item.id;
        this.form.elements.title.value = item.title;
        this.form.elements.startMode.value = item.startMode;
        this.form.elements.behavior.value = item.behavior;
        this.form.elements.resumePolicy.value = item.resumePolicy;
        this.form.elements.date.value = item.start?.slice(0, 10) || this.selectedDate;
        this.form.elements.time.value = item.start?.slice(11, 19) || "";
        this.form.elements.duration.value = formatDuration(item.durationSeconds);
        this.form.elements.sceneId.value = item.sceneId;
        this.form.elements.transition.value = item.transition;
        this.updateEditorState();
        this.showFeedback(`Modifica: ${item.title}`, false);
    }

    handleStartModeChange() { this.updateEditorState(); }
    handleBehaviorChange() {
        if (this.behavior.value === "INTERRUPT") this.startMode.value = "ABSOLUTE";
        this.updateEditorState();
    }
    handleSceneChange() { this.prefillDuration(); }

    updateEditorState() {
        const interrupt = this.behavior.value === "INTERRUPT";
        const afterOption = this.startMode.querySelector('option[value="AFTER_PREVIOUS"]');
        const fillerOption = this.form.elements.resumePolicy.querySelector('option[value="FILLER"]');
        afterOption.disabled = interrupt;
        fillerOption.disabled = interrupt;
        if (interrupt && this.form.elements.resumePolicy.value === "FILLER") {
            this.form.elements.resumePolicy.value = "RESUME_FIXED";
        }
        const absolute = this.startMode.value === "ABSOLUTE";
        this.absoluteFields.hidden = !absolute;
        this.form.elements.date.disabled = !absolute;
        this.form.elements.time.disabled = !absolute;
        this.form.elements.date.required = absolute;
        this.form.elements.time.required = absolute;
    }

    resetEditor() {
        this.editingId = null;
        this.form.reset();
        this.form.elements.date.value = this.selectedDate;
        this.form.elements.duration.value = "00:30:00";
        this.updateEditorState();
        this.renderScenes();
    }

    prefillDuration() {
        const scene = this.catalog.getDefinition(this.sceneSelect.value);
        const sourceId = scene?.renderer?.kind === "source" ? scene.renderer.sourceId : null;
        const source = this.catalog.getSources().find(({ id }) => id === sourceId);
        if (source?.kind !== "media") return;
        const asset = source.assetId ? this.assetLibrary?.getAsset(source.assetId)
            : this.assetLibrary?.getAssets("video").find(({ url }) => url === source.url);
        if (Number.isFinite(asset?.durationSeconds) && asset.durationSeconds > 0) {
            this.form.elements.duration.value = formatDuration(Math.ceil(asset.durationSeconds));
            this.showFeedback("Durata compilata dai metadata MEDIA; resta modificabile.", false);
        }
    }

    render() {
        if (!this.schedule || !this.selectedDate) return;
        const metrics = calculateDayMetrics(this.schedule, this.selectedDate, this.schedule.timezone);
        if (!metrics) return;
        this.dateInput.value = this.selectedDate;
        this.covered.textContent = formatDuration(metrics.coveredSeconds);
        this.uncovered.textContent = formatDuration(metrics.uncoveredSeconds);
        this.coverage.textContent = `${metrics.coveragePercent.toFixed(2)}%`;
        this.dayStatus.textContent = metrics.status;
        this.renderWeek();
        this.renderTimeline(metrics);
        this.renderItems(metrics);
        this.renderPlanStatus(metrics);
        if (!this.editingId && !this.form.elements.date.value) this.resetEditor();
    }

    renderWeek() {
        const selected = parseDate(this.selectedDate);
        const mondayOffset = (selected.getUTCDay() + 6) % 7;
        const monday = addLocalDays(this.selectedDate, -mondayOffset);
        const formatter = new Intl.DateTimeFormat("it-IT", { weekday: "short", timeZone: "UTC" });
        const buttons = Array.from({ length: 7 }, (_, index) => {
            const date = addLocalDays(monday, index);
            const button = document.createElement("button");
            const day = document.createElement("span");
            const number = document.createElement("strong");
            const percent = document.createElement("span");
            const metrics = calculateDayMetrics(this.schedule, date, this.schedule.timezone);
            button.type = "button";
            button.dataset.date = date;
            button.setAttribute("aria-pressed", String(date === this.selectedDate));
            day.textContent = formatter.format(parseDate(date)).toUpperCase();
            number.textContent = String(Number(date.slice(8, 10)));
            percent.textContent = `${Math.round(metrics?.coveragePercent || 0)}%`;
            button.append(day, number, percent);
            return button;
        });
        this.week.replaceChildren(...buttons);
    }

    renderTimeline(metrics) {
        const duration = metrics.endMs - metrics.startMs;
        const segments = metrics.items.map((item) => {
            const segment = document.createElement("span");
            const start = Math.max(metrics.startMs, item.startMs);
            const end = Math.min(metrics.endMs, item.endMs);
            segment.className = "schedule-timeline-segment";
            if (item.behavior === "INTERRUPT") segment.classList.add("is-interrupt");
            if (item.resumePolicy === "FILLER") segment.classList.add("is-filler");
            segment.style.left = `${(start - metrics.startMs) / duration * 100}%`;
            segment.style.width = `${(end - start) / duration * 100}%`;
            segment.title = `${item.title}: ${formatTime(item.startMs, this.schedule.timezone)}–${formatTime(item.endMs, this.schedule.timezone)}`;
            return segment;
        });
        const today = todayInTimezone(this.schedule.timezone, this.clock());
        if (today === this.selectedDate && this.clock() >= metrics.startMs && this.clock() < metrics.endMs) {
            const marker = document.createElement("span");
            marker.className = "schedule-timeline-marker";
            marker.style.left = `${(this.clock() - metrics.startMs) / duration * 100}%`;
            segments.push(marker);
        }
        this.timeline.replaceChildren(...segments);
        const gaps = complement(metrics.intervals, metrics.startMs, metrics.endMs).map(({ startMs, endMs }) => {
            const item = document.createElement("li");
            item.textContent = `${formatTime(startMs, this.schedule.timezone)}–${formatTime(endMs, this.schedule.timezone)} NON PROGRAMMATO`;
            return item;
        });
        this.gaps.replaceChildren(...gaps);
    }

    renderItems(metrics) {
        const now = this.clock();
        const current = this.selectedDate === todayInTimezone(this.schedule.timezone, now)
            ? getActiveItem(this.schedule, now) : null;
        const rows = [...metrics.items].sort((a, b) => a.startMs - b.startMs)
            .map((item) => this.createItem(item, current?.id === item.id));
        this.list.replaceChildren(...rows);
        this.empty.hidden = rows.length > 0;
    }

    createItem(item, active) {
        const row = document.createElement("li");
        const summary = document.createElement("div");
        const time = document.createElement("span");
        const title = document.createElement("strong");
        const meta = document.createElement("span");
        const badges = document.createElement("div");
        const actions = document.createElement("div");
        const edit = document.createElement("button");
        const remove = document.createElement("button");
        const scene = this.catalog.getDefinition(item.sceneId);
        row.className = `schedule-item${active ? " is-active" : ""}${scene ? "" : " is-unresolved"}`;
        summary.className = "schedule-item__summary";
        time.className = "schedule-item__time";
        time.textContent = `${formatTime(item.startMs, this.schedule.timezone)}–${formatTime(item.endMs, this.schedule.timezone)} · ${formatDuration(item.durationSeconds)}`;
        title.className = "schedule-item__title";
        title.textContent = item.title;
        meta.className = "schedule-item__meta";
        meta.textContent = `${scene?.name || "UNRESOLVED"} · ${item.sceneId} · ${item.transition}`;
        badges.className = "schedule-item__badges";
        [active ? "ACTIVE" : null, item.behavior === "INTERRUPT" ? "INTERRUPT" : null,
            item.resumePolicy === "RESUME_SHIFT" ? "SHIFT" : item.resumePolicy === "FILLER" ? "FILLER" : "FIXED",
            scene ? null : "UNRESOLVED"].filter(Boolean).forEach((label) => {
            const badge = document.createElement("strong"); badge.textContent = label; badges.appendChild(badge);
        });
        summary.append(time, title, meta, badges);
        actions.className = "schedule-item__actions";
        edit.type = remove.type = "button";
        edit.textContent = "EDIT"; remove.textContent = "REMOVE";
        edit.dataset.action = "edit"; remove.dataset.action = "remove";
        edit.dataset.id = remove.dataset.id = item.id;
        actions.append(edit, remove); row.append(summary, actions);
        return row;
    }

    renderPlanStatus(metrics) {
        const today = todayInTimezone(this.schedule.timezone, this.clock());
        let nowItem;
        let nextItem;
        if (this.selectedDate === today) {
            nowItem = getActiveItem(this.schedule, this.clock());
            nextItem = getNextItem(this.schedule, this.clock());
        }
        else {
            [nowItem, nextItem] = metrics.items.filter(({ behavior }) => behavior === "NORMAL");
        }
        const nowLine = document.createElement("span");
        const nextLine = document.createElement("span");
        nowLine.textContent = `${this.selectedDate === today ? "NOW" : "PRIMO"}: ${describePlanItem(nowItem, this.schedule.timezone)}`;
        nextLine.textContent = `NEXT: ${describePlanItem(nextItem, this.schedule.timezone)}`;
        this.planNowNext.replaceChildren(nowLine, nextLine);
    }

    renderScenes() {
        if (!this.sceneSelect) return;
        const selected = this.sceneSelect.value;
        const options = this.catalog.getDefinitions().map((scene) => {
            const option = document.createElement("option");
            option.value = scene.id; option.textContent = `${scene.name} (${scene.id})`; return option;
        });
        this.sceneSelect.replaceChildren(...options);
        if (options.some(({ value }) => value === selected)) this.sceneSelect.value = selected;
    }

    renderSources() {
        if (!this.sourceList) return;
        const assets = this.assetLibrary?.getAssets() || [];
        const rows = this.catalog.getSources().map((source) => {
            const row = document.createElement("li");
            const name = document.createElement("strong");
            const kind = document.createElement("span");
            const id = document.createElement("code");
            const path = document.createElement("span");
            const asset = assets.find(({ id: assetId }) => assetId === source.assetId ||
                assetId === source.audioAssetId);
            name.textContent = source.name;
            kind.textContent = `${source.kind.toUpperCase()} · ${source.origin.toUpperCase()}${asset?.durationSeconds ? ` · ${formatDuration(Math.ceil(asset.durationSeconds))}` : ""}`;
            id.textContent = source.id;
            path.textContent = source.kind === "audio" ? `${source.audioUrl} + ${source.stillUrl}`
                : source.url || source.configRef || "Configured at runtime";
            row.append(name, kind, id, path); return row;
        });
        this.sourceList.replaceChildren(...rows);
    }

    showFeedback(message, error) {
        this.feedback.textContent = message;
        this.feedback.classList.toggle("is-error", Boolean(error));
        return false;
    }
}

function stripDerived({ id, title, startMode, behavior, resumePolicy, start,
    durationSeconds, sceneId, transition }) {
    return { id, title, startMode, behavior, resumePolicy,
        ...(startMode === "ABSOLUTE" ? { start } : {}), durationSeconds, sceneId, transition };
}
function parseDuration(value) {
    const match = /^(\d{2,3}):(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const hours = Number(match[1]); const minutes = Number(match[2]); const seconds = Number(match[3]);
    const total = hours * 3600 + minutes * 60 + seconds;
    return minutes < 60 && seconds < 60 && total > 0 ? total : null;
}
function formatDuration(seconds) {
    const value = Math.max(0, Math.round(seconds));
    return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60]
        .map((part) => String(part).padStart(2, "0")).join(":");
}
function formatTime(timestamp, timezone) {
    return new Intl.DateTimeFormat("it-IT", { timeZone: timezone, hour: "2-digit",
        minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
}
function todayInTimezone(timezone = "Europe/Rome", now = Date.now()) {
    const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric",
        month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
}
function parseDate(date) { return new Date(`${date}T00:00:00Z`); }
function complement(intervals, startMs, endMs) {
    const gaps = []; let cursor = startMs;
    intervals.forEach((interval) => {
        if (interval.startMs > cursor) gaps.push({ startMs: cursor, endMs: interval.startMs });
        cursor = Math.max(cursor, interval.endMs);
    });
    if (cursor < endMs) gaps.push({ startMs: cursor, endMs });
    return gaps;
}
function describePlanItem(item, timezone) {
    return item ? `${formatTime(item.startMs, timezone)} · ${item.title}` : "—";
}
