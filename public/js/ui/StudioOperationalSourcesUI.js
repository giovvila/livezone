export default class StudioOperationalSourcesUI {
    constructor(root, catalog) {
        this.root = root;
        this.catalog = catalog;
        this.render = this.render.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.catalog) return false;
        this.list = this.root.querySelector("#studio-source-list");
        if (!this.list) return false;
        this.started = true;
        this.unsubscribe = this.catalog.subscribe(this.render);
        return true;
    }

    destroy() {
        if (!this.started) return;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.started = false;
    }

    render(sources) {
        if (!this.started) return;
        const rows = sources.filter((source) => source.enabled !== false).map((source) => {
            const row = document.createElement("li");
            const header = document.createElement("div");
            const name = document.createElement("strong");
            const kind = document.createElement("span");
            const scenes = document.createElement("span");
            row.className = "studio-source-item";
            header.className = "studio-source-item__header";
            name.textContent = source.name;
            kind.className = "studio-source-item__origin";
            kind.textContent = `${source.kind.toUpperCase()} · ${source.origin.toUpperCase()}`;
            scenes.className = "studio-source-item__asset";
            scenes.textContent = source.sceneIds.length
                ? `SCENES: ${source.sceneIds.join(", ")}` : "NO SCENE";
            header.append(name, kind);
            row.append(header, scenes);
            return row;
        });
        this.list.replaceChildren(...rows);
    }
}
