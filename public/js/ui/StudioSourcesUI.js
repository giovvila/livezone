export default class StudioSourcesUI {

    constructor(root, studioCatalogManager, studioAssetLibrary = null) {
        this.root = root;
        this.catalog = studioCatalogManager;
        this.assetLibrary = studioAssetLibrary;
        this.started = false;
        this.sources = [];
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleListClick = this.handleListClick.bind(this);
        this.render = this.render.bind(this);
        this.renderAssets = this.renderAssets.bind(this);
        this.handleAssetChange = this.handleAssetChange.bind(this);
        this.handleTypeChange = this.handleTypeChange.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.catalog) {
            return false;
        }

        this.form = this.root.querySelector("#studio-source-form");
        this.nameInput = this.root.querySelector("#studio-source-name");
        this.typeInput = this.root.querySelector("#studio-source-type");
        this.urlInput = this.root.querySelector("#studio-source-url");
        this.assetSelect = this.root.querySelector("#studio-source-asset");
        this.audioAssetSelect = this.root.querySelector(
            "#studio-source-audio-asset"
        );
        this.stillAssetSelect = this.root.querySelector(
            "#studio-source-still-asset"
        );
        this.mediaFields = this.root.querySelector("#studio-source-media-fields");
        this.audioFields = this.root.querySelector("#studio-source-audio-fields");
        this.submitButton = this.root.querySelector("#studio-source-submit");
        this.list = this.root.querySelector("#studio-source-list");
        this.feedback = this.root.querySelector("#studio-source-feedback");

        if (!this.form || !this.nameInput || !this.typeInput ||
            !this.urlInput || !this.assetSelect || !this.audioAssetSelect ||
            !this.stillAssetSelect || !this.mediaFields || !this.audioFields ||
            !this.submitButton || !this.list ||
            !this.feedback || typeof this.catalog.subscribe !== "function") {
            return false;
        }

        this.form.addEventListener("submit", this.handleSubmit);
        this.list.addEventListener("click", this.handleListClick);
        this.assetSelect.addEventListener("change", this.handleAssetChange);
        this.typeInput.addEventListener("change", this.handleTypeChange);
        this.started = true;
        this.unsubscribe = this.catalog.subscribe(this.render);
        this.unsubscribeAssets = this.assetLibrary?.subscribe(this.renderAssets);
        this.handleAssetChange();
        this.handleTypeChange();
        return true;
    }

    destroy() {
        if (!this.started) {
            return;
        }
        this.form.removeEventListener("submit", this.handleSubmit);
        this.list.removeEventListener("click", this.handleListClick);
        this.assetSelect.removeEventListener("change", this.handleAssetChange);
        this.typeInput.removeEventListener("change", this.handleTypeChange);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.unsubscribeAssets?.();
        this.unsubscribeAssets = null;
        this.started = false;
    }

    handleSubmit(event) {
        event.preventDefault();
        const audio = this.typeInput.value === "audio";
        const result = audio
            ? this.catalog.addAudio({
                name: this.nameInput.value,
                audioAssetId: this.audioAssetSelect.value,
                stillAssetId: this.stillAssetSelect.value
            })
            : this.catalog.addMedia({
                name: this.nameInput.value,
                url: this.urlInput.value,
                assetId: this.assetSelect.value || null
            });

        if (!result.ok) {
            this.setFeedback(this.messageFor(result.reason), true);
            return;
        }

        this.form.reset();
        this.handleTypeChange();
        this.handleAssetChange();
        this.setFeedback(`Added ${result.source.name}.`, false);
        this.nameInput.focus();
    }

    handleAssetChange() {
        const usingAsset = Boolean(this.assetSelect.value);
        this.urlInput.disabled = usingAsset;
        this.urlInput.required = !usingAsset;
    }

    handleTypeChange() {
        const audio = this.typeInput.value === "audio";
        this.mediaFields.hidden = audio;
        this.audioFields.hidden = !audio;
        this.assetSelect.disabled = audio;
        this.urlInput.disabled = audio || Boolean(this.assetSelect.value);
        this.urlInput.required = !audio && !this.assetSelect.value;
        this.audioAssetSelect.disabled = !audio;
        this.stillAssetSelect.disabled = !audio;
        this.audioAssetSelect.required = audio;
        this.stillAssetSelect.required = audio;
        this.submitButton.textContent = audio
            ? "ADD AUDIO + SCENE"
            : "ADD MEDIA + SCENE";
    }

    renderAssets(assets) {
        if (!this.started) {
            return;
        }
        const selected = this.assetSelect.value;
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Manual URL / path";
        const options = assets.filter((asset) => asset.kind === "video")
            .map((asset) => {
                const option = document.createElement("option");
                option.value = asset.id;
                option.textContent = `${asset.name} (${asset.origin.toUpperCase()})`;
                return option;
            });
        this.assetSelect.replaceChildren(placeholder, ...options);
        if (options.some((option) => option.value === selected)) {
            this.assetSelect.value = selected;
        }
        this.renderAssetOptions(
            this.audioAssetSelect,
            assets.filter((asset) => asset.kind === "audio")
        );
        this.renderAssetOptions(
            this.stillAssetSelect,
            assets.filter((asset) => asset.kind === "still")
        );
        this.handleAssetChange();
        this.handleTypeChange();
    }

    renderAssetOptions(select, assets) {
        const selected = select.value;
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = assets.length
            ? "Choose asset"
            : "No matching assets";
        const options = assets.map((asset) => {
            const option = document.createElement("option");
            option.value = asset.id;
            option.textContent = `${asset.name} (${asset.origin.toUpperCase()})`;
            return option;
        });
        select.replaceChildren(placeholder, ...options);
        if (options.some((option) => option.value === selected)) {
            select.value = selected;
        }
    }

    handleListClick(event) {
        const button = event.target.closest("[data-remove-source-id]");
        if (!button || !this.list.contains(button)) {
            return;
        }

        const result = this.catalog.removeSource(button.dataset.removeSourceId);
        if (!result.ok) {
            this.setFeedback(this.messageFor(result.reason), true);
            return;
        }
        this.setFeedback(`Removed ${result.source.name}.`, false);
    }

    render(sources) {
        if (!this.started) {
            return;
        }
        this.sources = sources;
        this.list.replaceChildren(...sources.map((source) =>
            this.createSourceItem(source)
        ));
    }

    createSourceItem(source) {
        const item = document.createElement("li");
        const header = document.createElement("div");
        const name = document.createElement("strong");
        const badge = document.createElement("span");
        const id = document.createElement("code");
        const url = document.createElement("span");
        const asset = document.createElement("span");
        const remove = document.createElement("button");

        item.className = "studio-source-item";
        header.className = "studio-source-item__header";
        name.textContent = source.name;
        badge.className = "studio-source-item__origin";
        badge.textContent = `${source.kind.toUpperCase()} · ${
            source.origin === "base" ? "BASE" : "LOCAL"
        }`;
        id.className = "studio-source-item__id";
        id.textContent = source.id;
        url.className = "studio-source-item__url";
        const sourcePath = source.kind === "audio"
            ? `${source.audioUrl} + ${source.stillUrl}`
            : source.url;
        url.textContent = sourcePath;
        url.title = sourcePath;
        asset.className = "studio-source-item__asset";
        asset.textContent = source.kind === "audio"
            ? `AUDIO: ${source.audioAssetId} · STILL: ${source.stillAssetId}`
            : source.assetId
                ? `Asset: ${source.assetId}`
                : "Direct URL";
        remove.type = "button";
        remove.className = "studio-source-item__remove";
        remove.textContent = source.removable ? "REMOVE" : "PROTECTED";
        remove.disabled = !source.removable;
        if (source.removable) {
            remove.dataset.removeSourceId = source.id;
            remove.setAttribute("aria-label", `Remove ${source.name}`);
        }

        header.append(name, badge);
        item.append(header, id, asset, url, remove);
        return item;
    }

    setFeedback(message, isError) {
        this.feedback.textContent = message;
        this.feedback.classList.toggle("is-error", isError);
    }

    messageFor(reason) {
        const messages = {
            "invalid-name": "Enter a valid source name.",
            "invalid-url": "Enter a valid HTTP(S) URL or relative path.",
            "invalid-video-asset": "Choose an available VIDEO asset.",
            "invalid-audio-asset": "Choose an available AUDIO asset.",
            "invalid-still-asset": "Choose an available STILL asset.",
            "base-source-protected": "Base sources cannot be removed.",
            "scene-on-air": "Remove rejected: source is in Preview or Program.",
            "scene-in-transition": "Remove rejected: a transition is active.",
            "source-still-referenced": "Remove rejected: source is still referenced.",
            "source-has-active-instances": "Remove rejected: source is still active.",
            "persistence-failed": "The local media catalog could not be saved."
        };
        return messages[reason] || "The source catalog operation was rejected.";
    }
}
