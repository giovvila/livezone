import test from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
});

test("operatorFetch sends mutation credentials only to the same origin", async () => {
    globalThis.location = { href: "https://www.livezone.it/control/",
        origin: "https://www.livezone.it", pathname: "/control/", replace() {} };
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url) === "/api/operator/session") return response({
            ok: true, authenticated: true, csrfToken: "csrf-secret"
        });
        return response({ ok: true });
    };
    const client = await import(`../public/js/auth/OperatorSessionClient.js?same=${Date.now()}`);
    const result = await client.operatorFetch("/api/media-library/assets/id", { method: "PATCH" });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://www.livezone.it/api/media-library/assets/id");
    assert.equal(calls[1].options.headers.get("X-Livezone-Operator-Request"), "1");
    assert.equal(calls[1].options.headers.get("X-Livezone-CSRF"), "csrf-secret");
});

test("cross-origin operatorFetch rejects before dispatch without redirect or headers", async () => {
    let redirected = false; let calls = 0;
    globalThis.location = { href: "https://www.livezone.it/control/",
        origin: "https://www.livezone.it", pathname: "/control/",
        replace() { redirected = true; } };
    globalThis.fetch = async () => { calls += 1; return response({ ok: true }); };
    const client = await import(`../public/js/auth/OperatorSessionClient.js?cross=${Date.now()}`);
    await assert.rejects(client.operatorFetch("https://evil.example/collect", { method: "POST" }),
        /Cross-origin/);
    assert.equal(calls, 0);
    assert.equal(redirected, false);
});

test("Media Library upload rejects a cross-origin base before creating XHR", async () => {
    globalThis.location = { href: "https://www.livezone.it/control/",
        origin: "https://www.livezone.it", pathname: "/control/", replace() {} };
    let created = 0;
    const { default: MediaLibraryClient } = await import(
        `../public/js/media-library/MediaLibraryClient.js?cross=${Date.now()}`);
    const client = new MediaLibraryClient({ baseUrl: "https://evil.example/upload",
        xhrFactory: () => { created += 1; return {}; } });
    await assert.rejects(client.import({ name: "fixture.mp3" }), /Cross-origin/);
    assert.equal(created, 0);
});

function response(payload) {
    return { ok: true, status: 200, json: async () => payload };
}
