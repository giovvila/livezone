export default class StudioLiveSourcesUI {
    constructor(root, catalog, scheduleStore, dominantLiveConfig = null) {
        this.root = root;
        this.catalog = catalog;
        this.scheduleStore = scheduleStore;
        this.dominantLiveConfig = dominantLiveConfig;
        this.render = this.render.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleClick = this.handleClick.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.catalog) return false;
        this.form = this.root.querySelector("#live-source-form");
        this.list = this.root.querySelector("#live-source-list");
        this.feedback = this.root.querySelector("#live-source-feedback");
        this.cancel = this.root.querySelector("#live-source-cancel");
        if (!this.form || !this.list || !this.feedback || !this.cancel) return false;
        this.started = true;
        this.form.addEventListener("submit", this.handleSubmit);
        this.list.addEventListener("click", this.handleClick);
        this.cancel.addEventListener("click", () => this.reset());
        this.unsubscribe = this.catalog.subscribe(this.render);
        this.unsubscribeDominant = this.dominantLiveConfig?.subscribe?.(() =>
            this.render(this.catalog.getSources()));
        return true;
    }

    destroy() {
        if (!this.started) return;
        this.form.removeEventListener("submit", this.handleSubmit);
        this.list.removeEventListener("click", this.handleClick);
        this.unsubscribe?.();
        this.unsubscribeDominant?.();
        this.started = false;
    }

    handleSubmit(event) {
        event.preventDefault();
        const values = new FormData(this.form);
        const data = { name: String(values.get("name") || ""),
            url: String(values.get("url") || ""), enabled: values.get("enabled") === "on" };
        const wasEditing = Boolean(this.editingId);
        const result = this.editingId
            ? this.catalog.updateLiveSource(this.editingId, data)
            : this.catalog.addLiveSource(data);
        if (!result.ok) return this.show(`Operazione rifiutata: ${result.reason}.`, true);
        this.reset();
        this.show(wasEditing ? "Sorgente LIVE aggiornata." : "Sorgente LIVE aggiunta.", false);
    }

    handleClick(event) {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const source = this.catalog.getSources().find(({ id }) => id === button.dataset.id);
        if (!source || source.kind !== "hls" || source.origin !== "operator") return;
        if (button.dataset.action === "edit") {
            this.editingId = source.id;
            this.form.elements.name.value = source.name;
            this.form.elements.url.value = source.url || "";
            this.form.elements.enabled.checked = source.enabled !== false;
            this.cancel.hidden = false;
            return this.show(`Modifica ${source.name}.`, false);
        }
        if (button.dataset.action === "toggle") {
            const result = this.catalog.updateLiveSource(source.id, {
                name: source.name,
                url: source.url,
                enabled: source.enabled === false
            });
            if (result.ok && !result.source.enabled &&
                this.dominantLiveConfig?.getSnapshot?.().authorizedSourceId === source.id) {
                this.dominantLiveConfig.setAuthorizedSourceId(null);
            }
            return result.ok
                ? this.show(`Sorgente LIVE ${result.source.enabled ? "abilitata" : "disabilitata"}.`, false)
                : this.show(`Operazione rifiutata: ${result.reason}.`, true);
        }
        if (button.dataset.action === "authorize") {
            const authorized = this.dominantLiveConfig?.getSnapshot?.().authorizedSourceId;
            this.dominantLiveConfig?.setAuthorizedSourceId(
                authorized === source.id ? null : source.id
            );
            return this.show(authorized === source.id
                ? "AUTO INTERRUPT disattivato."
                : `${source.name} è l'unica sorgente AUTO INTERRUPT.`, false);
        }
        const sceneId = source.sceneIds[0];
        let referenced = false;
        const unsubscribe = this.scheduleStore?.subscribe?.(({ schedule }) => {
            referenced = schedule?.items?.some((item) => item.sceneId === sceneId) || false;
        });
        unsubscribe?.();
        if (referenced) return this.show("Rimozione bloccata: scena referenziata dal palinsesto.", true);
        const result = this.catalog.removeSource(source.id);
        if (!result.ok) return this.show(`Rimozione rifiutata: ${result.reason}.`, true);
        if (this.dominantLiveConfig?.getSnapshot?.().authorizedSourceId === source.id) {
            this.dominantLiveConfig.setAuthorizedSourceId(null);
        }
        this.reset();
        this.show("Sorgente LIVE rimossa.", false);
    }

    render(sources) {
        if (!this.started) return;
        const rows = sources.filter(({ kind, origin }) => kind === "hls" && origin === "operator")
            .map((source) => {
                const row = document.createElement("li");
                const name = document.createElement("strong");
                const state = document.createElement("span");
                const id = document.createElement("code");
                const endpoint = document.createElement("span");
                const actions = document.createElement("div");
                const edit = document.createElement("button");
                const toggle = document.createElement("button");
                const authorize = document.createElement("button");
                const remove = document.createElement("button");
                const isAuthorized = this.dominantLiveConfig?.getSnapshot?.()
                    .authorizedSourceId === source.id;
                row.className = "live-source-card";
                row.dataset.state = source.enabled ? "enabled" : "disabled";
                name.textContent = source.name;
                state.textContent = source.enabled ? "ENABLED" : "DISABLED";
                id.textContent = source.id;
                endpoint.textContent = source.url;
                edit.type = toggle.type = authorize.type = remove.type = "button";
                edit.textContent = "EDIT";
                toggle.textContent = source.enabled ? "DISABLE" : "ENABLE";
                authorize.textContent = `AUTO INTERRUPT: ${isAuthorized ? "ON" : "OFF"}`;
                remove.textContent = "REMOVE";
                edit.dataset.action = "edit";
                toggle.dataset.action = "toggle";
                authorize.dataset.action = "authorize";
                remove.dataset.action = "remove";
                edit.dataset.id = toggle.dataset.id = authorize.dataset.id = remove.dataset.id = source.id;
                edit.setAttribute("aria-label", `Edit ${source.name}`);
                toggle.setAttribute("aria-label",
                    `${source.enabled ? "Disable" : "Enable"} ${source.name}`);
                authorize.setAttribute("aria-pressed", String(isAuthorized));
                authorize.disabled = source.enabled === false;
                authorize.setAttribute("aria-label", `${isAuthorized ? "Disable" : "Enable"} AUTO INTERRUPT for ${source.name}`);
                remove.setAttribute("aria-label", `Remove ${source.name}`);
                actions.className = "live-source-card__actions";
                actions.append(edit, toggle, authorize, remove);
                row.append(name, state, id, endpoint, actions);
                return row;
            });
        this.list.replaceChildren(...rows);
    }

    reset() {
        this.editingId = null;
        this.form.reset();
        this.form.elements.enabled.checked = true;
        this.cancel.hidden = true;
    }

    show(message, error) {
        this.feedback.textContent = message;
        this.feedback.classList.toggle("is-error", error);
        return false;
    }
}
