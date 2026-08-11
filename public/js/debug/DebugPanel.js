import StateManager from "../core/StateManager.js";

export default class DebugPanel {

    constructor(container) {
        this.container = container;

        this.fields = {};
        this.player = null;
        this.timer = null;
        this.drag={active:false,x:0,y:0};
    }

    show() {
        this.container.classList.remove("hidden");
    }

    hide() {
        this.container.classList.add("hidden");
    }

    render() {
        this.container.innerHTML = `
            <div class="debug-title debug-header">
                LIVEZONE ENGINE
            </div>

            <div class="debug-body">
                <div class="debug-row">
                    <span class="debug-label">Engine</span>
                    <span id="dbg-engine" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Player</span>
                    <span id="dbg-player" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Playback</span>
                    <span id="dbg-playback" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Buffer</span>
                    <span id="dbg-buffer" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Resolution</span>
                    <span id="dbg-resolution" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Stream</span>
                    <span id="dbg-stream" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Ready</span>
                    <span id="dbg-ready" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Network</span>
                    <span id="dbg-network" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Muted</span>
                    <span id="dbg-muted" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Volume</span>
                    <span id="dbg-volume" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Audio</span>
                    <span id="dbg-audio" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Video</span>
                    <span id="dbg-video" class="debug-value">--</span>
                </div>

                <div class="debug-title">PRO DIAGNOSTICS</div>

                <div class="debug-row">
                    <span class="debug-label">Mode</span>
                    <span id="dbg-mode" class="debug-value">UNAVAILABLE</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Live Edge</span>
                    <span id="dbg-live-edge" class="debug-value">UNAVAILABLE</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Dropped Frames</span>
                    <span id="dbg-dropped-frames" class="debug-value">UNAVAILABLE</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">HLS BW</span>
                    <span id="dbg-hls-bandwidth" class="debug-value">UNAVAILABLE</span>
                </div>
            </div>
        `;

        this.fields.engine = this.container.querySelector("#dbg-engine");
        this.fields.player = this.container.querySelector("#dbg-player");
        this.fields.playback = this.container.querySelector("#dbg-playback");
        this.fields.buffer = this.container.querySelector("#dbg-buffer");
        this.fields.resolution = this.container.querySelector("#dbg-resolution");
        this.fields.stream = this.container.querySelector("#dbg-stream");
        this.fields.ready = this.container.querySelector("#dbg-ready");
        this.fields.network = this.container.querySelector("#dbg-network");
        this.fields.muted = this.container.querySelector("#dbg-muted");
        this.fields.volume = this.container.querySelector("#dbg-volume");
        this.fields.audio = this.container.querySelector("#dbg-audio");
        this.fields.video = this.container.querySelector("#dbg-video");
        this.fields.mode = this.container.querySelector("#dbg-mode");
        this.fields.liveEdge = this.container.querySelector("#dbg-live-edge");
        this.fields.droppedFrames = this.container.querySelector("#dbg-dropped-frames");
        this.fields.hlsBandwidth = this.container.querySelector("#dbg-hls-bandwidth");

        const monitorToggle = document.getElementById("engine-monitor-toggle");

        monitorToggle?.addEventListener("click", () => {
            this.container.classList.toggle("hidden");
        });

        window.addEventListener("keydown", (e) => {
            if (
                e.key === "F2" &&
                !window.matchMedia("(pointer: coarse)").matches
            ) {
                e.preventDefault();
                this.container.classList.toggle("hidden");
            }
        });

        this.enableDrag();

    }


    enableDrag() {
        const header=this.container.querySelector(".debug-header");
        if(!header) return;
        const key="engineMonitor.position";
        try{
          const p=JSON.parse(localStorage.getItem(key)||"null");
          if(p){this.container.style.position="fixed";this.container.style.left=p.left+"px";this.container.style.top=p.top+"px";this.container.style.right="auto";this.container.style.bottom="auto";}
        }catch{}
        header.style.cursor="move";
        header.addEventListener("mousedown",(e)=>{
          this.drag.active=true;
          const r=this.container.getBoundingClientRect();
          this.drag.x=e.clientX-r.left; this.drag.y=e.clientY-r.top;
          e.preventDefault();
        });
        document.addEventListener("mousemove",(e)=>{
          if(!this.drag.active) return;
          const w=this.container.offsetWidth,h=this.container.offsetHeight;
          let l=Math.max(0,Math.min(window.innerWidth-w,e.clientX-this.drag.x));
          let t=Math.max(0,Math.min(window.innerHeight-h,e.clientY-this.drag.y));
          this.container.style.position="fixed";this.container.style.left=l+"px";this.container.style.top=t+"px";this.container.style.right="auto";this.container.style.bottom="auto";
        });
        document.addEventListener("mouseup",()=>{
          if(!this.drag.active) return;
          this.drag.active=false;
          localStorage.setItem(key,JSON.stringify({left:parseInt(this.container.style.left)||0,top:parseInt(this.container.style.top)||0}));
        });
    }

    attach(player) {
        if (!player || typeof player.getHealth !== "function") {
            throw new Error("DebugPanel.attach(): Player non valido.");
        }

        this.detach();
        this.player = player;

        // First update immediately; subsequent updates are live polling.
        this.refresh();
        this.timer = setInterval(() => this.refresh(), 500);
    }

    detach() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.player = null;
    }

    refresh() {
        if (!this.player) {
            return;
        }

        const health = this.player.getHealth();

        if (!health) {
            return;
        }

        let playerState = "PLAYING";

        if (health.ended) {
            playerState = "ENDED";
        }
        else if (health.readyState < 3 && !health.paused) {
            playerState = "BUFFERING";
        }
        else if (health.paused) {
            playerState = "PAUSED";
        }

        this.update({
            engine: this.valueOrUnavailable(StateManager.getState()),
            player: this.valueOrUnavailable(this.player.getState?.()),
            playback: playerState,
            buffer: this.formatBuffer(health.buffer),
            resolution: this.formatResolution(
                health.videoWidth,
                health.videoHeight
            ),
            stream: this.formatStreamType(health.streamDiagnostics?.type),
            ready: this.formatMediaState(
                health.readyState,
                DebugPanel.READY_STATES
            ),
            network: this.formatMediaState(
                health.networkState,
                DebugPanel.NETWORK_STATES
            ),
            muted: this.formatBoolean(health.muted, "YES", "NO"),
            volume: this.formatVolume(health.volume),
            audio: this.formatBoolean(health.hasAudio, "PRESENT", "ABSENT"),
            video: this.formatBoolean(health.hasVideo, "PRESENT", "ABSENT"),
            mode: this.formatProMode(health.proDiagnostics?.mode),
            liveEdge: this.formatLiveEdge(health.proDiagnostics?.liveEdge),
            droppedFrames: this.formatDroppedFrames(
                health.proDiagnostics?.videoFrames
            ),
            hlsBandwidth: this.formatHlsBandwidth(
                health.proDiagnostics?.hlsBandwidth
            )
        });
    }

    valueOrUnavailable(value) {
        return value === undefined || value === null || value === ""
            ? "--"
            : value;
    }

    formatBuffer(buffer) {
        return typeof buffer === "number" && Number.isFinite(buffer)
            ? `${buffer.toFixed(2)} s`
            : "--";
    }

    formatResolution(width, height) {
        return typeof width === "number" && width > 0 &&
            typeof height === "number" && height > 0
            ? `${width}×${height}`
            : "--";
    }

    formatBoolean(value, trueLabel, falseLabel) {
        if (typeof value !== "boolean") {
            return "--";
        }

        return value ? trueLabel : falseLabel;
    }

    formatVolume(volume) {
        return typeof volume === "number" && Number.isFinite(volume)
            ? `${Math.round(volume * 100)}%`
            : "--";
    }

    formatStreamType(type) {
        return ["LIVE", "VOD", "EVENT", "UNKNOWN"].includes(type)
            ? type
            : "UNKNOWN";
    }

    formatProMode(mode) {
        const modes={
            HLS_JS:"HLS.JS",
            NATIVE_HLS:"NATIVE HLS"
        };

        return modes[mode] || "UNAVAILABLE";
    }

    formatLiveEdge(liveEdge) {
        if(!liveEdge?.available ||
            !Number.isFinite(liveEdge.distanceSeconds)){
            return "UNAVAILABLE";
        }

        return `${liveEdge.distanceSeconds.toFixed(1)} s behind`;
    }

    formatDroppedFrames(videoFrames) {
        if(!videoFrames?.available ||
            !Number.isFinite(videoFrames.droppedVideoFrames) ||
            !Number.isFinite(videoFrames.totalVideoFrames)){
            return "UNAVAILABLE";
        }

        const dropped=videoFrames.droppedVideoFrames;
        const total=videoFrames.totalVideoFrames;
        const percentage=total>0 ? (dropped/total)*100 : 0;

        return `${dropped.toLocaleString("en-US")} / `+
            `${total.toLocaleString("en-US")} (${percentage.toFixed(2)}%)`;
    }

    formatHlsBandwidth(hlsBandwidth) {
        if(!hlsBandwidth?.available ||
            !Number.isFinite(hlsBandwidth.bitsPerSecond) ||
            hlsBandwidth.bitsPerSecond<=0){
            return "UNAVAILABLE";
        }

        const bitsPerSecond=hlsBandwidth.bitsPerSecond;

        return bitsPerSecond>=1000000
            ? `${(bitsPerSecond/1000000).toFixed(2)} Mbps`
            : `${Math.round(bitsPerSecond/1000)} Kbps`;
    }

    formatMediaState(value, states) {
        return typeof value === "number" && states[value] !== undefined
            ? `${states[value]} (${value})`
            : "--";
    }

    update(data) {
        if (data.engine !== undefined && this.fields.engine) {
            this.fields.engine.textContent = data.engine;
        }

        if (data.player !== undefined && this.fields.player) {
            this.fields.player.textContent = data.player;
        }

        if (data.playback !== undefined && this.fields.playback) {
            this.fields.playback.textContent = data.playback;
        }

        if (data.buffer !== undefined && this.fields.buffer) {
            this.fields.buffer.textContent = data.buffer;
        }

        if (data.resolution !== undefined && this.fields.resolution) {
            this.fields.resolution.textContent = data.resolution;
        }

        if (data.stream !== undefined && this.fields.stream) {
            this.fields.stream.textContent = data.stream;
        }

        if (data.ready !== undefined && this.fields.ready) {
            this.fields.ready.textContent = data.ready;
        }

        if (data.network !== undefined && this.fields.network) {
            this.fields.network.textContent = data.network;
        }

        if (data.muted !== undefined && this.fields.muted) {
            this.fields.muted.textContent = data.muted;
        }

        if (data.volume !== undefined && this.fields.volume) {
            this.fields.volume.textContent = data.volume;
        }

        if (data.audio !== undefined && this.fields.audio) {
            this.fields.audio.textContent = data.audio;
        }

        if (data.video !== undefined && this.fields.video) {
            this.fields.video.textContent = data.video;
        }

        if (data.mode !== undefined && this.fields.mode) {
            this.fields.mode.textContent = data.mode;
        }

        if (data.liveEdge !== undefined && this.fields.liveEdge) {
            this.fields.liveEdge.textContent = data.liveEdge;
        }

        if (data.droppedFrames !== undefined && this.fields.droppedFrames) {
            this.fields.droppedFrames.textContent = data.droppedFrames;
        }

        if (data.hlsBandwidth !== undefined && this.fields.hlsBandwidth) {
            this.fields.hlsBandwidth.textContent = data.hlsBandwidth;
        }
    }
}

DebugPanel.READY_STATES = Object.freeze({
    0: "HAVE_NOTHING",
    1: "HAVE_METADATA",
    2: "HAVE_CURRENT_DATA",
    3: "HAVE_FUTURE_DATA",
    4: "HAVE_ENOUGH_DATA"
});

DebugPanel.NETWORK_STATES = Object.freeze({
    0: "EMPTY",
    1: "IDLE",
    2: "LOADING",
    3: "NO_SOURCE"
});
