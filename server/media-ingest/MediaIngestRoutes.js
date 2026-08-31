export default class MediaIngestRoutes {
    constructor({ statusClient } = {}) {
        if (!statusClient?.getStatus) throw new TypeError("MediaIngestRoutes requires status client.");
        this.statusClient = statusClient;
    }

    async handle(request, response, url) {
        if (url.pathname !== "/api/media-ingest/status") return false;
        if (request.method !== "GET") {
            response.writeHead(405, { "Content-Type": "application/json; charset=utf-8",
                "Allow": "GET", "Cache-Control": "no-store" });
            response.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
            return true;
        }
        const status = await this.statusClient.getStatus();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store" });
        response.end(JSON.stringify(status));
        return true;
    }
}
