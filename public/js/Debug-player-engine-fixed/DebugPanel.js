export default class DebugPanel {

    constructor(container) {

        this.container = container;

        this.fields = {};

    }

    show() {

        this.container.classList.remove("hidden");

    }

    hide() {

        this.container.classList.add("hidden");

    }

    render() {

        this.container.innerHTML = `

            <div class="debug-title">
                LIVEZONE ENGINE
            </div>

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

        `;

        this.fields.engine =
            this.container.querySelector("#dbg-engine");

        this.fields.player =
            this.container.querySelector("#dbg-player");

        this.fields.buffer =
            this.container.querySelector("#dbg-buffer");

        this.fields.resolution =
            this.container.querySelector("#dbg-resolution");

    }

    update(data) {

        if (data.engine !== undefined) {
            this.fields.engine.textContent = data.engine;
        }

        if (data.player !== undefined) {
            this.fields.player.textContent = data.player;
        }

        if (data.buffer !== undefined) {
            this.fields.buffer.textContent = data.buffer;
        }

        if (data.resolution !== undefined) {
            this.fields.resolution.textContent = data.resolution;
        }

    }

}