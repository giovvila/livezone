export default class Player {

    constructor() {
        this.video = document.getElementById("video");
    }

    async init() {

        if (!this.video) {
            throw new Error("Elemento video non trovato");
        }

        const stream =
            "https://65f16f0fdfc51.streamlock.net/xibilive/livestream/playlist.m3u8";

        if (window.Hls && Hls.isSupported()) {

            const hls = new Hls();

            hls.loadSource(stream);

            hls.attachMedia(this.video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {

                console.log("STREAM READY");

                this.video.play();

            });

            hls.on(Hls.Events.ERROR, (event, data) => {

                console.error("HLS ERROR", data);

            });

        }
        else if (this.video.canPlayType("application/vnd.apple.mpegurl")) {

            this.video.src = stream;

            this.video.play();

        }
        else {

            console.error("Browser non compatibile con HLS");

        }

    }

}