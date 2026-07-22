export default class AdaptivePlayer {

    constructor(playerWrapper, video){

        this.wrapper = playerWrapper;
        this.video = video;

        this.resize = this.resize.bind(this);

    }

    start(){

        window.addEventListener("resize", this.resize);

        this.resize();

    }

    stop(){

        window.removeEventListener("resize", this.resize);

    }

    resize(){

        const area = this.wrapper.parentElement;

        if(!area) return;

        const availableWidth = area.clientWidth;

        const availableHeight = area.clientHeight;

        const ratio = 16 / 9;

        let width = availableWidth;
        let height = width / ratio;

        if(height > availableHeight){

            height = availableHeight;
            width = height * ratio;

        }

        this.wrapper.style.width = `${width}px`;
        this.wrapper.style.height = `${height}px`;

    }

}