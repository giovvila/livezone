import test from "node:test";
import assert from "node:assert/strict";

test("Control Room entry loads its production dependency graph", async () => {
    globalThis.window = {
        addEventListener() {},
        removeEventListener() {}
    };
    globalThis.document = {
        getElementById() { return null; },
        querySelector() { return null; }
    };
    globalThis.localStorage = {
        getItem() { return null; },
        setItem() {}
    };
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        if (fetchCount === 1) return { ok: true,
            json: async () => ({ authenticated: true, csrfToken: "test-csrf" }) };
        throw new Error("controlled boot stop");
    };

    const originalConsole = globalThis.console;
    globalThis.console = {
        ...originalConsole,
        log() {},
        info() {},
        warn() {},
        error() {}
    };

    try {
        await assert.doesNotReject(
            import("../public/js/entries/control-room-app.js")
        );
    }
    finally {
        globalThis.console = originalConsole;
    }
});
