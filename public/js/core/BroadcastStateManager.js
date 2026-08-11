import EventBus from "./EventBus.js";
import Events from "./Events.js";

export const BROADCAST_STATES = Object.freeze({
    LIVE: "LIVE",
    BREAK: "BREAK",
    OFFLINE: "OFFLINE",
    PROGRAM: "PROGRAM"
});

const TRANSITIONS = Object.freeze({
    [BROADCAST_STATES.OFFLINE]: Object.freeze([
        BROADCAST_STATES.LIVE,
        BROADCAST_STATES.BREAK,
        BROADCAST_STATES.PROGRAM
    ]),
    [BROADCAST_STATES.LIVE]: Object.freeze([
        BROADCAST_STATES.BREAK,
        BROADCAST_STATES.PROGRAM,
        BROADCAST_STATES.OFFLINE
    ]),
    [BROADCAST_STATES.BREAK]: Object.freeze([
        BROADCAST_STATES.LIVE,
        BROADCAST_STATES.PROGRAM,
        BROADCAST_STATES.OFFLINE
    ]),
    [BROADCAST_STATES.PROGRAM]: Object.freeze([
        BROADCAST_STATES.LIVE,
        BROADCAST_STATES.BREAK,
        BROADCAST_STATES.OFFLINE
    ])
});

class BroadcastStateManager {

    constructor() {
        this.currentState = BROADCAST_STATES.OFFLINE;
        this.history = [];
        this.listeners = [];
        this.initialized = false;
    }

    initialize() {
        this.initialized = true;
        return this.currentState;
    }

    getState() {
        return this.currentState;
    }

    canTransition(nextState) {
        if (!Object.values(BROADCAST_STATES).includes(nextState)) {
            return false;
        }

        if (nextState === this.currentState) {
            return true;
        }

        return TRANSITIONS[this.currentState].includes(nextState);
    }

    transition(nextState, { source = null, reason = null } = {}) {
        if (!this.canTransition(nextState) || nextState === this.currentState) {
            return null;
        }

        const record = Object.freeze({
            previous: this.currentState,
            current: nextState,
            source,
            reason,
            timestamp: new Date().toISOString()
        });

        this.currentState = nextState;
        this.history.push(record);

        this.listeners.forEach((listener) => {
            try {
                listener(record);
            }
            catch (error) {
                console.error("[BroadcastStateManager]", error);
            }
        });

        EventBus.emit(Events.BROADCAST_STATE_CHANGED, record);

        return record;
    }

    subscribe(listener) {
        if (typeof listener === "function" && !this.listeners.includes(listener)) {
            this.listeners.push(listener);
        }
    }

    unsubscribe(listener) {
        this.listeners = this.listeners.filter(
            (registeredListener) => registeredListener !== listener
        );
    }

    getHistory() {
        return [...this.history];
    }

}

export default new BroadcastStateManager();
