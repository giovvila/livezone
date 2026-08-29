export default class MediaLibraryPickerUI {
    constructor(manager) {
        this.manager = manager;
        this.pending = null;
        this.handleClick = this.handleClick.bind(this);
    }

    start() {
        if (this.started || !this.manager) return false;
        this.root = document.createElement("div");
        this.root.className = "media-library-picker";
        this.root.hidden = true;
        this.root.innerHTML = `<div class="media-library-picker__dialog" role="dialog" aria-modal="true" aria-labelledby="media-library-picker-title"><h3 id="media-library-picker-title">MEDIA LIBRARY</h3><p data-picker-status></p><ul data-picker-list></ul><div class="media-library-picker__actions"><button type="button" data-picker-confirm disabled>SELECT</button><button type="button" data-picker-cancel>CANCEL</button></div></div>`;
        document.body.append(this.root);
        this.root.addEventListener("click", this.handleClick);
        this.started = true;
        return true;
    }

    choose({ kind, selectedId = null } = {}) {
        if (!this.started || this.pending) return Promise.reject(new Error("Picker unavailable."));
        this.kind = kind;
        this.selectedId = selectedId;
        this.render();
        this.root.hidden = false;
        return new Promise((resolve) => { this.pending = resolve; });
    }

    render() {
        const assets = this.manager.listAssets({ kind: this.kind });
        this.root.querySelector("[data-picker-status]").textContent = `${assets.length} ${this.kind.toUpperCase()} ASSET${assets.length === 1 ? "" : "S"}`;
        this.root.querySelector("[data-picker-list]").replaceChildren(...assets.map((asset) => {
            const item = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.pickerAsset = asset.id;
            button.classList.toggle("is-selected", asset.id === this.selectedId);
            button.textContent = `${asset.originalName} · ${asset.mimeType} · ${this.formatBytes(asset.size)}`;
            item.append(button);
            return item;
        }));
        this.root.querySelector("[data-picker-confirm]").disabled = !this.selectedId;
    }

    handleClick(event) {
        const assetButton = event.target.closest("[data-picker-asset]");
        if (assetButton) { this.selectedId = assetButton.dataset.pickerAsset; this.render(); return; }
        if (event.target.closest("[data-picker-confirm]")) return this.finish(this.manager.getAsset(this.selectedId));
        if (event.target.closest("[data-picker-cancel]") || event.target === this.root) this.finish(null);
    }

    finish(asset) {
        const resolve = this.pending;
        this.pending = null;
        this.root.hidden = true;
        resolve?.(asset || null);
    }

    formatBytes(value) {
        if (value < 1024) return `${value} B`;
        if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
        return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    }

    destroy() {
        if (!this.started) return;
        this.finish(null);
        this.root.removeEventListener("click", this.handleClick);
        this.root.remove();
        this.started = false;
    }
}
