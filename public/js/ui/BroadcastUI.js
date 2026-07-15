import Clock from "./Clock.js";

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class BroadcastUI {

    start() {

        const clock = document.getElementById("clock");

        if (clock) {
            new Clock(clock).start();
        }

        EventBus.on(Events.STREAM_READY, () => {

            const splash = document.getElementById("splash");

            if (splash) {
                splash.classList.add("hide");
            }

            const status = document.getElementById("status");

            if (status) {
                status.textContent = "● ONLINE";
            }

            console.log("BroadcastUI → STREAM_READY");

        });

        EventBus.on(Events.STREAM_ERROR, () => {

            const status = document.getElementById("status");

            if (status) {
                status.textContent = "● OFFLINE";
            }

            console.log("BroadcastUI → STREAM_ERROR");

        });

    }

}