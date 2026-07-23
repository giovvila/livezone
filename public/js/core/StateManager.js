/*=====================================================

LIVEZONE Broadcast Engine

StateManager.js

Version : 1.0
Build   : 1005.2

=====================================================*/

export const STATES = Object.freeze({

    INIT: "INIT",

    CONNECTING: "CONNECTING",

    ONLINE: "ONLINE",

    OFFLINE: "OFFLINE",

    BUFFERING: "BUFFERING",

    ERROR: "ERROR"

});

class StateManager {

    constructor(){

        this.currentState = STATES.INIT;

        this.listeners = [];

    }

    getState(){

        return this.currentState;

    }

    setState(state){

        if(state === this.currentState){

            return;

        }

        const previous = this.currentState;

        this.currentState = state;

        console.log(
            `[State] ${previous} -> ${state}`
        );

        this.listeners.forEach(listener=>{

            listener(state, previous);

        });

    }

    subscribe(callback){

        this.listeners.push(callback);

    }

}

export default new StateManager();