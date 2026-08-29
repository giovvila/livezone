import LocalProgramOutputTransport from "./LocalProgramOutputTransport.js";
import NetworkProgramOutputTransport from "./NetworkProgramOutputTransport.js";

const CONFIG_URL = new URL("../../config/program-output.json", import.meta.url);
export const PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY =
    "livezone.programOutput.token";

export async function createProgramOutputTransport({
    role,
    configUrl = CONFIG_URL,
    tokenProvider = null,
    fetchImplementation,
    eventSourceFactory,
    baseUrl
} = {}) {
    const config = await loadConfig(configUrl);
    if (config.mode === "local") return new LocalProgramOutputTransport();
    return new NetworkProgramOutputTransport({
        role,
        publishUrl: config.network.publishUrl,
        subscribeUrl: config.network.subscribeUrl,
        tokenProvider: role === "publisher"
            ? tokenProvider || readPublisherToken
            : null,
        fetchImplementation,
        eventSourceFactory,
        baseUrl
    });
}

export async function loadProgramOutputConfig(configUrl = CONFIG_URL) {
    return loadConfig(configUrl);
}

async function loadConfig(configUrl) {
    const response = await fetch(configUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Program Output configuration unavailable");
    const value = await response.json();
    if (!value || value.version !== 1 || !["local", "network"].includes(value.mode) ||
        !value.network || typeof value.network.publishUrl !== "string" ||
        typeof value.network.subscribeUrl !== "string") {
        throw new Error("Invalid Program Output configuration");
    }
    return Object.freeze({
        version: 1,
        mode: value.mode,
        network: Object.freeze({
            publishUrl: value.network.publishUrl,
            subscribeUrl: value.network.subscribeUrl
        })
    });
}

export function readPublisherToken() {
    return readPersistentPublisherToken();
}

export function readPersistentPublisherToken({
    persistentStorage = getBrowserStorage("localStorage"),
    legacyStorage = getBrowserStorage("sessionStorage")
} = {}) {
    const persistent = readStorageToken(persistentStorage);
    if (persistent) return persistent;
    const legacy = readStorageToken(legacyStorage);
    if (!legacy) return "";
    try {
        persistentStorage?.setItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY, legacy);
        if (readStorageToken(persistentStorage) === legacy) {
            legacyStorage?.removeItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY);
        }
    }
    catch { /* Legacy session token remains usable when persistence is denied. */ }
    return legacy;
}

function readStorageToken(storage) {
    try {
        const value = storage?.getItem(PROGRAM_OUTPUT_PUBLISHER_TOKEN_KEY);
        return typeof value === "string" ? value.trim() : "";
    }
    catch { return ""; }
}

function getBrowserStorage(name) {
    try { return globalThis[name]; }
    catch { return null; }
}
