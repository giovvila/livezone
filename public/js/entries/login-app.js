const form = document.getElementById("operator-login-form");
const status = document.getElementById("operator-login-status");
const button = document.getElementById("operator-login-submit");

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "AUTHENTICATING…";
    const returnTo = safeReturn(new URLSearchParams(location.search).get("return"));
    try {
        const response = await fetch("/api/operator/login", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json",
                "X-Livezone-Operator-Request": "1" },
            body: JSON.stringify({ username: form.elements.username.value,
                password: form.elements.password.value, returnTo })
        });
        const payload = await response.json().catch(() => null);
        form.elements.password.value = "";
        if (!response.ok || !payload?.authenticated) {
            status.textContent = response.status === 503
                ? "OPERATOR AUTHENTICATION UNAVAILABLE" : "INVALID CREDENTIALS";
            button.disabled = false;
            return;
        }
        location.replace(safeReturn(payload.returnTo));
    }
    catch {
        form.elements.password.value = "";
        status.textContent = "AUTHENTICATION UNAVAILABLE";
        button.disabled = false;
    }
});

function safeReturn(value) {
    return ["/control/", "/control/schedule/"].includes(value) ? value : "/control/";
}
