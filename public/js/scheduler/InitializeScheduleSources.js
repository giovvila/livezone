// Match Control Room's technical source configuration before catalog registration.
export default async function initializeScheduleSources(sourceManager, {
    fetchImplementation = globalThis.fetch,
    configUrl = new URL("../../config/config.json", import.meta.url)
} = {}) {
    const response = await fetchImplementation(configUrl);
    if (!response.ok) throw new Error("Schedule source configuration unavailable");
    sourceManager.initialize(await response.json());
}
