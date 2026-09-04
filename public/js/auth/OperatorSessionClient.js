const SESSION_URL = "/api/operator/session";
const LOGIN_URL = "/login/";
let current = null;

export async function requireOperatorSession() {
    const response = await fetch(SESSION_URL, { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.authenticated) {
        redirectToLogin();
        throw new Error("Operator authentication required");
    }
    current = payload;
    return payload;
}

export async function operatorFetch(url, options = {}) {
    const target = requireSameOrigin(url);
    if (!current?.authenticated) await requireOperatorSession();
    const method = String(options.method || "GET").toUpperCase();
    const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const headers = new Headers(options.headers || {});
    if (mutation) {
        headers.set("X-Livezone-Operator-Request", "1");
        headers.set("X-Livezone-CSRF", current.csrfToken || "");
    }
    const response = await fetch(target.href, { ...options, headers,
        credentials: "same-origin", cache: options.cache || "no-store" });
    if (response.status === 401) {
        current = null;
        redirectToLogin();
    }
    return response;
}

export async function applyOperatorHeaders(xhr, method, url) {
    requireSameOrigin(url);
    if (!current?.authenticated) await requireOperatorSession();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(String(method).toUpperCase())) {
        xhr.setRequestHeader("X-Livezone-Operator-Request", "1");
        xhr.setRequestHeader("X-Livezone-CSRF", current.csrfToken || "");
    }
}

export function requireSameOrigin(value) {
    const location = globalThis.location;
    if (!location?.href || !location?.origin) throw new TypeError("Browser origin is unavailable");
    const target = new URL(value, location.href);
    if (target.origin !== location.origin) throw new TypeError("Cross-origin operator request rejected");
    return target;
}

export async function logoutOperator() {
    const response = await operatorFetch("/api/operator/logout", { method: "POST" });
    if (response.ok) {
        current = null;
        globalThis.location.assign(LOGIN_URL);
    }
    return response.ok;
}

export function redirectToLogin() {
    const path = globalThis.location?.pathname === "/control/schedule/"
        ? "/control/schedule/" : "/control/";
    globalThis.location?.replace(`${LOGIN_URL}?return=${encodeURIComponent(path)}`);
}

export function handleOperatorAuthFailure(status) {
    if (status !== 401) return false;
    current = null;
    redirectToLogin();
    return true;
}
