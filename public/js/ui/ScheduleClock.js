export default class ScheduleClock {
    constructor({ clock = () => Date.now(), setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout } = {}) {
        this.clock = clock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (id) => clearTimer(id);
        this.listeners = new Set();
        this.timerId = null;
        this.tick = this.tick.bind(this);
    }

    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        listener(this.clock());
        if (this.timerId === null) this.schedule();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0 && this.timerId !== null) {
                this.clearTimer(this.timerId);
                this.timerId = null;
            }
        };
    }

    schedule() {
        const now = this.clock();
        this.timerId = this.setTimer(this.tick, Math.max(1, 1000 - now % 1000));
    }

    tick() {
        this.timerId = null;
        if (this.listeners.size === 0) return;
        const now = this.clock();
        this.listeners.forEach((listener) => listener(now));
        this.schedule();
    }
}
