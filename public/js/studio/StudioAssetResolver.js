const KIND_COMPATIBILITY = Object.freeze({
    video: Object.freeze(["video"]),
    audio: Object.freeze(["audio"]),
    image: Object.freeze(["image", "still"])
});

export default class StudioAssetResolver {
    constructor({ legacyLibrary, mediaLibraryManager } = {}) {
        this.legacyLibrary = legacyLibrary;
        this.mediaLibraryManager = mediaLibraryManager;
    }

    resolve(assetId, { expectedKind = null } = {}) {
        const id = typeof assetId === "string" ? assetId.trim() : "";
        if (!id) return this.failure("asset-not-found", id);
        const legacy = this.legacyLibrary?.getAsset?.(id) || null;
        const managed = this.mediaLibraryManager?.getAsset?.(id) || null;
        if (legacy && managed) return this.failure("asset-id-ambiguous", id);
        const asset = managed || legacy;
        if (!asset) return this.failure("asset-not-found", id);
        const acceptedKinds = expectedKind ? KIND_COMPATIBILITY[expectedKind] : null;
        if (acceptedKinds && !acceptedKinds.includes(asset.kind)) {
            return this.failure("asset-kind-mismatch", id, asset.kind);
        }
        const url = this.createHttpUrl(asset.url);
        if (!url) return this.failure("asset-url-invalid", id, asset.kind);
        return Object.freeze({ ok: true, asset: Object.freeze({
            ...asset,
            id,
            url,
            origin: managed ? "managed" : "legacy"
        }) });
    }

    getAsset(assetId, expectedKind = null) {
        const result = this.resolve(assetId, { expectedKind });
        return result.ok ? result.asset : null;
    }

    failure(reason, assetId, actualKind = null) {
        return Object.freeze({ ok: false, reason, assetId, actualKind });
    }

    createHttpUrl(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value.trim(), globalThis.document?.baseURI);
            return ["http:", "https:"].includes(url.protocol) ? url.href : null;
        }
        catch { return null; }
    }
}
