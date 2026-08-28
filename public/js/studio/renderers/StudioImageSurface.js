export default class StudioImageSurface {
    constructor({ sourceId, sourceUrl, instanceId, consumer, onDestroyed }) {
        Object.assign(this, { sourceId, sourceUrl, instanceId, consumer, onDestroyed });
        this.image = null;
        this.state = "pending";
        this.error = null;
        this.waiters = new Set();
        this.handleLoad = this.handleLoad.bind(this);
        this.handleError = this.handleError.bind(this);
    }

    start(root) {
        if (this.image || !root) return Promise.resolve();
        const image = document.createElement("img");
        image.className = "studio-render-image-source";
        image.alt = "";
        image.addEventListener("load", this.handleLoad);
        image.addEventListener("error", this.handleError);
        this.image = image;
        root.replaceChildren(image);
        image.src = this.sourceUrl;
        if (image.complete) image.naturalWidth > 0 ? this.handleLoad() : this.handleError();
        return Promise.resolve();
    }

    waitUntilReady({ timeoutMs } = {}) {
        if (this.state === "ready") return Promise.resolve();
        if (this.state === "failed") return Promise.reject(this.error);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    this.waiters.delete(waiter);
                    reject(this.createError("readiness-timeout"));
                }, timeoutMs);
            }
            this.waiters.add(waiter);
        });
    }

    handleLoad() {
        if (this.state !== "pending") return;
        this.state = "ready";
        this.settle("resolve");
    }

    handleError() {
        if (this.state !== "pending") return;
        this.state = "failed";
        this.error = this.createError("image-load-error");
        this.settle("reject", this.error);
    }

    settle(action, value) {
        this.waiters.forEach((waiter) => {
            clearTimeout(waiter.timer);
            waiter[action](value);
        });
        this.waiters.clear();
    }

    createError(code) {
        const error = new Error(`Studio image not ready: ${code}`);
        error.code = code;
        return error;
    }

    destroy() {
        if (this.state === "destroyed") return;
        if (this.state === "pending") {
            this.error = this.createError("destroyed-before-ready");
            this.settle("reject", this.error);
        }
        this.state = "destroyed";
        if (this.image) {
            this.image.removeEventListener("load", this.handleLoad);
            this.image.removeEventListener("error", this.handleError);
            this.image.removeAttribute("src");
            this.image.remove();
            this.image = null;
        }
        this.onDestroyed?.(this);
        this.onDestroyed = null;
    }
}
