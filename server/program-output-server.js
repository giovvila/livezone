import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import ProgramOutputStore from "./program-output/ProgramOutputStore.js";
import MediaAssetRepository from "./media-library/MediaAssetRepository.js";
import MediaLibraryRoutes from "./media-library/MediaLibraryRoutes.js";
import MediaIngestConfig from "./media-ingest/MediaIngestConfig.js";
import MediaIngestStatusClient from "./media-ingest/MediaIngestStatusClient.js";
import MediaIngestRoutes from "./media-ingest/MediaIngestRoutes.js";
import RuntimeReadiness from "./runtime/RuntimeReadiness.js";

const MAX_BODY_BYTES = 64 * 1024;
const SSE_KEEPALIVE_MS = 15000;
const PUBLIC_ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const DEFAULT_MEDIA_LIBRARY_ROOT = fileURLToPath(new URL("../var/media-library/", import.meta.url));
const MIME_TYPES = new Map([
    [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"], [".mp4", "video/mp4"], [".mp3", "audio/mpeg"],
    [".ico", "image/x-icon"]
]);

export function createProgramOutputServer({
    publisherToken = process.env.LIVEZONE_PROGRAM_OUTPUT_TOKEN,
    allowedOrigins = parseOrigins(process.env.LIVEZONE_ALLOWED_ORIGINS),
    store = new ProgramOutputStore(),
    mediaLibraryRoot = process.env.LIVEZONE_MEDIA_LIBRARY_ROOT || DEFAULT_MEDIA_LIBRARY_ROOT,
    mediaLibraryMaxBytes = parseMediaLibraryMaxBytes(
        process.env.LIVEZONE_MEDIA_LIBRARY_MAX_BYTES),
    mediaAssetRepository = new MediaAssetRepository({ root: mediaLibraryRoot }),
    mediaIngestConfig = MediaIngestConfig.fromEnvironment(),
    mediaIngestStatusClient = new MediaIngestStatusClient({ config: mediaIngestConfig }),
    readiness
} = {}) {
    if (typeof publisherToken !== "string" || publisherToken.length < 16) {
        throw new Error("LIVEZONE_PROGRAM_OUTPUT_TOKEN must contain at least 16 characters.");
    }
    if (!Number.isSafeInteger(mediaLibraryMaxBytes) || mediaLibraryMaxBytes < 1) {
        throw new TypeError("LIVEZONE_MEDIA_LIBRARY_MAX_BYTES must be a positive integer.");
    }
    const clients = new Set();
    const mediaReady = mediaAssetRepository.initialize();
    // Readiness and Media Library requests still observe this rejection. Attach a
    // handler immediately so delayed probes cannot produce an unhandled rejection.
    mediaReady.catch(() => {});
    const mediaRoutes = new MediaLibraryRoutes({ repository: mediaAssetRepository,
        maxUploadBytes: mediaLibraryMaxBytes });
    const mediaIngestRoutes = new MediaIngestRoutes({ statusClient: mediaIngestStatusClient });
    const runtimeReadiness = readiness || new RuntimeReadiness({ mediaReady,
        mediaAssetRepository, mediaIngestStatusClient });
    const unsubscribe = store.subscribe((envelope) => {
        const event = formatSse(envelope);
        clients.forEach((response) => {
            if (response.destroyed || response.writableEnded) {
                clients.delete(response);
                return;
            }
            try { response.write(event); }
            catch { clients.delete(response); }
        });
    });
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
            if (url.pathname === "/healthz" && request.method === "GET") {
                sendJson(response, 200, { ok: true, service: "livezone", status: "alive" });
                return;
            }
            if (url.pathname === "/readyz" && request.method === "GET") {
                const result = await runtimeReadiness.evaluate();
                sendJson(response, result.ok ? 200 : 503, result);
                return;
            }
            if (await mediaIngestRoutes.handle(request, response, url)) return;
            if (url.pathname.startsWith("/api/media-library/") ||
                url.pathname.startsWith("/media-library/files/")) {
                await mediaReady;
                if (await mediaRoutes.handle(request, response, url)) return;
            }
            if (url.pathname === "/api/program-output" && request.method === "OPTIONS") {
                handlePublishOptions(request, response, allowedOrigins);
                return;
            }
            if (url.pathname === "/api/program-output" && request.method === "POST") {
                await handlePublish(request, response, { publisherToken, allowedOrigins, store });
                return;
            }
            if (url.pathname === "/api/program-output/events" && request.method === "GET") {
                handleEvents(request, response, clients, store);
                return;
            }
            if (url.pathname === "/config/program-output.json" && request.method === "GET") {
                sendJson(response, 200, { version: 1, mode: "network", network: {
                    publishUrl: "/api/program-output",
                    subscribeUrl: "/api/program-output/events"
                }});
                return;
            }
            serveStatic(url.pathname, request, response);
        }
        catch {
            sendJson(response, 500, { ok: false, error: "internal-error" });
        }
    });
    server.on("close", () => {
        unsubscribe();
        clients.forEach((response) => response.end());
        clients.clear();
    });
    return { server, store, clients };
}

export function parseHttpBindConfig(environment = process.env) {
    const host = environment.LIVEZONE_HTTP_HOST === undefined
        ? "0.0.0.0" : validateBindHost(environment.LIVEZONE_HTTP_HOST);
    const rawPort = environment.PORT === undefined ? "8080" : environment.PORT;
    if (typeof rawPort !== "string" || !/^[0-9]{1,5}$/.test(rawPort)) {
        throw new TypeError("PORT must be an integer between 1 and 65535.");
    }
    const port = Number(rawPort);
    if (port < 1 || port > 65535) {
        throw new TypeError("PORT must be an integer between 1 and 65535.");
    }
    return Object.freeze({ host, port });
}

function parseMediaLibraryMaxBytes(value) {
    if (value === undefined || value === "") return 2 * 1024 ** 3;
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return Number.NaN;
    return Number(value);
}

export function startProgramOutputServer({ environment = process.env,
    serverFactory = createProgramOutputServer, logger = console } = {}) {
    const { host, port } = parseHttpBindConfig(environment);
    const result = serverFactory();
    result.server.listen(port, host, () => {
        logger.log(`LIVEZONE Program Output server listening on http://${host}:${port}`);
    });
    return result;
}

function validateBindHost(value) {
    if (typeof value !== "string" || value !== value.trim() || !value ||
        value.length > 253 || /\s/.test(value)) {
        throw new TypeError("LIVEZONE_HTTP_HOST must be an IP address or hostname.");
    }
    if (isIP(value) || value === "localhost") return value;
    if (/[/:?#@\[\]]/.test(value)) {
        throw new TypeError("LIVEZONE_HTTP_HOST must be an IP address or hostname.");
    }
    const labels = value.split(".");
    if (labels.some((label) => !label || label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
        throw new TypeError("LIVEZONE_HTTP_HOST must be an IP address or hostname.");
    }
    return value;
}

async function handlePublish(request, response, { publisherToken, allowedOrigins, store }) {
    const cors = publishCorsHeaders(request, allowedOrigins);
    if (!originAllowed(request, allowedOrigins)) {
        sendJson(response, 403, { ok: false, error: "origin-rejected" });
        return;
    }
    if (!tokenMatches(request.headers.authorization, publisherToken)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" }, cors);
        return;
    }
    if (!String(request.headers["content-type"] || "").toLowerCase()
        .startsWith("application/json")) {
        sendJson(response, 415, { ok: false, error: "content-type" }, cors);
        return;
    }
    let payload;
    try { payload = JSON.parse(await readBody(request)); }
    catch (error) {
        sendJson(response, error?.message === "payload-too-large" ? 413 : 400,
            { ok: false, error: error?.message === "payload-too-large"
                ? "payload-too-large" : "invalid-json" }, cors);
        return;
    }
    const result = store.accept(payload);
    if (!result.accepted) {
        const stale = ["stale-revision", "retired-session"]
            .includes(result.reason);
        sendJson(response, stale ? 409 : 422, { ok: false, error: result.reason }, cors);
        return;
    }
    sendJson(response, 202, { ok: true, publisherSessionId:
        result.envelope.publisherSessionId, revision: result.envelope.revision }, cors);
}

function handlePublishOptions(request, response, allowedOrigins) {
    if (!originAllowed(request, allowedOrigins)) {
        sendJson(response, 403, { ok: false, error: "origin-rejected" }); return;
    }
    response.writeHead(204, {
        ...publishCorsHeaders(request, allowedOrigins),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store"
    });
    response.end();
}

function handleEvents(request, response, clients, store) {
    response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    response.write("retry: 3000\n\n");
    const retained = store.getCurrent();
    if (retained) response.write(formatSse(retained));
    clients.add(response);
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);
    keepalive.unref?.();
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(keepalive);
        clients.delete(response);
    };
    request.on("aborted", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
}

function serveStatic(pathname, request, response) {
    const requested = pathname === "/" ? "/index.html"
        : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const path = normalize(join(PUBLIC_ROOT, decodeURIComponent(requested)));
    if (relative(PUBLIC_ROOT, path).startsWith("..")) {
        sendJson(response, 403, { ok: false, error: "forbidden" }); return;
    }
    try {
        const stat = statSync(path);
        if (!stat.isFile()) throw new Error("not-file");
        const headers = {
            "Content-Type": MIME_TYPES.get(extname(path).toLowerCase()) ||
                "application/octet-stream",
            "Cache-Control": [".html", ".js", ".json"].includes(
                extname(path).toLowerCase()
            ) ? "no-cache" : "public, max-age=300",
            "Accept-Ranges": "bytes"
        };
        const range = parseByteRange(request.headers.range, stat.size);
        if (range === false) {
            response.writeHead(416, { ...headers,
                "Content-Range": `bytes */${stat.size}` });
            response.end();
            return;
        }
        if (range) {
            headers["Content-Range"] =
                `bytes ${range.start}-${range.end}/${stat.size}`;
            headers["Content-Length"] = String(range.end - range.start + 1);
            response.writeHead(206, headers);
            if (request.method === "HEAD") response.end();
            else createReadStream(path, range).pipe(response);
            return;
        }
        headers["Content-Length"] = String(stat.size);
        response.writeHead(200, headers);
        if (request.method === "HEAD") response.end();
        else createReadStream(path).pipe(response);
    }
    catch { sendJson(response, 404, { ok: false, error: "not-found" }); }
}

function parseByteRange(value, size) {
    if (value === undefined) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
    if (!match || (!match[1] && !match[2]) || size <= 0) return false;
    let start;
    let end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
        start = Math.max(0, size - suffix);
        end = size - 1;
    }
    else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || start >= size || end < start) return false;
        end = Math.min(end, size - 1);
    }
    return { start, end };
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0; let settled = false;
        request.on("data", (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                settled = true; reject(new Error("payload-too-large")); request.resume(); return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", (error) => { if (!settled) reject(error); });
    });
}

function tokenMatches(header, expected) {
    const token = typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7) : "";
    const left = Buffer.from(token); const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

function originAllowed(request, allowedOrigins) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
        if (new URL(origin).host === request.headers.host) return true;
        return allowedOrigins.has(origin);
    }
    catch { return false; }
}

function formatSse(envelope) {
    return `id: ${envelope.publisherSessionId}:${envelope.revision}\n` +
        `event: program\ndata: ${JSON.stringify(envelope)}\n\n`;
}
function sendJson(response, status, payload, extraHeaders = {}) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store", ...extraHeaders });
    response.end(JSON.stringify(payload));
}
function parseOrigins(value) {
    return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}
function publishCorsHeaders(request, allowedOrigins) {
    const origin = request.headers.origin;
    return origin && allowedOrigins.has(origin)
        ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" }
        : {};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startProgramOutputServer();
}
