/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * Logger
 * ------------------------------------------------------------
 * Gestione centralizzata dei log dell'applicazione.
 * ============================================================
 */

export default class Logger {

    static enabled = true;

    static showTimestamp = true;

    static buildPrefix(level) {

        if (!this.showTimestamp) {
            return `[${level}]`;
        }

        const now = new Date();

        const time =
            now.toLocaleTimeString("it-IT", {
                hour12: false
            });

        return `[${time}] [${level}]`;

    }

    static info(...args) {

        if (!this.enabled) return;

        console.log(
            this.buildPrefix("INFO"),
            ...args
        );

    }

    static warn(...args) {

        if (!this.enabled) return;

        console.warn(
            this.buildPrefix("WARN"),
            ...args
        );

    }

    static error(...args) {

        if (!this.enabled) return;

        console.error(
            this.buildPrefix("ERROR"),
            ...args
        );

    }

    static success(...args) {

        if (!this.enabled) return;

        console.log(
            this.buildPrefix("OK"),
            ...args
        );

    }

    static enable() {

        this.enabled = true;

    }

    static disable() {

        this.enabled = false;

    }

}