import StudioLowerThirdGraphic from "./StudioLowerThirdGraphic.js";

export default class StudioGraphicsLayer {

    constructor({ root, consumer, graphicsManager }) {
        this.root = root;
        this.consumer = consumer;
        this.graphicsManager = graphicsManager;
        this.started = false;
        this.render = this.render.bind(this);
    }

    start() {
        if (this.started || !this.root) {
            return;
        }

        this.unsubscribe = this.graphicsManager.subscribe(
            this.consumer,
            this.render
        );
        this.started = true;
        this.render();
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.unsubscribe?.();
        this.unsubscribe = null;
        this.root.replaceChildren();
        this.started = false;
    }

    render() {
        const elements = this.graphicsManager
            .getVisibleGraphics(this.consumer)
            .map(({ graphic, payload }) =>
                this.createGraphicElement(graphic, payload)
            )
            .filter(Boolean);

        this.root.replaceChildren(...elements);
    }

    createGraphicElement(graphic, payload) {
        if (graphic.kind === "lower-third") {
            return StudioLowerThirdGraphic.create(graphic, payload);
        }

        if (graphic.kind === "image") {
            const image = document.createElement("img");
            const asset = payload?.asset || graphic.asset;
            const position = payload?.position || graphic.position;

            image.className = [
                "studio-graphic",
                "studio-graphic--image",
                `studio-graphic--${position}`
            ].join(" ");
            image.src = asset;
            image.alt = "";
            image.dataset.studioGraphicId = graphic.id;
            return image;
        }

        return null;
    }
}
