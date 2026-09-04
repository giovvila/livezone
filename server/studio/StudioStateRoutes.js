const MAX_BODY_BYTES = 256 * 1024;
const KEEPALIVE_MS = 15000;

export default class StudioStateRoutes {
    constructor({ coordinator } = {}) {
        if (!coordinator) throw new TypeError("StudioStateRoutes requires a coordinator.");
        this.coordinator = coordinator;
        this.clients = new Set();
        this.unsubscribe = coordinator.subscribe((event) => this.broadcast(event));
    }

    async handle(request, response, url) {
        if (url.pathname === "/api/studio/state" && request.method === "GET") {
            const state = this.coordinator.getSnapshot();
            if (!state) return sendError(response, 503, "STATE_UNAVAILABLE");
            sendJson(response, 200, { ok: true, state }, { ETag: etag(state.revision) });
            return true;
        }
        if (url.pathname === "/api/studio/state/initialize" && request.method === "POST") {
            if (!String(request.headers["content-type"] || "").toLowerCase()
                .startsWith("application/json")) {
                sendError(response, 415, "CONTENT_TYPE_REQUIRED"); return true;
            }
            let payload;
            try { payload = JSON.parse(await readBody(request)); }
            catch (error) { sendError(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400,
                error?.code || "INVALID_JSON"); return true; }
            try {
                const state = await this.coordinator.initializeState(payload);
                sendJson(response, 201, { ok: true, state }, { ETag: etag(state.revision) });
            }
            catch (error) {
                const status = error?.code === "STATE_ALREADY_INITIALIZED" ? 409
                    : error?.code === "INVALID_STATE" ? 422 : 503;
                sendError(response, status, error?.code || "STATE_INITIALIZATION_FAILED");
            }
            return true;
        }
        if (url.pathname === "/api/studio/state/events" && request.method === "GET") {
            this.handleEvents(request, response); return true;
        }
        return false;
    }

    handleEvents(request, response) {
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform", Connection: "keep-alive",
            "X-Accel-Buffering": "no" });
        response.write("retry: 3000\n\n");
        const snapshot = this.coordinator.getSnapshot();
        if (snapshot) response.write(formatEvent({ type: "current",
            revision: snapshot.revision, changedDomains: [] }));
        this.clients.add(response);
        const keepalive = setInterval(() => response.write(": keepalive\n\n"), KEEPALIVE_MS);
        keepalive.unref?.();
        let cleaned = false;
        const cleanup = () => { if (cleaned) return; cleaned = true;
            clearInterval(keepalive); this.clients.delete(response); };
        request.on("aborted", cleanup); response.on("close", cleanup); response.on("error", cleanup);
    }

    broadcast(event) { const serialized = formatEvent(event); this.clients.forEach((response) => {
        if (response.destroyed || response.writableEnded) return this.clients.delete(response);
        try { response.write(serialized); } catch { this.clients.delete(response); }
    }); }
    close() { this.unsubscribe(); this.clients.forEach((response) => response.end()); this.clients.clear(); }
}

function etag(revision) { return `"studio-${revision}"`; }
function formatEvent(event) { return `id: ${event.revision}\nevent: studio-state\ndata: ${JSON.stringify(event)}\n\n`; }
function sendError(response, status, code) { sendJson(response, status,
    { ok: false, error: { code, message: messageFor(code) } }); }
function messageFor(code) { return ({ STATE_UNAVAILABLE: "Studio state is unavailable.",
    STATE_ALREADY_INITIALIZED: "Studio state is already initialized.",
    INVALID_STATE: "Studio state is invalid.", INVALID_JSON: "Request JSON is invalid.",
    PAYLOAD_TOO_LARGE: "Request payload is too large.",
    CONTENT_TYPE_REQUIRED: "Application JSON content is required.",
    STATE_PERSISTENCE_FAILED: "Studio state could not be persisted." })[code] ||
    "Studio state request failed."; }
function sendJson(response, status, payload, headers = {}) { response.writeHead(status,
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    response.end(JSON.stringify(payload)); }
function readBody(request) { return new Promise((resolve, reject) => { const chunks = [];
    let size = 0; let settled = false; request.on("data", (chunk) => { if (settled) return;
        size += chunk.length; if (size > MAX_BODY_BYTES) { settled = true;
            reject(Object.assign(new Error("payload-too-large"), { code: "PAYLOAD_TOO_LARGE" }));
            request.resume(); return; } chunks.push(chunk); });
    request.on("end", () => { if (!settled) resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", (error) => { if (!settled) reject(error); }); }); }
