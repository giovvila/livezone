import { timingSafeEqual } from "node:crypto";

const MUTATION_HEADER = "x-livezone-operator-request";
const CSRF_HEADER = "x-livezone-csrf";

export default class OperatorRequestGuard {
    constructor({ auth, allowedOrigins = new Set() } = {}) {
        if (!auth) throw new TypeError("OperatorRequestGuard requires authentication.");
        this.auth = auth;
        this.allowedOrigins = normalizeOrigins(allowedOrigins);
    }

    session(request) { return this.auth.sessionFromRequest(request); }

    authorize(request, response) {
        const session = this.session(request);
        if (!session) {
            sendJson(response, 401, { ok: false, error: "operator-auth-required" });
            return null;
        }
        return session;
    }

    authorizeMutation(request, response) {
        const session = this.authorize(request, response);
        if (!session) return null;
        if (session.developmentBypass) return session;
        if (!this.originAllowed(request) || request.headers[MUTATION_HEADER] !== "1" ||
            !safeToken(request.headers[CSRF_HEADER], session.csrfToken)) {
            sendJson(response, 403, { ok: false, error: "operator-request-rejected" });
            return null;
        }
        return session;
    }

    authorizeLogin(request, response) {
        if (!this.originAllowed(request) || request.headers[MUTATION_HEADER] !== "1") {
            sendJson(response, 403, { ok: false, error: "operator-request-rejected" });
            return false;
        }
        return true;
    }

    originAllowed(request) {
        const origin = request.headers.origin;
        if (!origin) return false;
        try {
            const actual = new URL(origin);
            if (actual.username || actual.password || actual.pathname !== "/" ||
                actual.search || actual.hash || actual.origin === "null") return false;
            if (this.allowedOrigins.size) return this.allowedOrigins.has(actual.origin);
            const protocol = request.socket?.encrypted === true ? "https:" : "http:";
            return actual.origin === new URL(`${protocol}//${request.headers.host}`).origin;
        }
        catch { return false; }
    }
}

export { CSRF_HEADER, MUTATION_HEADER };

function safeToken(value, expected) {
    if (typeof value !== "string" || typeof expected !== "string") return false;
    const a = Buffer.from(value); const b = Buffer.from(expected);
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function sendJson(response, status, payload) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
}

function normalizeOrigins(origins) {
    const normalized = new Set();
    for (const value of origins) {
        const parsed = new URL(value);
        if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
            parsed.origin === "null") {
            throw new TypeError("Operator allowed origins must be complete origins.");
        }
        normalized.add(parsed.origin);
    }
    return normalized;
}
