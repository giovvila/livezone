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
                    <span class="debug-label">Buffer</span>
                    <span id="dbg-buffer" class="debug-value">--</span>
                </div>

                <div class="debug-row">
                    <span class="debug-label">Resolution</span>
                    <span id="dbg-resolution" class="debug-value">--</span>
                </div>
            </div>
        `;

        this.fields.engine = this.container.querySelector("#dbg-engine");
        this.fields.player = this.container.querySelector("#dbg-player");
        this.fields.buffer = this.container.querySelector("#dbg-buffer");
        this.fields.resolution = this.container.querySelector("#dbg-resolution");

        const header = this.container.querySelector(".debug-header");
        const open = localStorage.getItem("engineInspector.open");

        if (open === "false") {
            this.container.classList.add("collapsed");
        }

        header?.addEventListener("click", () => {
            if (this.drag.active) return;
            this.toggle();
        });

        window.addEventListener("keydown", (e) => {
            if (e.key === "F2") {
                e.preventDefault();
                this.container.classList.toggle("hidden");
            }
        });


        // Mobile floating button (touch devices only)
        if (window.matchMedia("(pointer: coarse)").matches && !document.getElementById("engine-monitor-toggle")) {
            const btn=document.createElement("button");
            btn.id="engine-monitor-toggle";
            btn.textContent="MON";
            Object.assign(btn.style,{
                position:"fixed",right:"16px",bottom:"16px",zIndex:"99999",
                padding:"10px 14px",borderRadius:"20px",border:"0",
                background:"#d60000",color:"#fff",fontWeight:"700",cursor:"pointer"
            });
            btn.addEventListener("click",()=>this.container.classList.toggle("hidden"));
            document.body.appendChild(btn);
        }

        this.enableDrag();

    }

    toggle() {
        this.container.classList.toggle("collapsed");
        localStorage.setItem(
            "engineInspector.open",
            (!this.container.classList.contains("collapsed")).toString()
        );
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
            engine: "ONLINE",
            player: playerState,
            buffer: `${Number(health.buffer || 0).toFixed(2)} s`,
            resolution: `${health.videoWidth || 0}×${health.videoHeight || 0}`
        });
    }

    update(data) {
        if (data.engine !== undefined && this.fields.engine) {
            this.fields.engine.textContent = data.engine;
        }

        if (data.player !== undefined && this.fields.player) {
            this.fields.player.textContent = data.player;
        }

        if (data.buffer !== undefined && this.fields.buffer) {
            this.fields.buffer.textContent = data.buffer;
        }

        if (data.resolution !== undefined && this.fields.resolution) {
            this.fields.resolution.textContent = data.resolution;
        }
    }
}
