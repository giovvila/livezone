/*
====================================================

LIVEZONE Broadcast Engine

Module  : NotificationCenter

Version : 1.1.0

Build   : 1007.5

Status  : STABLE

====================================================
*/

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class NotificationCenter {

    constructor() {

        this.container =
            document.getElementById(
                "notification-center"
            );

        if (!this.container) {

            this.container =
                document.createElement("div");

            this.container.id =
                "notification-center";

            this.container.className =
                "notification-center";

            document.body.appendChild(
                this.container
            );

        }

        /*
        ============================================
        Runtime
        ============================================
        */

        this.currentToast = null;

        this.currentTimer = null;

        this.lastMessage = "";

        this.lastType = "";

        this.lastTimestamp = 0;

        this.bind();

    }

    /*
    ============================================
    Event Binding
    ============================================
    */

    bind() {

        EventBus.on(

            Events.STREAM_READY,

            () => {

                this.success(

                    "LIVEZONE",

                    "Stream connesso"

                );

            }

        );

        EventBus.on(

            Events.STREAM_RECONNECT,

            () => {

                this.warning(

                    "LIVEZONE",

                    "Riconnessione..."

                );

            }

        );

        EventBus.on(

            Events.STREAM_OFFLINE,

            () => {

                this.error(

                    "LIVEZONE",

                    "Segnale assente"

                );

            }

        );

        EventBus.on(

            Events.STREAM_ERROR,

            () => {

                this.error(

                    "LIVEZONE",

                    "Errore stream"

                );

            }

        );

    }

    /*
    ============================================
    Public API
    ============================================
    */

    success(title, message) {

        this.show(

            title,

            message,

            "success"

        );

    }

    warning(title, message) {

        this.show(

            title,

            message,

            "warning"

        );

    }

    error(title, message) {

        this.show(

            title,

            message,

            "error"

        );

    }

    /*
    ============================================
    Main
    ============================================
    */

    show(title, message, type) {

        const now = Date.now();

        /*
        ----------------------------------------
        Duplicate protection
        ----------------------------------------
        */

        if (

            message === this.lastMessage &&

            type === this.lastType &&

            (now - this.lastTimestamp) < 1000

        ) {

            return;

        }

        this.lastMessage = message;

        this.lastType = type;

        this.lastTimestamp = now;

        /*
        ----------------------------------------
        Remove previous toast
        ----------------------------------------
        */

        if (this.currentTimer) {

            clearTimeout(this.currentTimer);

            this.currentTimer = null;

        }

        if (this.currentToast) {

            this.currentToast.remove();

            this.currentToast = null;

        }

        const toast =
            document.createElement("div");

        toast.className =
            `notification notification--${type}`;

        toast.innerHTML = `
                    <div class="notification__title">

                ${title}

            </div>

            <div class="notification__message">

                ${message}

            </div>

        `;

        this.container.appendChild(toast);

        this.currentToast = toast;

        requestAnimationFrame(() => {

            toast.classList.add(
                "notification--visible"
            );

        });

        this.currentTimer = setTimeout(() => {

            if (!this.currentToast) {

                return;

            }

            this.currentToast.classList.remove(
                "notification--visible"
            );

            const toastToRemove =
                this.currentToast;

            this.currentToast = null;

            setTimeout(() => {

                if (toastToRemove) {

                    toastToRemove.remove();

                }

            }, 350);

        }, 3000);

    }

    /*
    ============================================
    Cleanup
    ============================================
    */

    destroy() {

        if (this.currentTimer) {

            clearTimeout(
                this.currentTimer
            );

            this.currentTimer = null;

        }

        if (this.currentToast) {

            this.currentToast.remove();

            this.currentToast = null;

        }

    }

}