/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * Reconnect Manager
 * ------------------------------------------------------------
 * Gestisce i tentativi di riconnessione dello stream.
 * ============================================================
 */

export default class ReconnectManager {

    constructor(callback, delay = 5000) {

        this.callback = callback;
        this.delay = delay;

        this.timer = null;
        this.running = false;
        this.attempt = 0;

    }

    start() {

        if (this.running) {
            return;
        }

        this.running = true;
        this.schedule();

    }

    stop() {

        this.running = false;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

    }

    reset() {

        this.stop();
        this.attempt = 0;

    }

    schedule() {

        if (!this.running) {
            return;
        }

        this.timer = setTimeout(async () => {

            this.attempt++;

            try {

                await this.callback(this.attempt);

            } catch (err) {

                console.error(err);

            }

            if (this.running) {
                this.schedule();
            }

        }, this.delay);

    }

    isRunning() {

        return this.running;

    }

    getAttempts() {

        return this.attempt;

    }

    setDelay(delay) {

        this.delay = delay;

    }

}