export default class MediaLibraryUI {
    constructor(root, manager, { storage } = {}) { this.root = root; this.manager = manager; this.storage = storage === undefined ? this.getStorage() : storage; this.collapsed = false; this.handleFile = this.handleFile.bind(this); this.handleFilter = this.handleFilter.bind(this); this.handleToggle = this.handleToggle.bind(this); this.render = this.render.bind(this); }
    start() {
        if (!this.root || !this.manager || this.started) return false;
        this.input = this.root.querySelector("#media-library-input"); this.filter = this.root.querySelector("#media-library-filter"); this.list = this.root.querySelector("#media-library-list"); this.status = this.root.querySelector("#media-library-status"); this.toggle = this.root.querySelector("#media-library-toggle");
        if (!this.input || !this.filter || !this.list || !this.status || !this.toggle) return false;
        this.collapsed = this.loadCollapsed();
        this.input.addEventListener("change", this.handleFile); this.filter.addEventListener("change", this.handleFilter); this.toggle.addEventListener("click", this.handleToggle);
        this.applyCollapsed();
        this.unsubscribe = this.manager.subscribe(this.render); this.started = true;
        void this.manager.initialize().catch(() => {}); return true;
    }
    async handleFile() { const file = this.input.files?.[0]; if (!file) return; try { await this.manager.importAsset(file); this.input.value = ""; } catch {} }
    handleFilter() { this.render(this.manager.getSnapshot()); }
    handleToggle() { this.collapsed = !this.collapsed; this.persistCollapsed(); this.applyCollapsed(); }
    applyCollapsed() { this.list.hidden = this.collapsed; this.root.classList.toggle("is-collapsed", this.collapsed); this.toggle.setAttribute("aria-expanded", String(!this.collapsed)); this.toggle.textContent = this.collapsed ? "EXPAND ▼" : "COLLAPSE ▲"; }
    loadCollapsed() { try { const value = this.storage?.getItem("livezone.control.mediaLibrary.collapsed.v1"); return value === "true" ? true : value === "false" || value === null ? false : false; } catch { return false; } }
    persistCollapsed() { try { this.storage?.setItem("livezone.control.mediaLibrary.collapsed.v1", String(this.collapsed)); } catch {} }
    getStorage() { try { return globalThis.localStorage; } catch { return null; } }
    render(snapshot) {
        const assets = snapshot.assets.filter((asset) => !this.filter.value || asset.kind === this.filter.value);
        this.status.textContent = snapshot.state === "uploading" ? `IMPORTING${snapshot.progress?.percent === null ? "" : ` · ${snapshot.progress?.percent}%`}` : snapshot.error ? `${snapshot.error.code} · ${snapshot.error.message}` : `${assets.length} ASSET${assets.length === 1 ? "" : "S"}`;
        this.list.replaceChildren(...assets.map((asset) => {
            const item = document.createElement("li"); item.className = "media-library-item";
            const title = document.createElement("strong"); title.textContent = asset.originalName;
            const meta = document.createElement("span"); meta.textContent = `${asset.kind.toUpperCase()} · ${asset.mimeType} · ${this.formatBytes(asset.size)}`;
            const id = document.createElement("code"); id.textContent = asset.id;
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "media-library-item__delete"; remove.textContent = "DELETE · SOURCE INTEGRATION"; remove.disabled = true; remove.title = "Available in Source Integration after reference guards are connected.";
            item.append(title, meta, id, remove); return item;
        }));
    }
    formatBytes(value) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 ** 2).toFixed(1)} MiB`; }
    destroy() { this.unsubscribe?.(); this.unsubscribe = null; this.input?.removeEventListener("change", this.handleFile); this.filter?.removeEventListener("change", this.handleFilter); this.toggle?.removeEventListener("click", this.handleToggle); this.started = false; }
}
