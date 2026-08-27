import StudioHlsSurface from "../studio/renderers/StudioHlsSurface.js";

const SELECTION_KEY = "livezone.control.technicalLiveSource.v1";

export default class TechnicalLiveMonitorUI {
    constructor({ root, catalog, monitor, storage = globalThis.localStorage } = {}) {
        this.root = root; this.catalog = catalog; this.monitor = monitor; this.storage = storage;
        this.renderSnapshot = this.renderSnapshot.bind(this);
        this.renderSources = this.renderSources.bind(this);
        this.handleChange = this.handleChange.bind(this);
    }
    start() {
        if (this.started || !this.root || !this.catalog || !this.monitor) return false;
        this.select = this.root.querySelector("#technical-live-source");
        this.surface = this.root.querySelector("#technical-live-surface");
        this.status = this.root.querySelector("#technical-live-status");
        this.lastOk = this.root.querySelector("#technical-live-last-ok");
        this.resolution = this.root.querySelector("#technical-live-resolution");
        this.endpoint = this.root.querySelector("#technical-live-endpoint");
        this.empty = this.root.querySelector("#technical-live-empty");
        if ([this.select, this.surface, this.status, this.lastOk, this.resolution,
            this.endpoint, this.empty].some((node) => !node)) return false;
        this.started = true; this.select.addEventListener("change", this.handleChange);
        this.unsubscribeMonitor = this.monitor.subscribe(this.renderSnapshot);
        this.unsubscribeCatalog = this.catalog.subscribe(this.renderSources);
        return true;
    }
    destroy() { if (!this.started) return; this.select.removeEventListener("change", this.handleChange);
        this.unsubscribeMonitor?.(); this.unsubscribeCatalog?.(); this.monitor.destroy(); this.started = false; }
    renderSources(sources) {
        const enabled = sources.filter(({ kind, enabled }) => kind === "hls" && enabled !== false);
        const stored = this.readSelection();
        const selected = enabled.some(({ id }) => id === this.select.value) ? this.select.value
            : enabled.some(({ id }) => id === stored) ? stored : "";
        const placeholder = document.createElement("option");
        placeholder.value = ""; placeholder.textContent = enabled.length ? "SELECT LIVE SOURCE" : "NO LIVE SOURCES CONFIGURED";
        this.select.replaceChildren(placeholder, ...enabled.map((source) => {
            const option = document.createElement("option"); option.value = source.id;
            option.textContent = source.name; return option;
        }));
        this.select.value = selected; this.empty.hidden = enabled.length > 0;
        if (!selected) { this.clearSelection(); return; }
        const source = enabled.find(({ id }) => id === selected);
        const snapshot = this.monitor.getSnapshot();
        if (snapshot.sourceId !== selected || snapshot.endpoint !== source.url) {
            this.monitor.selectSource(source);
        }
    }
    handleChange() {
        const source = this.catalog.getSources().find((item) =>
            item.id === this.select.value && item.kind === "hls" && item.enabled !== false);
        if (!source) return this.clearSelection();
        try { this.storage?.setItem(SELECTION_KEY, source.id); } catch {}
        this.monitor.selectSource(source);
    }
    clearSelection() { try { this.storage?.removeItem(SELECTION_KEY); } catch {}
        this.select.value = ""; this.monitor.stop(); this.surface.replaceChildren(); }
    readSelection() { try { return this.storage?.getItem(SELECTION_KEY) || ""; } catch { return ""; } }
    renderSnapshot(snapshot) {
        this.root.dataset.technicalState = snapshot.state.toLowerCase();
        this.status.textContent = `● ${snapshot.state}`;
        this.lastOk.textContent = snapshot.lastOnlineAt
            ? new Date(snapshot.lastOnlineAt).toLocaleTimeString("it-IT") : "—";
        this.resolution.textContent = snapshot.width && snapshot.height
            ? `${snapshot.width}×${snapshot.height}` : "—";
        this.endpoint.textContent = this.abbreviate(snapshot.endpoint);
    }
    abbreviate(value) { if (!value) return "—"; try { const url = new URL(value);
        return `${url.host}${url.pathname}`.slice(0, 80); } catch { return "—"; } }

    static createConsumerFactory(root) {
        let nextId = 1;
        return (source, handlers) => {
            const surface = new StudioHlsSurface({ sourceId: source.id, sourceUrl: source.url,
                instanceId: `technical-live-${nextId++}`, consumer: "technical" });
            let unsubscribe = null; let video = null;
            const onMetadata = () => handlers.online({ width: video.videoWidth, height: video.videoHeight });
            return {
                async start() {
                    unsubscribe = surface.subscribeHealth((health) => {
                        if (health.state === "error") handlers.error(health.reason);
                    });
                    await surface.start(root); video = surface.video;
                    video?.addEventListener("loadedmetadata", onMetadata);
                    surface.waitUntilReady({ timeoutMs: 12000 }).then(() => {
                        video = surface.video; handlers.online({ width: video?.videoWidth,
                            height: video?.videoHeight });
                    }).catch((error) => {
                        if (error?.code === "readiness-timeout") handlers.offline();
                        else handlers.error(surface.getHealth()?.reason);
                    });
                },
                destroy() { video?.removeEventListener("loadedmetadata", onMetadata);
                    unsubscribe?.(); surface.destroy(); }
            };
        };
    }
}
