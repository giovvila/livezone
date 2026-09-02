export function getFiniteAssetDuration(asset) {
    const value = asset?.metadata?.durationSeconds ?? asset?.durationSeconds;
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function formatMediaDuration(value) {
    if (!Number.isFinite(value) || value < 0) return "Unavailable";
    const seconds = Math.ceil(value);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = seconds % 60;
    const tail = [minutes, remainder].map((part) => String(part).padStart(2, "0"));
    return hours > 0
        ? [String(hours).padStart(2, "0"), ...tail].join(":")
        : tail.join(":");
}
