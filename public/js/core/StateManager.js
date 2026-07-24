/*=====================================================

LIVEZONE Broadcast Engine

StateManager.js

Version : 1.1
Build   : 1007.1

=====================================================*/

export const STATES = Object.freeze({

    BOOT: "BOOT",

    INIT: "INIT",

    CONNECTING: "CONNECTING",

    ONLINE: "ONLINE",

    BUFFERING: "BUFFERING",

    RECONNECTING: "RECONNECTING",

    OFFLINE: "OFFLINE",

    ERROR: "ERROR",

    STOPPED: "STOPPED"

});

class StateManager {

    constructor() {

        this.currentState = STATES.INIT;

        this.history = [];

        this.listeners = [];

    }

    getState() {

        return this.currentState;

    }

    hasState(state) {

        return this.currentState === state;

    }

    setState(state) {

        if (state === this.currentState) {

            return;

        }

        const previous = this.currentState;

        this.currentState = state;

        this.history.push({

            previous,

            state,

            timestamp: new Date()

        });

        console.log(`[State] ${previous} -> ${state}`);

        this.listeners.forEach(listener => {

            try {

                listener(state, previous);

            }
            catch (err) {

                console.error("[StateManager]", err);

            }

        });

    }

    subscribe(callback) {

        this.listeners.push(callback);

    }

    unsubscribe(callback) {

        this.listeners = this.listeners.filter(

            listener => listener !== callback

        );

    }

    getHistory() {

        return [...this.history];

    }

    clearHistory() {

        this.history = [];

    }

}

export default new StateManager();