export default class StudioOperationalSourcesUI {
    constructor(root, catalog, { mediaLibraryManager = null, mediaLibraryPicker = null } = {}) {
        this.root = root;
        this.catalog = catalog;
        this.mediaLibraryManager = mediaLibraryManager;
        this.mediaLibraryPicker = mediaLibraryPicker;
        this.selectedAssets = this.createSelectedAssets();
        this.editingId = null;
        this.activeCategory = "all";
        this.render = this.render.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleClick = this.handleClick.bind(this);
        this.handleCategoryClick = this.handleCategoryClick.bind(this);
        this.handleAddClick = this.handleAddClick.bind(this);
        this.handleKindChange = this.handleKindChange.bind(this);
        this.handleCancelClick = this.handleCancelClick.bind(this);
        this.handleFormClick = this.handleFormClick.bind(this);
        this.handleFileChange = this.handleFileChange.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.catalog) return false;
        this.list = this.root.querySelector("#studio-source-list");
        this.section = this.list?.closest(".studio-sources");
        if (!this.list || !this.section) return false;
        this.addButton = document.createElement("button");
        this.addButton.type = "button";
        this.addButton.className = "studio-source-add";
        this.addButton.textContent = "+ NEW SOURCE";
        this.categoryNav = this.createCategoryNav();
        this.form = this.createForm();
        this.feedback = document.createElement("p");
        this.feedback.className = "studio-sources__feedback";
        this.list.before(this.addButton, this.categoryNav, this.form, this.feedback);
        this.addButton.addEventListener("click", this.handleAddClick);
        this.categoryNav.addEventListener("click", this.handleCategoryClick);
        this.form.addEventListener("submit", this.handleSubmit);
        this.form.addEventListener("click", this.handleFormClick);
        this.form.addEventListener("change", this.handleFileChange);
        this.list.addEventListener("click", this.handleClick);
        this.started = true;
        this.unsubscribe = this.catalog.subscribe(this.render);
        return true;
    }

    destroy() {
        if (!this.started) return false;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.addButton?.removeEventListener("click", this.handleAddClick);
        this.categoryNav?.removeEventListener("click", this.handleCategoryClick);
        this.form?.removeEventListener("submit", this.handleSubmit);
        this.form?.removeEventListener("click", this.handleFormClick);
        this.form?.removeEventListener("change", this.handleFileChange);
        this.form?.elements.kind.removeEventListener("change", this.handleKindChange);
        this.cancelButton?.removeEventListener("click", this.handleCancelClick);
        this.list?.removeEventListener("click", this.handleClick);
        this.addButton?.remove();
        this.categoryNav?.remove();
        this.form?.remove();
        this.feedback?.remove();
        this.addButton = null;
        this.categoryNav = null;
        this.form = null;
        this.feedback = null;
        this.cancelButton = null;
        this.sources = null;
        this.editingId = null;
        this.started = false;
        return true;
    }

    handleAddClick() {
        this.openEditor();
    }

    handleKindChange() {
        this.syncFormKind();
    }

    handleCancelClick() {
        this.editingId = null;
        this.editingSource = null;
        this.form.hidden = true;
    }

    createCategoryNav() {
        const nav = document.createElement("div");
        nav.className = "studio-source-categories";
        nav.setAttribute("role", "group");
        nav.setAttribute("aria-label", "Filter sources by type");
        ["all", "live", "video", "audio", "image"].forEach((category) => {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.sourceCategory = category;
            button.textContent = category.toUpperCase();
            button.setAttribute("aria-pressed", String(category === "all"));
            nav.append(button);
        });
        return nav;
    }

    handleCategoryClick(event) {
        const button = event.target.closest("[data-source-category]");
        if (!button || !this.categoryNav.contains(button)) return;
        this.activeCategory = button.dataset.sourceCategory;
        this.categoryNav.querySelectorAll("[data-source-category]").forEach(
            (item) => item.setAttribute(
                "aria-pressed",
                String(item.dataset.sourceCategory === this.activeCategory)
            )
        );
        this.render(this.sources || []);
    }

    createForm() {
        const form = document.createElement("form");
        form.className = "studio-operational-source-form";
        form.hidden = true;
        form.innerHTML = `<label>TYPE<select name="kind" required><option value="live">LIVE · HLS</option><option value="video">VIDEO</option><option value="audio">AUDIO</option><option value="image">IMAGE</option></select></label><label>NAME<input name="name" maxlength="120" required></label><div data-source-managed hidden><span data-source-primary-label>MEDIA</span><div class="studio-source-asset-controls"><button type="button" data-source-library="primary">LIBRARY</button><label class="studio-source-browse">BROWSE PC<input type="file" data-source-file="primary"></label></div><p data-source-selection="primary">NONE</p></div><label data-source-url><span data-source-url-label>SOURCE URL / MEDIA URL</span><input name="url" maxlength="4096"></label><div data-source-artwork hidden><span>STATIC ARTWORK — OPTIONAL</span><div class="studio-source-asset-controls"><button type="button" data-source-library="artwork">LIBRARY</button><label class="studio-source-browse">BROWSE PC<input type="file" accept="image/jpeg,image/png,image/webp" data-source-file="artwork"></label><button type="button" data-source-clear-artwork>CLEAR</button></div><p data-source-selection="artwork">NONE</p><label>LEGACY ARTWORK URL<input name="stillUrl" maxlength="4096"></label><span>MOTION ARTWORK — OPTIONAL</span><div class="studio-source-asset-controls"><button type="button" data-source-library="motion">LIBRARY</button><label class="studio-source-browse">BROWSE PC<input type="file" accept="video/mp4" data-source-file="motion"></label><button type="button" data-source-clear-motion>CLEAR</button></div><p data-source-selection="motion">NONE</p></div><div class="studio-operational-source-form__actions"><button type="submit">SAVE</button><button type="button" data-source-cancel>CANCEL</button></div>`;
        form.elements.kind.addEventListener("change", this.handleKindChange);
        this.cancelButton = form.querySelector("[data-source-cancel]");
        this.cancelButton.addEventListener("click", this.handleCancelClick);
        return form;
    }

    openEditor(source = null) {
        this.editingId = source?.id || null;
        this.editingSource = source;
        this.form.reset();
        this.selectedAssets = this.createSelectedAssets(source);
        this.form.elements.kind.disabled = Boolean(source);
        if (source) {
            this.form.elements.kind.value = source.category;
            this.form.elements.name.value = source.name;
            this.form.elements.url.value = source.category === "audio" ? source.audioUrl : source.url;
            this.form.elements.stillUrl.value = source.stillUrl || "";
        }
        this.syncFormKind();
        this.form.hidden = false;
        this.form.elements.name.focus();
    }

    syncFormKind() {
        const kind = this.form.elements.kind.value;
        const audio = kind === "audio";
        const managed = kind !== "live";
        this.form.querySelector("[data-source-url-label]").textContent = audio
            ? "AUDIO URL"
            : "SOURCE URL / MEDIA URL";
        this.form.querySelector("[data-source-artwork]").hidden = !audio;
        this.form.querySelector("[data-source-managed]").hidden = !managed;
        this.form.querySelector("[data-source-primary-label]").textContent =
            audio ? "AUDIO FILE" : kind === "image" ? "IMAGE" : "MEDIA";
        const file = this.form.querySelector('[data-source-file="primary"]');
        file.accept = audio ? "audio/mpeg" : kind === "image"
            ? "image/jpeg,image/png,image/webp" : "video/mp4";
        if (!audio) this.form.elements.stillUrl.value = "";
        this.renderSelections();
    }

    handleSubmit(event) {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(this.form));
        data.kind = this.form.elements.kind.value;
        this.applyManagedSelections(data);
        const result = this.editingId
            ? this.catalog.updateSource(this.editingId, data)
            : this.catalog.addSource(data);
        if (!result.ok) return this.setFeedback(this.messageFor(result.reason), true);
        this.setFeedback(this.editingId ? "Source updated." : "Source created.");
        this.editingId = null;
        this.editingSource = null;
        this.form.hidden = true;
    }

    applyManagedSelections(data) {
        if (data.kind === "audio" && this.selectedAssets.primary) {
            data.audioAssetId = this.selectedAssets.primary.id;
            if (this.selectedAssets.artwork) data.stillAssetId = this.selectedAssets.artwork.id;
            if (this.selectedAssets.motion) data.motionAssetId = this.selectedAssets.motion.id;
        }
        else if (["video", "image"].includes(data.kind) && this.selectedAssets.primary) {
            data.assetId = this.selectedAssets.primary.id;
        }
        return data;
    }

    createSelectedAssets(source = null) {
        if (!source) return { primary: null, artwork: null, motion: null };
        const primaryId = source.category === "audio"
            ? source.audioAssetId : source.assetId;
        const primaryUrl = source.category === "audio" ? source.audioUrl : source.url;
        const primaryKind = source.category === "audio" ? "audio" : source.category;
        return {
            primary: this.resolveManagedSelection(primaryId, primaryUrl, primaryKind),
            artwork: source.stillAssetId
                ? this.resolveManagedSelection(source.stillAssetId, source.stillUrl, "image")
                : this.resolveManagedSelection(null, source.stillUrl, "image"),
            motion: source.motionAssetId
                ? this.resolveManagedSelection(source.motionAssetId, source.motionUrl, "video")
                : null
        };
    }

    resolveManagedSelection(assetId, runtimeUrl = null, kind = null) {
        if (assetId) return this.mediaLibraryManager?.getAsset(assetId) ||
            { id: assetId, originalName: `${assetId} · UNAVAILABLE`, kind,
                unavailable: true };
        if (!runtimeUrl || !kind) return null;
        return this.mediaLibraryManager?.listAssets({ kind }).find(
            (asset) => this.urlsMatch(asset.url, runtimeUrl)
        ) || null;
    }

    urlsMatch(left, right) {
        try {
            const base = globalThis.document?.baseURI;
            return new URL(left, base).href === new URL(right, base).href;
        }
        catch { return false; }
    }

    async handleFormClick(event) {
        const library = event.target.closest("[data-source-library]");
        if (library) {
            const slot = library.dataset.sourceLibrary;
            const kind = slot === "artwork" ? "image" : slot === "motion" ? "video"
                : this.form.elements.kind.value === "audio" ? "audio" : this.form.elements.kind.value;
            const asset = await this.mediaLibraryPicker?.choose({ kind,
                selectedId: this.selectedAssets[slot]?.id });
            if (asset) { this.selectedAssets[slot] = asset; this.renderSelections(); }
        }
        if (event.target.closest("[data-source-clear-artwork]")) {
            this.selectedAssets.artwork = null;
            this.form.elements.stillUrl.value = "";
            this.renderSelections();
        }
        if (event.target.closest("[data-source-clear-motion]")) {
            this.selectedAssets.motion = null;
            this.renderSelections();
        }
    }

    async handleFileChange(event) {
        const input = event.target.closest("[data-source-file]");
        const file = input?.files?.[0];
        if (!file) return;
        const previous = this.selectedAssets[input.dataset.sourceFile];
        try {
            this.setFeedback("Importing asset…");
            const asset = await this.mediaLibraryManager.importAsset(file);
            const expectedKind = input.dataset.sourceFile === "artwork" ? "image"
                : input.dataset.sourceFile === "motion" ? "video"
                : this.form.elements.kind.value === "audio" ? "audio"
                    : this.form.elements.kind.value;
            if (asset.kind !== expectedKind) throw new Error(`Select a ${expectedKind.toUpperCase()} file.`);
            this.selectedAssets[input.dataset.sourceFile] = asset;
            input.value = "";
            this.renderSelections();
            this.setFeedback("Asset imported. Press SAVE to update the Source.");
        }
        catch (error) {
            this.selectedAssets[input.dataset.sourceFile] = previous;
            this.setFeedback(error.message || "Asset import failed.", true);
        }
    }

    renderSelections() {
        ["primary", "artwork", "motion"].forEach((slot) => {
            const target = this.form.querySelector(`[data-source-selection="${slot}"]`);
            const asset = this.selectedAssets[slot];
            if (target) target.textContent = asset
                ? `${asset.originalName || asset.id} · ${(asset.kind || "asset").toUpperCase()} · SELECTED`
                : "NONE";
        });
    }

    handleClick(event) {
        const button = event.target.closest("button[data-source-action]");
        const source = this.sources.find((item) => item.id === button?.dataset.sourceId);
        if (!source) return;
        if (button.dataset.sourceAction === "edit") return this.openEditor(source);
        const result = this.catalog.removeSource(source.id);
        this.setFeedback(result.ok ? "Source removed." : this.messageFor(result.reason), !result.ok);
    }

    render(sources) {
        if (!this.started) return;
        this.sources = sources;
        const order = ["live", "video", "audio", "image"];
        const visibleCategories = this.activeCategory === "all"
            ? order
            : [this.activeCategory];
        const rows = [];
        visibleCategories.forEach((category) => {
            const categorySources = sources
                .filter((source) => source.category === category)
                .sort((a, b) => a.name.localeCompare(b.name));
            if (this.activeCategory === "all" && categorySources.length === 0) {
                return;
            }
            const heading = document.createElement("li");
            heading.className = `studio-source-group studio-source-group--${category}`;
            heading.textContent = category.toUpperCase();
            rows.push(heading);
            categorySources.forEach((source) => rows.push(this.createSourceRow(source)));
        });
        this.list.replaceChildren(...rows);
    }

    createSourceRow(source) {
            const row = document.createElement("li");
            row.className = "studio-source-item";
            const header = document.createElement("div");
            header.className = "studio-source-item__header";
            const name = document.createElement("strong");
            name.textContent = source.name;
            const badge = document.createElement("span");
            badge.className = `studio-source-item__origin studio-source-item__origin--${source.category}`;
            badge.textContent = source.category.toUpperCase();
            const endpoint = document.createElement("span");
            endpoint.className = "studio-source-item__url";
            endpoint.textContent = source.available === false
                ? `UNAVAILABLE · ${source.unavailableReason}`
                : source.category === "audio" ? source.audioUrl
                    : source.url || source.configRef || "NO ENDPOINT";
            row.classList.toggle("is-unavailable", source.available === false);
            endpoint.title = endpoint.textContent;
            const metadata = document.createElement("span");
            metadata.className = "studio-source-item__id";
            metadata.textContent = [
                `ID: ${source.id}`,
                source.origin === "operator" ? "USER" : "PROTECTED",
                `${source.sceneIds.length} SCENE${source.sceneIds.length === 1 ? "" : "S"}`
            ].join(" · ");
            header.append(name, badge);
            row.append(header, endpoint, metadata);
            if (source.removable) {
                const actions = document.createElement("details");
                actions.className = "studio-item-actions studio-source-item__actions";
                const summary = document.createElement("summary");
                summary.setAttribute("aria-label", `Manage ${source.name}`);
                summary.textContent = "⋯";
                const menu = document.createElement("div");
                menu.append(this.button("EDIT", "edit", source.id),
                    this.button("DELETE", "delete", source.id));
                actions.append(summary, menu);
                row.append(actions);
            }
            return row;
    }

    button(label, action, id) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.sourceAction = action;
        button.dataset.sourceId = id;
        return button;
    }

    setFeedback(message, error = false) {
        this.feedback.textContent = message;
        this.feedback.classList.toggle("is-error", error);
    }

    messageFor(reason) {
        return ({ "invalid-name": "Enter a valid source name.", "invalid-url": "Use an HTTP(S) or project-relative URL.", "invalid-still-url": "Use an HTTP(S) or project-relative artwork URL.", "invalid-kind": "Choose LIVE, VIDEO, AUDIO, or IMAGE.", "source-still-referenced": "Source is used by a scene.", "source-in-preview": "Source is currently in Preview.", "source-in-program": "Source is currently in Program.", "source-authorized": "Source is authorized for AUTO LIVE or an active runtime.", "source-has-active-instances": "Source is active in a renderer or monitor.", "persistence-failed": "Source registry could not be saved." })[reason] || "Source operation rejected.";
    }
}
