import Busboy from "busboy";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ID_PATTERN } from "./MediaAssetRepository.js";

export default class MediaLibraryRoutes {
    constructor({ repository, maxUploadBytes = 2 * 1024 ** 3, referenceGuard = () => false } = {}) {
        this.repository = repository;
        this.maxUploadBytes = maxUploadBytes;
        this.referenceGuard = referenceGuard;
    }

    async handle(request, response, url) {
        const collection = url.pathname === "/api/media-library/assets";
        const match = /^\/api\/media-library\/assets\/([^/]+)$/.exec(url.pathname);
        const file = /^\/media-library\/files\/(video|audio|image)\/([^/]+)$/.exec(url.pathname);
        if (collection && request.method === "GET") {
            const kind = url.searchParams.get("kind");
            if (kind && !["video", "audio", "image"].includes(kind)) return this.failure(response, 400, "KIND_INVALID", "Asset kind is invalid.");
            return this.success(response, 200, { assets: this.repository.list({ kind }) });
        }
        if (collection && request.method === "POST") return this.upload(request, response);
        if (match && request.method === "GET") {
            const id = decodeURIComponent(match[1]);
            if (!ID_PATTERN.test(id)) return this.failure(response, 400, "ASSET_ID_INVALID", "Asset ID is invalid.");
            const asset = this.repository.get(id);
            return asset ? this.success(response, 200, { asset }) : this.failure(response, 404, "ASSET_NOT_FOUND", "Asset was not found.");
        }
        if (match && request.method === "DELETE") {
            try {
                const id = decodeURIComponent(match[1]);
                if (!ID_PATTERN.test(id)) return this.failure(response, 400, "ASSET_ID_INVALID", "Asset ID is invalid.");
                const asset = await this.repository.delete(id, { isReferenced: this.referenceGuard });
                return this.success(response, 200, { asset });
            }
            catch (error) { return this.repositoryFailure(response, error); }
        }
        if (file && ["GET", "HEAD"].includes(request.method)) return this.serveFile(request, response, file[1], decodeURIComponent(file[2]));
        return false;
    }

    async upload(request, response) {
        if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
            return this.failure(response, 415, "CONTENT_TYPE_INVALID", "Expected multipart/form-data.");
        }
        await mkdir(this.repository.tempRoot, { recursive: true });
        const tempPath = join(this.repository.tempRoot, `upload-${randomUUID()}.tmp`);
        let originalName = null; let mimeType = null; let size = 0; let fileCount = 0; let limited = false;
        try {
            const parser = Busboy({ headers: request.headers, limits: { files: 1, fileSize: this.maxUploadBytes, fields: 0 } });
            const writes = [];
            parser.on("file", (_name, stream, info) => {
                fileCount += 1; originalName = info.filename; mimeType = info.mimeType;
                stream.on("data", (chunk) => { size += chunk.length; });
                stream.on("limit", () => { limited = true; });
                writes.push(pipeline(stream, createWriteStream(tempPath, { flags: "wx" })));
            });
            const finished = new Promise((resolve, reject) => { parser.once("finish", resolve); parser.once("error", reject); request.once("aborted", () => reject(Object.assign(new Error("Upload aborted."), { code: "UPLOAD_ABORTED" }))); });
            request.pipe(parser);
            await finished;
            await Promise.all(writes);
            if (limited) throw Object.assign(new Error("Upload exceeds configured limit."), { code: "UPLOAD_TOO_LARGE" });
            if (fileCount !== 1) throw Object.assign(new Error("Exactly one file is required."), { code: "UPLOAD_INVALID" });
            const asset = await this.repository.importTempFile({ tempPath, originalName, mimeType, size });
            return this.success(response, 201, { asset });
        }
        catch (error) {
            await unlink(tempPath).catch(() => {});
            return this.repositoryFailure(response, error);
        }
    }

    async serveFile(request, response, kind, storedName) {
        let path;
        try { path = this.repository.safeFilePath(kind, storedName); }
        catch (error) { return this.repositoryFailure(response, error); }
        let info;
        try { info = await stat(path); }
        catch { return this.failure(response, 404, "ASSET_FILE_NOT_FOUND", "Managed file was not found."); }
        const asset = this.repository.list({ kind }).find((item) => item.storedName === storedName);
        if (!asset) return this.failure(response, 404, "ASSET_NOT_FOUND", "Asset was not found.");
        const headers = { "Content-Type": asset.mimeType, "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" };
        const range = this.parseRange(request.headers.range, info.size);
        if (range === false) { response.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` }); return response.end(); }
        if (range) {
            response.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`, "Content-Length": range.end - range.start + 1 });
            return request.method === "HEAD" ? response.end() : createReadStream(path, range).pipe(response);
        }
        response.writeHead(200, { ...headers, "Content-Length": info.size });
        return request.method === "HEAD" ? response.end() : createReadStream(path).pipe(response);
    }

    parseRange(value, size) {
        if (value === undefined) return null;
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
        if (!match || !match[1] && !match[2]) return false;
        let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        let end = match[2] && match[1] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
        return { start, end: Math.min(end, size - 1) };
    }

    repositoryFailure(response, error) {
        const status = ({ UPLOAD_TOO_LARGE: 413, ASSET_NOT_FOUND: 404, ASSET_REFERENCED: 409,
            MIME_MISMATCH: 415, UNSUPPORTED_TYPE: 415, SIGNATURE_MISMATCH: 422,
            CLIENT_PATH_REJECTED: 400, PATH_INVALID: 400, ASSET_ID_INVALID: 400,
            UPLOAD_INVALID: 400, UPLOAD_ABORTED: 400 })[error?.code] || 500;
        return this.failure(response, status, error?.code || "INTERNAL_ERROR", error?.message || "Internal error.");
    }
    success(response, status, value) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify({ ok: true, ...value })); return true; }
    failure(response, status, code, message, details = null) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify({ ok: false, error: { code, message, details } })); return true; }
}
