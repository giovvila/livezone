export default class Player {

    constructor(config) {

        this.config = config;
        this.video = document.getElementById("video");

    }

    async init() {

        if (!this.video) {
            throw new Error("Elemento video non trovato");
        }

        const stream = this.config.stream.primary;

        console.log("Stream:", stream);

        if (window.Hls && Hls.isSupported()) {

            const hls = new Hls();

            hls.loadSource(stream);

            hls.attachMedia(this.video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {

                console.log("STREAM READY");

                this.video.play().catch(() => {});

            });

            hls.on(Hls.Events.ERROR, (event, data) => {

                console.error("HLS ERROR", data);

            });

        } else if (this.video.canPlayType("application/vnd.apple.mpegurl")) {

            this.video.src = stream;

            this.video.play().catch(() => {});

        } else {

            console.error("Browser non compatibile con HLS");

        }

    }

}