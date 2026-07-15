/**
 * LIVEZONE Broadcast Suite
 * HLSAdapter v1.0
 *
 * Gestisce esclusivamente la riproduzione HLS.
 * Player.js non deve conoscere Hls.js.
 */

export default class HLSAdapter {

    constructor() {

        this.hls = null;
        this.video = null;
        this.url = null;

        this.state = "IDLE";

    }

    async connect(video, url) {

        this.video = video;
        this.url = url;

        this.state = "CONNECTING";

        // Safari
        if (!window.Hls || !Hls.isSupported()) {

            if (video.canPlayType("application/vnd.apple.mpegurl")) {

                video.src = url;

                await video.play().catch(() => {});

                this.state = "CONNECTED";

                return true;

            }

            this.state = "ERROR";

            throw new Error("HLS non supportato.");

        }

        // Elimina eventuale istanza precedente
        this.destroy();

        this.state = "CONNECTING";

        this.hls = new Hls({

            enableWorker: true,

            lowLatencyMode: true,

            backBufferLength: 90

        });

        this.hls.loadSource(url);

        this.hls.attachMedia(video);

        return new Promise((resolve, reject) => {

            this.hls.on(Hls.Events.MANIFEST_PARSED, async () => {

                try {

                    await video.play();

                    this.state = "CONNECTED";

                    console.log("HLS CONNECTED");

                    resolve(true);

                }
                catch (error) {

                    this.state = "ERROR";

                    reject(error);

                }

            });

            this.hls.on(Hls.Events.ERROR, (event, data) => {

                console.error("HLS ERROR", data);

                this.state = "ERROR";

                reject(data);

            });

        });

    }

    disconnect() {

        if (this.video) {

            this.video.pause();

            this.video.removeAttribute("src");

            this.video.load();

        }

        this.destroy();

    }

    destroy() {

        if (this.hls) {

            this.hls.destroy();

            this.hls = null;

        }

        if (this.state !== "ERROR") {

            this.state = "DESTROYED";

        }

    }

    isConnected() {

        return this.state === "CONNECTED";

    }

    getState() {

        return this.state;

    }

}