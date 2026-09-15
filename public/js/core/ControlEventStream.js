// One authenticated HTTP stream per Control document. Consumers own leases,
// not sockets. Named server events retain their existing payload/authority.
export default class ControlEventStream {
    constructor({eventSourceFactory = url => new EventSource(url),
        baseUrl = globalThis.location?.href, lifecycle = globalThis,
        setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
        Object.assign(this, {eventSourceFactory, baseUrl, lifecycle, setTimer, clearTimer});
        this.leases = new Set();
        this.retained = new Map();
        this.source = null;
        this.retryTimer = null;
        this.destroyed = false;
        this.pagehide = () => this.destroy();
        lifecycle.addEventListener?.('pagehide', this.pagehide, {once: true});
    }

    presenceSource = value => {
        const url = new URL(value, this.baseUrl);
        url.searchParams.set('controlEvents', '1');
        if (this.url && this.url !== url.href) throw new Error('Control presence identity changed; reload required');
        this.url = url.href;
        return this.acquire();
    };

    eventSource = value => {
        const url = new URL(value, this.baseUrl);
        if (url.origin !== new URL(this.baseUrl).origin ||
            !['/api/program-output/events', '/api/studio/schedule/events'].includes(url.pathname)) {
            throw new Error('Control event channel requires the canonical same-origin authority');
        }
        return this.acquire();
    };

    acquire() {
        if (this.destroyed || !this.url) throw new Error('Control event stream is unavailable');
        const listeners = new Map();
        const owner = this;
        const lease = {
            closed: false,
            // CONNECTING exposes the owner's retry, never a second consumer retry.
            get readyState() { return this.closed ? 2 : owner.source?.readyState === 1 ? 1 : 0; },
            addEventListener(type, listener) {
                if (this.closed) return;
                if (!listeners.has(type)) listeners.set(type, new Set());
                const set = listeners.get(type);
                if (set.has(listener)) return;
                set.add(listener);
                const event = owner.retained.get(type);
                if (event) queueMicrotask(() => {
                    if (!this.closed && set.has(listener) &&
                        owner.retained.get(type) === event) {
                        owner.deliver(listener, event);
                    }
                });
            },
            removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
            dispatch(event) {
                for (const listener of [...listeners.get(event.type) || []]) {
                    if (!this.closed) owner.deliver(listener, event);
                }
            },
            close() {
                if (this.closed) return;
                this.closed = true;
                listeners.clear();
                owner.leases.delete(this);
                if (!owner.leases.size) owner.disconnect();
            }
        };
        this.leases.add(lease);
        this.connect();
        return lease;
    }

    deliver(listener, event) {
        try { listener(event); }
        catch (error) { console.error('[ControlEventStream] consumer dispatch failed', error); }
    }

    connect() {
        if (this.destroyed || this.source || this.retryTimer !== null || !this.leases.size) return;
        try {
            const source = this.eventSourceFactory(this.url);
            this.source = source;
            this.handlers = new Map();
            for (const type of ['open', 'error', 'presence', 'program', 'schedule-state']) {
                const handler = event => {
                    if (this.source !== source || this.destroyed) return;
                    if (type === 'error') this.retained.clear();
                    if (type === 'open') this.retained.delete('error');
                    this.retained.set(type, event);
                    for (const lease of [...this.leases]) lease.dispatch(event);
                    if (type === 'error' && source.readyState === 2) {
                        this.closeSource();
                        this.retry();
                    }
                };
                this.handlers.set(type, handler);
                source.addEventListener(type, handler);
            }
        } catch {
            this.closeSource();
            this.retained.clear();
            const event = {type: 'error'};
            this.retained.set('error', event);
            for (const lease of this.leases) lease.dispatch(event);
            this.retry();
        }
    }

    retry() {
        if (this.destroyed || !this.leases.size || this.retryTimer !== null) return;
        this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.connect(); }, 3000);
        this.retryTimer?.unref?.();
    }

    closeSource() {
        const source = this.source;
        this.source = null;
        for (const [type, handler] of this.handlers || []) source?.removeEventListener(type, handler);
        source?.close();
        this.handlers = null;
    }

    disconnect() {
        this.clearTimer(this.retryTimer);
        this.retryTimer = null;
        this.closeSource();
        this.retained.clear();
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.lifecycle.removeEventListener?.('pagehide', this.pagehide);
        for (const lease of [...this.leases]) lease.close();
        this.disconnect();
    }
}
