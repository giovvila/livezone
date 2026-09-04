import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scryptSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createProgramOutputServer } from "../server/program-output-server.js";
import MediaAssetRepository from "../server/media-library/MediaAssetRepository.js";
import OperatorAuth from "../server/auth/OperatorAuth.js";
import OperatorSessionStore from "../server/auth/OperatorSessionStore.js";
import OperatorRequestGuard from "../server/auth/OperatorRequestGuard.js";
import { createOperatorPasswordVerifier } from
    "../tools/generate-operator-password-hash.mjs";
import { createProgramOutputEnvelope } from
    "../public/js/program-output/ProgramOutputEnvelope.js";

const PUBLISHER_TOKEN = "publisher-token-is-separate";
const USERNAME = "operator";
const PASSWORD = "correct horse battery staple";

test("anonymous Viewer contract remains public while operator surfaces redirect or deny", async () => {
    await withServer(async ({ base, publicAssetUrl }) => {
        assert.equal((await fetch(`${base}/`)).status, 200);
        assert.equal((await fetch(`${base}/login/`)).status, 200);
        assert.equal((await fetch(`${base}/config/program-output.json`)).status, 200);
        const controller = new AbortController();
        const events = await fetch(`${base}/api/program-output/events`, { signal: controller.signal });
        assert.equal(events.status, 200); controller.abort();
        assert.equal((await fetch(`${base}${publicAssetUrl}`, { method: "HEAD" })).status, 200);

        for (const path of ["/control/", "/control/schedule/"]) {
            const response = await fetch(`${base}${path}`, { redirect: "manual" });
            assert.equal(response.status, 302);
            assert.match(response.headers.get("location"), /^\/login\/\?return=/);
            assert.equal((await response.text()).includes("LIVEZONE Control Room"), false);
        }
        for (const path of ["/api/media-library/assets", "/api/media-ingest/status",
            "/config/studio.json"]) {
            assert.equal((await fetch(`${base}${path}`)).status, 401);
        }
    });
});

test("login is generic, sanitized, sets hardened cookie, and rejects open redirects", async () => {
    await withServer(async ({ base }) => {
        assert.equal((await fetch(`${base}/api/operator/login`, { method: "POST",
            headers: { Origin: "https://attacker.example",
                "Content-Type": "application/json", "X-Livezone-Operator-Request": "1" },
            body: "{}" })).status, 403);
        let response = await login(base, "wrong", PASSWORD);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { ok: false, error: "invalid-credentials" });

        response = await login(base, USERNAME, PASSWORD, "https://attacker.example/");
        assert.equal(response.status, 200);
        const text = await response.text();
        const payload = JSON.parse(text);
        assert.equal(payload.authenticated, true);
        assert.equal(payload.returnTo, "/control/");
        assert.equal(text.includes(PASSWORD), false);
        assert.equal(text.includes(PUBLISHER_TOKEN), false);
        assert.equal(Object.hasOwn(payload, "sessionId"), false);
        const setCookie = response.headers.get("set-cookie");
        assert.match(setCookie, /^livezone-operator-dev=/);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Strict/);
        assert.match(setCookie, /Path=\//);
        assert.equal(setCookie.includes("Secure"), false);
        const cookie = setCookie.split(";", 1)[0];
        response = await fetch(`${base}/api/operator/session`, { headers: { Cookie: cookie } });
        const status = await response.text();
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(status).authenticated, true);
        assert.equal(status.includes(PASSWORD), false);
        assert.equal(status.includes(PUBLISHER_TOKEN), false);
        assert.equal(status.includes(cookie.split("=")[1]), false);
    });
});

test("authenticated Control, Scheduler and Media Library reads succeed", async () => {
    await withServer(async ({ base }) => {
        const session = await authenticatedSession(base);
        for (const path of ["/control/", "/control/schedule/",
            "/api/media-library/assets", "/api/media-ingest/status", "/config/studio.json"]) {
            const response = await fetch(`${base}${path}`, { headers: { Cookie: session.cookie } });
            assert.equal(response.status, 200);
            if (path === "/control/") assert.match(await response.text(), /id="operator-logout"/);
        }
    });
});

test("Media Library mutations require session, same origin, marker and CSRF", async () => {
    await withServer(async ({ base }) => {
        const paths = [
            ["POST", "/api/media-library/assets"],
            ["PATCH", "/api/media-library/assets/asset-00000000-0000-4000-8000-000000000001"],
            ["DELETE", "/api/media-library/assets/asset-00000000-0000-4000-8000-000000000001"]
        ];
        for (const [method, path] of paths) {
            assert.equal((await fetch(`${base}${path}`, { method })).status, 401);
        }
        const session = await authenticatedSession(base);
        const target = `${base}/api/media-library/assets/asset-00000000-0000-4000-8000-000000000001`;
        assert.equal((await fetch(target, { method: "PATCH", headers: {
            Cookie: session.cookie, Origin: "https://attacker.example",
            "X-Livezone-Operator-Request": "1", "X-Livezone-CSRF": session.csrf
        }})).status, 403);
        assert.equal((await fetch(target, { method: "PATCH", headers: {
            Cookie: session.cookie, Origin: base, "X-Livezone-Operator-Request": "1"
        }})).status, 403);
        const valid = await fetch(target, { method: "PATCH", headers: {
            Cookie: session.cookie, Origin: base, "X-Livezone-Operator-Request": "1",
            "X-Livezone-CSRF": session.csrf, "Content-Type": "application/json"
        }, body: JSON.stringify({ metadata: { durationSeconds: 1 } }) });
        assert.equal(valid.status, 404);
    });
});

test("logout invalidates the session and malformed cookies never authenticate", async () => {
    await withServer(async ({ base }) => {
        const session = await authenticatedSession(base);
        let response = await fetch(`${base}/api/operator/logout`, { method: "POST", headers: {
            Cookie: session.cookie, Origin: base, "X-Livezone-Operator-Request": "1",
            "X-Livezone-CSRF": session.csrf
        }});
        assert.equal(response.status, 200);
        assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
        response = await fetch(`${base}/api/media-library/assets`,
            { headers: { Cookie: session.cookie } });
        assert.equal(response.status, 401);
        response = await fetch(`${base}/api/media-library/assets`,
            { headers: { Cookie: "livezone-operator-dev=%E0%A4%A" } });
        assert.equal(response.status, 401);
    });
});

test("expired sessions are removed and denied", async () => {
    let now = 1000;
    let serial = 0;
    const sessions = new OperatorSessionStore({ ttlSeconds: 300, clock: () => now,
        random: () => `opaque-${++serial}` });
    const auth = configuredAuth({ sessions });
    await withServer(async ({ base }) => {
        const session = await authenticatedSession(base);
        now += 301000;
        assert.equal((await fetch(`${base}/api/media-library/assets`,
            { headers: { Cookie: session.cookie } })).status, 401);
        assert.equal(sessions.sessions.size, 0);
    }, { operatorAuth: auth });
});

test("operator session never replaces the independent Program Output publisher token", async () => {
    await withServer(async ({ base }) => {
        const session = await authenticatedSession(base);
        const envelope = createProgramOutputEnvelope(snapshot());
        let response = await fetch(`${base}/api/program-output`, { method: "POST", headers: {
            Cookie: session.cookie, "Content-Type": "application/json"
        }, body: JSON.stringify(envelope) });
        assert.equal(response.status, 401);
        response = await fetch(`${base}/api/program-output`, { method: "POST", headers: {
            Authorization: `Bearer ${PUBLISHER_TOKEN}`, "Content-Type": "application/json"
        }, body: JSON.stringify(envelope) });
        assert.equal(response.status, 202);
    });
});

test("health and readiness stay public and contain no authentication secrets", async () => {
    await withServer(async ({ base }) => {
        for (const path of ["/healthz", "/readyz"]) {
            const response = await fetch(`${base}${path}`);
            assert.equal(response.status, 200);
            const text = await response.text();
            for (const secret of [USERNAME, PASSWORD, PUBLISHER_TOKEN, "csrfToken", "sessionId"]) {
                assert.equal(text.includes(secret), false);
            }
        }
    });
});

test("authentication defaults fail closed and explicit bypass is loopback-only", async () => {
    const unavailable = OperatorAuth.fromEnvironment({});
    assert.equal(unavailable.disabled, false);
    assert.equal(unavailable.configured, false);
    assert.throws(() => OperatorAuth.fromEnvironment({ LIVEZONE_OPERATOR_AUTH_DISABLED: "true",
        LIVEZONE_HTTP_HOST: "0.0.0.0" }), /loopback/);
    const disabled = OperatorAuth.fromEnvironment({ LIVEZONE_OPERATOR_AUTH_DISABLED: "true",
        LIVEZONE_HTTP_HOST: "127.0.0.1", LIVEZONE_OPERATOR_COOKIE_SECURE: "false" });
    assert.equal(disabled.sessionFromRequest({ headers: {} }).developmentBypass, true);
    assert.throws(() => OperatorAuth.fromEnvironment({
        LIVEZONE_OPERATOR_AUTH_DISABLED: "yes" }), /true or false/);

    await withServer(async ({ base }) => {
        assert.equal((await login(base, USERNAME, PASSWORD)).status, 503);
        assert.equal((await fetch(`${base}/api/media-library/assets`)).status, 401);
    }, { operatorAuth: unavailable });
});

test("scrypt verifier authenticates without retaining a plaintext configured password", () => {
    const salt = Buffer.alloc(16, 7);
    const digest = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1,
        maxmem: 64 * 1024 * 1024 });
    const auth = new OperatorAuth({ username: USERNAME,
        passwordScrypt: `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}` });
    assert.equal(auth.configured, true);
    assert.equal(auth.password, "");
    assert.ok(auth.authenticate(USERNAME, PASSWORD));
    assert.equal(auth.authenticate(USERNAME, "incorrect password"), null);
    assert.equal(new OperatorAuth({ username: USERNAME, password: PASSWORD,
        passwordScrypt: "malformed" }).configured, false);
    const production = new OperatorAuth({ username: USERNAME, password: PASSWORD });
    const session = production.authenticate(USERNAME, PASSWORD);
    assert.match(production.createCookie(session), /^__Host-livezone-operator=/);
    assert.match(production.createCookie(session), /; Secure/);
});

test("canonical pathname pipeline blocks encoded static authorization bypasses", async () => {
    await withServer(async ({ base }) => {
        const attacks = [
            "/control%2findex.html", "/control%2Findex.html",
            "/control%5cindex.html", "/control%5Cindex.html",
            "/control\\index.html", "/control/%5Cindex.html",
            "/control%252findex.html", "/control/%2e%2e/index.html",
            "/control/%", "/config%2fprogram-output.json",
            "/config%2Fstudio.json", "/config%5cstudio.json",
            "/control%2fschedule%2findex.html"
        ];
        for (const method of ["GET", "HEAD"]) {
            for (const path of attacks) {
                const response = await rawRequest(base, path, method);
                assert.equal(response.status, 400, `${method} ${path}`);
            }
        }
        for (const path of ["/control", "/control/", "/control/index.html?x=1",
            "/control/schedule", "/control/schedule/", "/control/schedule/index.html?x=1"]) {
            for (const method of ["GET", "HEAD"]) {
                const response = await fetch(`${base}${path}`, { method, redirect: "manual" });
                assert.equal(response.status, 302, `${method} ${path}`);
            }
        }
        for (const method of ["GET", "HEAD"]) {
            assert.equal((await fetch(`${base}/config/studio.json`, { method })).status, 401);
        }
        assert.equal((await fetch(`${base}/login/`)).status, 200);
        assert.equal((await fetch(`${base}/config/program-output.json`)).status, 200);

        const session = await authenticatedSession(base);
        for (const path of ["/control/", "/control/index.html", "/control/schedule/",
            "/control/schedule/index.html", "/config/studio.json"]) {
            assert.equal((await fetch(`${base}${path}`, { method: "HEAD",
                headers: { Cookie: session.cookie } })).status, 200, path);
        }
    });
});

test("Windows case aliases cannot bypass protected static namespaces", async () => {
    await withServer(async ({ base, publicAssetUrl }) => {
        const protectedAliases = [
            "/CONTROL/", "/CONTROL/index.html", "/Control/Index.html",
            "/control/INDEX.HTML", "/cOnTrOl/",
            "/CONTROL/SCHEDULE/", "/Control/Schedule/index.html",
            "/control/schedule/INDEX.HTML",
            "/CONFIG/studio.json", "/Config/Studio.json",
            "/CONFIG/config.json", "/Config/Assets.json",
            "/CONFIG/program-output.json", "/config/PROGRAM-OUTPUT.JSON",
            "/Config/Program-Output.Json"
        ];
        for (const method of ["GET", "HEAD"]) {
            for (const path of protectedAliases) {
                const response = await rawRequest(base, path, method);
                assert.equal(response.status, 404, `${method} ${path}`);
            }
            assert.equal((await rawRequest(base, "/config/program-output.json", method)).status,
                200, `${method} canonical public config`);
            for (const path of ["/control/", "/control/index.html",
                "/control/schedule/", "/control/schedule/index.html"]) {
                assert.equal((await rawRequest(base, path, method)).status, 302,
                    `${method} ${path}`);
            }
            for (const path of ["/config/studio.json", "/config/config.json",
                "/config/assets.json"]) {
                assert.equal((await rawRequest(base, path, method)).status, 401,
                    `${method} ${path}`);
            }
        }
        assert.equal((await fetch(`${base}/`)).status, 200);
        assert.equal((await fetch(`${base}${publicAssetUrl}`, { method: "HEAD" })).status, 200);

        const session = await authenticatedSession(base);
        for (const path of ["/control/", "/control/index.html", "/control/schedule/",
            "/control/schedule/index.html", "/config/studio.json", "/config/config.json",
            "/config/assets.json"]) {
            assert.equal((await fetch(`${base}${path}`, { headers: {
                Cookie: session.cookie } })).status, 200, path);
        }
        assert.equal((await rawRequest(base, "/CONTROL/index.html")).status, 404);
    });
});

test("operator origins compare normalized scheme, host and effective port", () => {
    const auth = configuredAuth();
    const response = { writeHead() {}, end() {} };
    const direct = new OperatorRequestGuard({ auth });
    const request = (origin, host = "www.livezone.it") => ({
        headers: { origin, host }, socket: { encrypted: false }
    });
    assert.equal(direct.originAllowed(request("http://www.livezone.it")), true);
    assert.equal(direct.originAllowed(request("https://www.livezone.it")), false);
    assert.equal(direct.originAllowed(request("http://www.livezone.it:444")), false);
    assert.equal(direct.originAllowed(request("http://www.livezone.it.evil.example")), false);
    assert.equal(direct.originAllowed(request("null")), false);
    assert.equal(direct.originAllowed({ headers: { host: "www.livezone.it" }, socket: {} }), false);
    const allowed = new OperatorRequestGuard({ auth,
        allowedOrigins: new Set(["https://www.livezone.it:443", "https://www.livezone.it:444"]) });
    assert.equal(allowed.originAllowed(request("https://www.livezone.it")), true);
    assert.equal(allowed.originAllowed(request("https://www.livezone.it:443")), true);
    assert.equal(allowed.originAllowed(request("https://www.livezone.it:444")), true);
    assert.equal(allowed.authorizeLogin(request("https://evil.example"), response), false);
});

test("session store sweeps expiry and fails closed at a bounded capacity", () => {
    let now = 0; let serial = 0;
    const sessions = new OperatorSessionStore({ ttlSeconds: 300, maxSessions: 3,
        clock: () => now, random: () => `random-${++serial}` });
    const first = sessions.create(); const second = sessions.create(); const third = sessions.create();
    assert.ok(first && second && third);
    assert.equal(sessions.create(), null);
    assert.equal(sessions.get(first.id), first);
    assert.equal(sessions.get(second.id), second);
    sessions.delete(second.id);
    assert.ok(sessions.create());
    now += 301000;
    assert.equal(sessions.get(first.id), null);
    assert.equal(sessions.sessions.size, 0);
    assert.ok(sessions.create());
});

test("repeated successful authentication cannot exceed session capacity", () => {
    const sessions = new OperatorSessionStore({ ttlSeconds: 300, maxSessions: 2 });
    const auth = configuredAuth({ sessions });
    const first = auth.authenticate(USERNAME, PASSWORD);
    const second = auth.authenticate(USERNAME, PASSWORD);
    assert.ok(first && second);
    assert.equal(auth.authenticate(USERNAME, PASSWORD), null);
    assert.equal(sessions.get(first.id), first);
    assert.equal(sessions.get(second.id), second);
    sessions.delete(first.id);
    assert.ok(auth.authenticate(USERNAME, PASSWORD));
});

test("password helper creates an OperatorAuth-compatible verifier", () => {
    const verifier = createOperatorPasswordVerifier(PASSWORD, Buffer.alloc(16, 9));
    assert.match(verifier, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    const [, , , , salt, digest] = verifier.split("$");
    assert.equal(Buffer.from(salt, "base64url").length, 16);
    assert.equal(Buffer.from(digest, "base64url").length, 64);
    const auth = new OperatorAuth({ username: USERNAME, passwordScrypt: verifier });
    assert.ok(auth.authenticate(USERNAME, PASSWORD));
});

function configuredAuth(options = {}) {
    return new OperatorAuth({ username: USERNAME, password: PASSWORD,
        secureCookie: false, ...options });
}

function rawRequest(base, path, method = "GET") {
    const target = new URL(base);
    return new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: target.hostname, port: target.port,
            method, path }, (response) => {
            response.resume();
            response.on("end", () => resolve({ status: response.statusCode,
                headers: response.headers }));
        });
        request.on("error", reject);
        request.end();
    });
}

async function withServer(operation, options = {}) {
    const root = await mkdtemp(join(tmpdir(), "livezone-operator-auth-"));
    const seedRepository = new MediaAssetRepository({ root });
    const fixture = join(root, "fixture.mp3");
    await writeFile(fixture, Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00audio"));
    await seedRepository.initialize();
    const asset = await seedRepository.importTempFile({ tempPath: fixture,
        originalName: "fixture.mp3", mimeType: "audio/mpeg", size: 15 });
    const repository = new MediaAssetRepository({ root });
    const { server } = createProgramOutputServer({ publisherToken: PUBLISHER_TOKEN,
        mediaAssetRepository: repository, operatorAuth: configuredAuth(), ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { return await operation({ base, publicAssetUrl: asset.url }); }
    finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
}

async function login(base, username, password, returnTo = "/control/") {
    return fetch(`${base}/api/operator/login`, { method: "POST", headers: {
        Origin: base, "Content-Type": "application/json", "X-Livezone-Operator-Request": "1"
    }, body: JSON.stringify({ username, password, returnTo }) });
}

async function authenticatedSession(base) {
    const response = await login(base, USERNAME, PASSWORD);
    assert.equal(response.status, 200);
    const payload = await response.json();
    return { cookie: response.headers.get("set-cookie").split(";", 1)[0],
        csrf: payload.csrfToken };
}

function snapshot() {
    return { version: 1, publisherSessionId: "operator-auth-test", revision: 1,
        publishedAt: "2026-09-04T10:00:00.000Z",
        committedAt: "2026-09-04T10:00:00.000Z",
        scene: null, source: null, playback: { initialTime: 0, duration: null,
            playing: false, ended: false, state: "ready",
            startedAt: "2026-09-04T10:00:00.000Z" },
        graphics: { items: [] }, transition: { type: "cut", durationMs: 0 } };
}
