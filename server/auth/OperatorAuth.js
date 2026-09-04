import { scryptSync, timingSafeEqual } from "node:crypto";
import OperatorSessionStore from "./OperatorSessionStore.js";

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const COOKIE_NAME = "__Host-livezone-operator";
const DEVELOPMENT_COOKIE_NAME = "livezone-operator-dev";

export default class OperatorAuth {
    constructor({ username = "", password = "", passwordScrypt = "",
        disabled = false, secureCookie = true, ttlSeconds = DEFAULT_TTL_SECONDS,
        sessions = new OperatorSessionStore({ ttlSeconds }) } = {}) {
        this.username = normalizeCredential(username, 120);
        this.password = normalizeCredential(password);
        const verifierInput = normalizeCredential(passwordScrypt, 4096);
        this.passwordScrypt = parseScryptVerifier(verifierInput);
        this.disabled = disabled === true;
        this.secureCookie = secureCookie !== false;
        this.cookieName = this.secureCookie ? COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
        this.sessions = sessions;
        const hasPassword = Boolean(this.password);
        const hasVerifier = Boolean(verifierInput);
        this.configured = this.disabled || Boolean(this.username &&
            hasPassword !== hasVerifier && (hasPassword
                ? this.password.length >= 12 : Boolean(this.passwordScrypt)));
    }

    static fromEnvironment(environment = process.env) {
        const disabled = parseBoolean(environment.LIVEZONE_OPERATOR_AUTH_DISABLED, false,
            "LIVEZONE_OPERATOR_AUTH_DISABLED");
        if (disabled && !["127.0.0.1", "localhost", "::1"].includes(
            environment.LIVEZONE_HTTP_HOST)) {
            throw new TypeError("Disabled operator authentication requires an explicit loopback HTTP host.");
        }
        return new OperatorAuth({
            username: environment.LIVEZONE_OPERATOR_USERNAME,
            password: environment.LIVEZONE_OPERATOR_PASSWORD,
            passwordScrypt: environment.LIVEZONE_OPERATOR_PASSWORD_SCRYPT,
            disabled,
            secureCookie: parseBoolean(environment.LIVEZONE_OPERATOR_COOKIE_SECURE, true,
                "LIVEZONE_OPERATOR_COOKIE_SECURE"),
            ttlSeconds: parseTtl(environment.LIVEZONE_OPERATOR_SESSION_TTL_SECONDS)
        });
    }

    authenticate(username, password) {
        if (this.disabled) return this.sessions.create();
        if (!this.configured || !safeEqual(normalizeCredential(username, 120), this.username) ||
            !this.verifyPassword(normalizeCredential(password))) return null;
        return this.sessions.create();
    }

    verifyPassword(value) {
        if (this.passwordScrypt) {
            const { cost, blockSize, parallelization, salt, digest } = this.passwordScrypt;
            try {
                const candidate = scryptSync(value, salt, digest.length,
                    { N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024 });
                return timingSafeEqual(candidate, digest);
            }
            catch { return false; }
        }
        return safeEqual(value, this.password);
    }

    sessionFromRequest(request) {
        if (this.disabled) return Object.freeze({ id: null, csrfToken: null,
            expiresAt: Number.MAX_SAFE_INTEGER, developmentBypass: true });
        return this.sessions.get(parseCookies(request.headers.cookie).get(this.cookieName));
    }

    createCookie(session) {
        const attributes = [`${this.cookieName}=${encodeURIComponent(session.id)}`,
            "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${Math.floor(this.sessions.ttlMs / 1000)}`];
        if (this.secureCookie) attributes.push("Secure");
        return attributes.join("; ");
    }

    clearCookie() {
        const attributes = [`${this.cookieName}=`, "HttpOnly", "SameSite=Strict", "Path=/",
            "Max-Age=0"];
        if (this.secureCookie) attributes.push("Secure");
        return attributes.join("; ");
    }
}

export { COOKIE_NAME, DEFAULT_TTL_SECONDS };

function normalizeCredential(value, maximum = 1024) {
    return typeof value === "string" && value.length <= maximum ? value : "";
}

function safeEqual(left, right) {
    const a = Buffer.from(left); const b = Buffer.from(right);
    const size = Math.max(a.length, b.length, 1);
    const paddedA = Buffer.alloc(size); const paddedB = Buffer.alloc(size);
    a.copy(paddedA); b.copy(paddedB);
    return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function parseCookies(header) {
    const result = new Map();
    String(header || "").split(";").forEach((part) => {
        const index = part.indexOf("=");
        if (index < 1) return;
        try { result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())); }
        catch { /* Malformed cookies are ignored. */ }
    });
    return result;
}

function parseBoolean(value, fallback, name) {
    if (value === undefined || value === "") return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new TypeError(`${name} must be true or false.`);
}

function parseTtl(value) {
    if (value === undefined || value === "") return DEFAULT_TTL_SECONDS;
    if (!/^\d+$/.test(value)) throw new TypeError(
        "LIVEZONE_OPERATOR_SESSION_TTL_SECONDS must be an integer between 300 and 86400.");
    const ttl = Number(value);
    if (!Number.isSafeInteger(ttl) || ttl < 300 || ttl > 86400) throw new TypeError(
        "LIVEZONE_OPERATOR_SESSION_TTL_SECONDS must be an integer between 300 and 86400.");
    return ttl;
}

function parseScryptVerifier(value) {
    if (!value) return null;
    const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(value);
    if (!match) return null;
    const [cost, blockSize, parallelization] = match.slice(1, 4).map(Number);
    const salt = Buffer.from(match[4], "base64url");
    const digest = Buffer.from(match[5], "base64url");
    if (cost !== 16384 || blockSize !== 8 || parallelization !== 1 ||
        salt.length < 16 || digest.length !== 64) return null;
    return { cost, blockSize, parallelization, salt, digest };
}
