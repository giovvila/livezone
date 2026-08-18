export default class StudioSourcesUI {

    constructor(root, studioCatalogManager) {
        this.root = root;
        this.catalog = studioCatalogManager;
        this.started = false;
        this.sources = [];
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleListClick = this.handleListClick.bind(this);
        this.render = this.render.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.catalog) {
            return false;
        }

        this.form = this.root.querySelector("#studio-source-form");
        this.nameInput = this.root.querySelector("#studio-source-name");
        this.urlInput = this.root.querySelector("#studio-source-url");
        this.list = this.root.querySelector("#studio-source-list");
        this.feedback = this.root.querySelector("#studio-source-feedback");

        if (!this.form || !this.nameInput || !this.urlInput || !this.list ||
            !this.feedback || typeof this.catalog.subscribe !== "function") {
            return false;
        }

        this.form.addEventListener("submit", this.handleSubmit);
        this.list.addEventListener("click", this.handleListClick);
        this.started = true;
        this.unsubscribe = this.catalog.subscribe(this.render);
        return true;
    }

    destroy() {
        if (!this.started) {
            return;
        }
        this.form.removeEventListener("submit", this.handleSubmit);
        this.list.removeEventListener("click", this.handleListClick);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.started = false;
    }

    handleSubmit(event) {
        event.preventDefault();
        const result = this.catalog.addMedia({
            name: this.nameInput.value,
            url: this.urlInput.value
        });

        if (!result.ok) {
            this.setFeedback(this.messageFor(result.reason), true);
            return;
        }

        this.form.reset();
        this.setFeedback(`Added ${result.source.name}.`, false);
        this.nameInput.focus();
    }

    handleListClick(event) {
        const button = event.target.closest("[data-remove-source-id]");
        if (!button || !this.list.contains(button)) {
            return;
        }

        const result = this.catalog.removeMedia(button.dataset.removeSourceId);
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
        const remove = document.createElement("button");

        item.className = "studio-source-item";
        header.className = "studio-source-item__header";
        name.textContent = source.name;
        badge.className = "studio-source-item__origin";
        badge.textContent = source.origin === "base" ? "BASE" : "LOCAL";
        id.className = "studio-source-item__id";
        id.textContent = source.id;
        url.className = "studio-source-item__url";
        url.textContent = source.url;
        url.title = source.url;
        remove.type = "button";
        remove.className = "studio-source-item__remove";
        remove.textContent = source.removable ? "REMOVE" : "PROTECTED";
        remove.disabled = !source.removable;
        if (source.removable) {
            remove.dataset.removeSourceId = source.id;
            remove.setAttribute("aria-label", `Remove ${source.name}`);
        }

        header.append(name, badge);
        item.append(header, id, url, remove);
        return item;
    }

    setFeedback(message, isError) {
        this.feedback.textContent = message;
        this.feedback.classList.toggle("is-error", isError);
    }

    messageFor(reason) {
        const messages = {
            "invalid-name": "Enter a valid media name.",
            "invalid-url": "Enter a valid HTTP(S) URL or relative path.",
            "base-source-protected": "Base media cannot be removed.",
            "scene-on-air": "Remove rejected: media is in Preview or Program.",
            "scene-in-transition": "Remove rejected: a transition is active.",
            "source-still-referenced": "Remove rejected: media is still referenced.",
            "source-has-active-instances": "Remove rejected: media is still active.",
            "persistence-failed": "The local media catalog could not be saved."
        };
        return messages[reason] || "The media catalog operation was rejected.";
    }
}
