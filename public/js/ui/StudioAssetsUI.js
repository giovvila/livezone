const KIND_LABELS = Object.freeze({
    video: "VIDEO",
    audio: "AUDIO",
    still: "STILL",
    logo: "LOGO"
});

export default class StudioAssetsUI {

    constructor(root, assetLibrary) {
        this.root = root;
        this.assetLibrary = assetLibrary;
        this.started = false;
        this.assets = [];
        this.filter = "all";
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleListClick = this.handleListClick.bind(this);
        this.handleFilterChange = this.handleFilterChange.bind(this);
        this.render = this.render.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.assetLibrary) {
            return false;
        }
        this.form = this.root.querySelector("#studio-asset-form");
        this.nameInput = this.root.querySelector("#studio-asset-name");
        this.kindInput = this.root.querySelector("#studio-asset-kind");
        this.urlInput = this.root.querySelector("#studio-asset-url");
        this.filterInput = this.root.querySelector("#studio-asset-filter");
        this.list = this.root.querySelector("#studio-asset-list");
        this.feedback = this.root.querySelector("#studio-asset-feedback");
        if (!this.form || !this.nameInput || !this.kindInput ||
            !this.urlInput || !this.filterInput || !this.list ||
            !this.feedback || typeof this.assetLibrary.subscribe !== "function") {
            return false;
        }

        this.form.addEventListener("submit", this.handleSubmit);
        this.list.addEventListener("click", this.handleListClick);
        this.filterInput.addEventListener("change", this.handleFilterChange);
        this.started = true;
        this.unsubscribe = this.assetLibrary.subscribe(this.render);
        return true;
    }

    destroy() {
        if (!this.started) {
            return;
        }
        this.form.removeEventListener("submit", this.handleSubmit);
        this.list.removeEventListener("click", this.handleListClick);
        this.filterInput.removeEventListener("change", this.handleFilterChange);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.started = false;
    }

    handleSubmit(event) {
        event.preventDefault();
        const result = this.assetLibrary.addAsset({
            name: this.nameInput.value,
            kind: this.kindInput.value,
            url: this.urlInput.value
        });
        if (!result.ok) {
            this.setFeedback(this.messageFor(result.reason), true);
            return;
        }
        this.form.reset();
        this.setFeedback(`Added ${result.asset.name} reference.`, false);
        this.nameInput.focus();
    }

    handleListClick(event) {
        const button = event.target.closest("[data-remove-asset-id]");
        if (!button || !this.list.contains(button)) {
            return;
        }
        const result = this.assetLibrary.removeAsset(
            button.dataset.removeAssetId
        );
        if (!result.ok) {
            this.setFeedback(this.messageFor(result.reason), true);
            return;
        }
        this.setFeedback(`Removed ${result.asset.name} reference.`, false);
    }

    handleFilterChange() {
        this.filter = this.filterInput.value;
        this.renderList();
    }

    render(assets) {
        if (!this.started) {
            return;
        }
        this.assets = assets;
        this.renderList();
    }

    renderList() {
        const visible = this.filter === "all"
            ? this.assets
            : this.assets.filter((asset) => asset.kind === this.filter);
        this.list.replaceChildren(...visible.map((asset) =>
            this.createAssetItem(asset)
        ));
    }

    createAssetItem(asset) {
        const item = document.createElement("li");
        const header = document.createElement("div");
        const name = document.createElement("strong");
        const kind = document.createElement("span");
        const origin = document.createElement("span");
        const id = document.createElement("code");
        const url = document.createElement("span");
        const remove = document.createElement("button");

        item.className = "studio-asset-item";
        header.className = "studio-asset-item__header";
        name.textContent = asset.name;
        kind.className = "studio-asset-item__kind";
        kind.textContent = KIND_LABELS[asset.kind];
        origin.className = "studio-asset-item__origin";
        origin.textContent = asset.origin === "base" ? "BASE" : "OPERATOR";
        id.className = "studio-asset-item__id";
        id.textContent = asset.id;
        url.className = "studio-asset-item__url";
        url.textContent = asset.url;
        url.title = asset.url;
        remove.type = "button";
        remove.className = "studio-asset-item__remove";
        remove.textContent = asset.removable ? "REMOVE" : "PROTECTED";
        remove.disabled = !asset.removable;
        if (asset.removable) {
            remove.dataset.removeAssetId = asset.id;
            remove.setAttribute("aria-label", `Remove ${asset.name}`);
        }

        header.append(name, kind, origin);
        item.append(header, id, url, remove);
        return item;
    }

    setFeedback(message, isError) {
        this.feedback.textContent = message;
        this.feedback.classList.toggle("is-error", isError);
    }

    messageFor(reason) {
        const messages = {
            "invalid-name": "Enter a valid asset name.",
            "invalid-kind": "Choose a supported asset kind.",
            "invalid-url": "Enter a valid HTTP(S) URL or relative path.",
            "base-asset-protected": "Base assets cannot be removed.",
            "asset-still-referenced": "Remove rejected: asset is still in use.",
            "operator-limit-reached": "The 100 operator asset limit was reached.",
            "persistence-failed": "The local asset overlay could not be saved."
        };
        return messages[reason] || "The asset operation was rejected.";
    }
}
