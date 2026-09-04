import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgramOutputServer, parseHttpBindConfig,
    startProgramOutputServer } from "../server/program-output-server.js";
import MediaAssetRepository from "../server/media-library/MediaAssetRepository.js";
import RuntimeReadiness from "../server/runtime/RuntimeReadiness.js";

const TOKEN = "runtime-health-test-token";

test("healthz is sanitized liveness even when ingest is offline", async () => {
    await withServer(async (base) => {
        const response = await fetch(`${base}/healthz`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            ok: true, service: "livezone", status: "alive"
        });
    }, { mediaIngestStatusClient: statusClient("offline") });
});

test("readyz reports usable dependencies and OBS offline remains ready", async () => {
    await withServer(async (base) => {
        const response = await fetch(`${base}/readyz`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            ok: true, service: "livezone", status: "ready", checks: {
                mediaLibrary: "ok", programOutput: "ok", mediaIngestControl: "ok",
                studioState: "uninitialized"
            }
        });
    }, { mediaIngestStatusClient: statusClient("offline") });
});

test("readyz degrades safely when optional MediaMTX control is unavailable", async () => {
    await withServer(async (base) => {
        const response = await fetch(`${base}/readyz`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            ok: true, service: "livezone", status: "degraded", checks: {
                mediaLibrary: "ok", programOutput: "ok",
                mediaIngestControl: "degraded", studioState: "uninitialized"
            }
        });
    }, { mediaIngestStatusClient: statusClient("error") });
});

test("readyz returns sanitized 503 when Media Library storage is unavailable", async () => {
    const secret = "do-not-return-this-secret";
    const repository = {
        tempRoot: join(tmpdir(), secret),
        initialize: async () => { throw new Error(`${secret}: C:\\private\\library`); }
    };
    await withServer(async (base) => {
        const response = await fetch(`${base}/readyz`);
        assert.equal(response.status, 503);
        const body = await response.text();
        assert.deepEqual(JSON.parse(body), {
            ok: false, service: "livezone", status: "not-ready", checks: {
                mediaLibrary: "unavailable", programOutput: "ok",
                mediaIngestControl: "ok", studioState: "uninitialized"
            }
        });
        assert.equal(body.includes(secret), false);
        assert.equal(body.includes("private"), false);
        assert.equal(body.includes(TOKEN), false);
    }, { mediaAssetRepository: repository,
        mediaIngestStatusClient: statusClient("offline") });
});

test("Media Library write-probe failure makes application not ready", async () => {
    const readiness = new RuntimeReadiness({ mediaReady: Promise.resolve(),
        mediaAssetRepository: { tempRoot: "not-returned" },
        mediaIngestStatusClient: statusClient("offline"),
        writableProbe: async () => { throw new Error("read-only filesystem"); } });
    assert.deepEqual(await readiness.evaluate(), {
        ok: false, service: "livezone", status: "not-ready", checks: {
            mediaLibrary: "unavailable", programOutput: "ok",
            mediaIngestControl: "ok"
        }
    });
});

test("HTTP bind defaults remain compatible and configured values are honored", () => {
    assert.deepEqual(parseHttpBindConfig({}), { host: "0.0.0.0", port: 8080 });
    assert.deepEqual(parseHttpBindConfig({ LIVEZONE_HTTP_HOST: "127.0.0.1",
        PORT: "9080" }), { host: "127.0.0.1", port: 9080 });
    const observed = {};
    const server = { listen(port, host, callback) {
        Object.assign(observed, { port, host }); callback();
    } };
    startProgramOutputServer({ environment: { LIVEZONE_HTTP_HOST: "127.0.0.1",
        PORT: "9080" }, serverFactory: () => ({ server }), logger: { log() {} } });
    assert.deepEqual(observed, { host: "127.0.0.1", port: 9080 });
});

test("malformed HTTP bind host and port fail closed", () => {
    for (const host of ["", " 127.0.0.1", "http://127.0.0.1", "bad host",
        "host:8080", "-invalid.example"]) {
        assert.throws(() => parseHttpBindConfig({ LIVEZONE_HTTP_HOST: host }),
            /LIVEZONE_HTTP_HOST/);
    }
    for (const port of ["", "0", "65536", "8080x", "-1", " 8080"])
        assert.throws(() => parseHttpBindConfig({ PORT: port }), /PORT/);
});

test("health routes do not change Program Output config or SSE contracts", async () => {
    await withServer(async (base) => {
        const config = await fetch(`${base}/config/program-output.json`);
        assert.equal(config.status, 200);
        assert.deepEqual(await config.json(), { version: 1, mode: "network", network: {
            publishUrl: "/api/program-output",
            subscribeUrl: "/api/program-output/events"
        } });
        const abort = new AbortController();
        const events = await fetch(`${base}/api/program-output/events`, {
            signal: abort.signal
        });
        assert.equal(events.status, 200);
        assert.match(events.headers.get("content-type"), /^text\/event-stream/);
        const first = new TextDecoder().decode((await events.body.getReader().read()).value);
        assert.equal(first, "retry: 3000\n\n");
        abort.abort();
    });
});

function statusClient(state) {
    return { async getStatus() { return { state }; } };
}

async function withServer(operation, options = {}) {
    const root = await mkdtemp(join(tmpdir(), "livezone-health-"));
    const repository = options.mediaAssetRepository || new MediaAssetRepository({ root });
    if (!options.mediaAssetRepository) await repository.initialize();
    const { server } = createProgramOutputServer({ publisherToken: TOKEN,
        mediaAssetRepository: repository, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { return await operation(base); }
    finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
}
