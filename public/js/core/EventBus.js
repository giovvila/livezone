export default class EventBus {

    static listeners = new Map();

    static on(event, callback) {

        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }

        this.listeners.get(event).push(callback);
    }

    static emit(event, payload = null) {

    if (!event) {
        console.error("[EventBus] emit() chiamato senza event.");
        console.trace();
        return;
    }

    console.log("EVENT:", event, payload);

    if (!this.listeners.has(event)) {
        return;
    }

    for (const callback of this.listeners.get(event)) {

        try {
            callback(payload);
        }
        catch (err) {
            console.error(
                `[EventBus] errore nel listener "${event}"`,
                err
            );
        }

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