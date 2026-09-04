import { applyOperatorHeaders, handleOperatorAuthFailure,
    operatorFetch, requireSameOrigin } from "../auth/OperatorSessionClient.js";

export default class MediaLibraryClient {
    constructor({ baseUrl = "/api/media-library/assets", xhrFactory = () => new XMLHttpRequest() } = {}) {
        this.baseUrl = baseUrl;
        this.xhrFactory = xhrFactory;
    }
    async list(kind = null) { return this.request(`${this.baseUrl}${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`); }
    async get(id) { return this.request(`${this.baseUrl}/${encodeURIComponent(id)}`); }
    async updateMetadata(id, metadata) {
        return this.request(`${this.baseUrl}/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metadata })
        });
    }
    async remove(id) { return this.request(`${this.baseUrl}/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    import(file, { onProgress = () => {} } = {}) {
        return new Promise((resolve, reject) => {
            try { requireSameOrigin(this.baseUrl); }
            catch (error) { reject(error); return; }
            const xhr = this.xhrFactory();
            xhr.open("POST", this.baseUrl);
            xhr.responseType = "json";
            xhr.upload.addEventListener("progress", (event) => onProgress(Object.freeze({ loaded: event.loaded, total: event.lengthComputable ? event.total : null, percent: event.lengthComputable && event.total ? Math.round(event.loaded / event.total * 100) : null })));
            xhr.addEventListener("load", () => {
                handleOperatorAuthFailure(xhr.status);
                return xhr.status >= 200 && xhr.status < 300 && xhr.response?.ok
                    ? resolve(xhr.response) : reject(this.createError(xhr.response, xhr.status));
            });
            xhr.addEventListener("error", () => reject(this.createError(null, xhr.status)));
            xhr.addEventListener("abort", () => reject(Object.assign(new Error("Upload aborted."), { code: "UPLOAD_ABORTED" })));
            const body = new FormData(); body.append("file", file, file.name);
            applyOperatorHeaders(xhr, "POST", this.baseUrl)
                .then(() => xhr.send(body)).catch(reject);
        });
    }
    async request(url, options) {
        const response = await operatorFetch(url,
            { ...options, headers: { Accept: "application/json", ...options?.headers } });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw this.createError(payload, response.status);
        return payload;
    }
    createError(payload, status) { const error = new Error(payload?.error?.message || "Media Library request failed."); error.code = payload?.error?.code || "REQUEST_FAILED"; error.status = status; error.details = payload?.error?.details || null; return error; }
}
