import {TextCrawlView} from './TextCrawlElement.js';
import SponsorView from './SponsorView.js';
import StudioLowerThirdGraphic from "./StudioLowerThirdGraphic.js";

export default class StudioGraphicsLayer {

    constructor({ root, consumer, graphicsManager }) {
        this.root = root;
        this.consumer = consumer;
        this.graphicsManager = graphicsManager;
        this.started = false;
        this.crawlView = new TextCrawlView();
        this.sponsorView = new SponsorView();
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
        this.crawlView.destroy();
        this.sponsorView.destroy();
        this.root.replaceChildren();
        this.started = false;
    }

    render() {
        const elements = this.graphicsManager
            .getVisibleGraphics(this.consumer)
            .filter(({ graphic }) => !(this.consumer === "program" && this.effectiveCrawl !== undefined && graphic.kind === "text-crawl"))
            .map(({ graphic, payload }) =>
                this.createGraphicElement(graphic, payload)
            )
            .filter(Boolean);

        if (this.consumer === "program" && this.effectiveCrawl !== undefined) {
            const crawl = this.crawlView.node(this.effectiveCrawl);
            if (crawl) elements.push(crawl);
        }
        if (this.root.dataset) this.root.dataset.scheduledCrawlPosition = this.effectiveCrawl?.enabled && this.effectiveCrawl?.scheduled ? this.effectiveCrawl.position : "";
        if (this.consumer === 'program') {
            const sponsor=this.sponsorView.node(this.effectiveSponsor);
            if(sponsor)elements.push(sponsor);
        }
        for (const child of [...this.root.children]) if (!elements.includes(child)) child.remove();
        for (const element of elements) if(element.parentNode!==this.root)this.root.appendChild(element);
    }

    setEffectiveCrawl(item) {
        this.effectiveCrawl = item || null;
        this.render();
    }

    setEffectiveOverlays(overlays={}) {
        this.effectiveCrawl=overlays.textCrawl||null;
        this.effectiveSponsor=overlays.sponsor||null;
        this.render();
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

        if (graphic.kind === "text-crawl" && payload?.enabled) {
            const overlay = this.crawlView.node(payload);
            if (overlay) overlay.dataset.studioGraphicId = graphic.id;
            return overlay;
        }

        return null;
    }
}
