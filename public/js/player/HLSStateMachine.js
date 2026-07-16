/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * HLS State Machine
 * ============================================================
 */

import HLSState from "./HLSState.js";

export default class HLSStateMachine {

    constructor() {

        this.current = HLSState.IDLE;
        this.previous = null;

    }

    getState() {

        return this.current;

    }

    is(state) {

        return this.current === state;

    }

    transition(nextState) {

        if (!Object.values(HLSState).includes(nextState)) {

            throw new Error(`Invalid HLS state: ${nextState}`);

        }

        if (this.current === nextState) {

            return false;

        }

        this.previous = this.current;
        this.current = nextState;

        return true;

    }

    reset() {

        this.previous = null;
        this.current = HLSState.IDLE;

    }

}