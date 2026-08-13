export default class StudioSlateSurface {

    constructor(definition) {
        this.definition = definition;
        this.element = null;
    }

    start(root) {
        const slate = document.createElement("div");
        const logo = document.createElement("img");
        const title = document.createElement("strong");
        const message = document.createElement("span");

        slate.className = "studio-render-slate";
        logo.className = "studio-render-slate__logo";
        logo.src = this.definition.renderer.logo;
        logo.alt = "";
        title.className = "studio-render-slate__title";
        title.textContent = this.definition.renderer.title;
        message.className = "studio-render-slate__message";
        message.textContent = this.definition.renderer.message;

        slate.append(logo, title, message);
        root.replaceChildren(slate);
        this.element = slate;
    }

    waitUntilReady() {
        return Promise.resolve();
    }

    destroy() {
        this.element?.remove();
        this.element = null;
    }
}
