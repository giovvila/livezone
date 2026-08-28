export default class StudioOperationalSourcesUI {
    constructor(root, catalog) {
        this.root = root;
        this.catalog = catalog;
        this.editingId = null;
        this.activeCategory = "all";
        this.render = this.render.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleClick = this.handleClick.bind(this);
        this.handleCategoryClick = this.handleCategoryClick.bind(this);
        this.handleAddClick = this.handleAddClick.bind(this);
        this.handleKindChange = this.handleKindChange.bind(this);
        this.handleCancelClick = this.handleCancelClick.bind(this);
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
        form.innerHTML = `<label>TYPE<select name="kind" required><option value="live">LIVE · HLS</option><option value="video">VIDEO</option><option value="audio">AUDIO</option><option value="image">IMAGE</option></select></label><label>NAME<input name="name" maxlength="120" required></label><label><span data-source-url-label>SOURCE URL / MEDIA URL</span><input name="url" maxlength="4096" required></label><label data-source-artwork hidden>ARTWORK / IMAGE URL (optional)<input name="stillUrl" maxlength="4096"></label><div class="studio-operational-source-form__actions"><button type="submit">SAVE</button><button type="button" data-source-cancel>CANCEL</button></div>`;
        form.elements.kind.addEventListener("change", this.handleKindChange);
        this.cancelButton = form.querySelector("[data-source-cancel]");
        this.cancelButton.addEventListener("click", this.handleCancelClick);
        return form;
    }

    openEditor(source = null) {
        this.editingId = source?.id || null;
        this.form.reset();
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
        const audio = this.form.elements.kind.value === "audio";
        this.form.querySelector("[data-source-url-label]").textContent = audio
            ? "AUDIO URL"
            : "SOURCE URL / MEDIA URL";
        this.form.querySelector("[data-source-artwork]").hidden = !audio;
        if (!audio) this.form.elements.stillUrl.value = "";
    }

    handleSubmit(event) {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(this.form));
        const result = this.editingId
            ? this.catalog.updateSource(this.editingId, data)
            : this.catalog.addSource(data);
        if (!result.ok) return this.setFeedback(this.messageFor(result.reason), true);
        this.setFeedback(this.editingId ? "Source updated." : "Source created.");
        this.editingId = null;
        this.form.hidden = true;
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
            endpoint.textContent = source.category === "audio"
                ? source.audioUrl
                : source.url || source.configRef || "NO ENDPOINT";
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
