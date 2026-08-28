import { DEFAULT_TIMEZONE } from "../scheduler/ScheduleContract.js";

export default class StudioScheduleSummaryUI {
    constructor({ root, engine, store, catalog, clockTicker } = {}) {
        this.root = root;
        this.engine = engine;
        this.store = store;
        this.catalog = catalog;
        this.clockTicker = clockTicker;
        this.started = false;
        this.handleToggle = this.handleToggle.bind(this);
        this.handleSchedule = this.handleSchedule.bind(this);
        this.render = this.render.bind(this);
        this.tick = this.tick.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.engine || !this.store || !this.catalog) return false;
        this.toggle = this.root.querySelector("#studio-schedule-toggle");
        this.status = this.root.querySelector("#studio-schedule-status");
        this.now = this.root.querySelector("#studio-schedule-now");
        this.current = this.root.querySelector("#studio-schedule-current");
        this.next = this.root.querySelector("#studio-schedule-next");
        if ([this.toggle, this.status, this.now, this.current, this.next].some((item) => !item)) {
            return false;
        }
        this.started = true;
        this.toggle.addEventListener("click", this.handleToggle);
        this.unsubscribeStore = this.store.subscribe(this.handleSchedule);
        this.unsubscribeEngine = this.engine.subscribe(this.render);
        this.unsubscribeClock = this.clockTicker?.subscribe(this.tick);
        if (!this.unsubscribeClock) this.tick(Date.now());
        return true;
    }

    destroy() {
        if (!this.started) return;
        this.toggle.removeEventListener("click", this.handleToggle);
        this.unsubscribeStore?.();
        this.unsubscribeEngine?.();
        this.unsubscribeClock?.();
        this.started = false;
    }

    handleSchedule({ schedule, issues }) {
        if (!this.started || !schedule || issues?.length) return;
        this.schedule = schedule;
        this.engine.setSchedule(schedule);
        this.render();
    }

    handleToggle() {
        if (this.engine.getSnapshot().enabled) this.engine.stop();
        else this.engine.start();
    }

    render() {
        if (!this.started) return;
        const snapshot = this.engine.getSnapshot();
        this.status.textContent = snapshot.enabled ? "ON" : "OFF";
        this.toggle.textContent = snapshot.enabled ? "SCHEDULER ON" : "SCHEDULER OFF";
        this.toggle.setAttribute("aria-pressed", String(snapshot.enabled));
        this.current.textContent = describe(snapshot.activeItem, this.catalog,
            this.schedule?.timezone || DEFAULT_TIMEZONE);
        this.next.textContent = describe(snapshot.nextItem, this.catalog,
            this.schedule?.timezone || DEFAULT_TIMEZONE);
    }

    tick(timestamp = Date.now()) {
        if (!this.started) return;
        this.now.textContent = new Intl.DateTimeFormat("it-IT", {
            timeZone: this.schedule?.timezone || DEFAULT_TIMEZONE,
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hourCycle: "h23"
        }).format(new Date(timestamp));
        this.render();
    }
}

function describe(item, catalog, timezone) {
    if (!item) return "—";
    const time = new Intl.DateTimeFormat("it-IT", { timeZone: timezone,
        hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .format(new Date(item.startMs));
    return `${time} · ${item.title} · ${catalog.getDefinition(item.sceneId)?.name || "UNRESOLVED"}`;
}
