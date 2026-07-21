export default class EventBus {

    static listeners = new Map();

    static on(event, callback) {

        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }

        this.listeners.get(event).push(callback);
    }

    static emit(event, payload = null) {

    console.log("EVENT:", event, payload);

    if (!this.listeners.has(event)) {
        return;
    }

    for (const callback of this.listeners.get(event)) {
        callback(payload);
    }

}

    static off(event, callback) {

        if (!this.listeners.has(event)) {
            return;
        }

        const callbacks = this.listeners.get(event);

        const index = callbacks.indexOf(callback);

        if (index !== -1) {
            callbacks.splice(index, 1);
        }

    }

}