export default class AdaptivePlayer {

    constructor(playerWrapper, video){

        this.wrapper = playerWrapper;
        this.video = video;

        this.resize = this.resize.bind(this);

        this.resizeObserver = null;
        this.started = false;
        this.lastWidth = null;
        this.lastHeight = null;

    }

    start(){

        if(this.started) return;

        this.started = true;

        window.addEventListener("resize", this.resize);

        const area = this.wrapper.parentElement;

        if(area && typeof ResizeObserver === "function"){

            this.resizeObserver = new ResizeObserver(this.resize);
            this.resizeObserver.observe(area);

        }

        this.resize();

    }

    stop(){

        window.removeEventListener("resize", this.resize);

        if(this.resizeObserver){

            this.resizeObserver.disconnect();
            this.resizeObserver = null;

        }

        this.started = false;
        this.lastWidth = null;
        this.lastHeight = null;

    }

    resize(){

        const area = this.wrapper.parentElement;

        if(!area) return;

        const style = window.getComputedStyle(area);

        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingRight = parseFloat(style.paddingRight) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const paddingBottom = parseFloat(style.paddingBottom) || 0;

        const contentWidth = Math.max(
            0,
            area.clientWidth - paddingLeft - paddingRight
        );

        const contentHeight = Math.max(
            0,
            area.clientHeight - paddingTop - paddingBottom
        );

        const ratio = 16 / 9;

        const width = Math.min(contentWidth, contentHeight * ratio);
        const height = width / ratio;

        if(width === this.lastWidth && height === this.lastHeight) return;

        this.wrapper.style.width = `${width}px`;
        this.wrapper.style.height = `${height}px`;

        this.lastWidth = width;
        this.lastHeight = height;

        document.documentElement.style.setProperty(
    "--player-width",
    `${width}px`
);

       document.documentElement.style.setProperty(
    "--player-height",
    `${height}px`
);

    }

}