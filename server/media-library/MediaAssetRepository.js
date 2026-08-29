import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, stat, open } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const VERSION = 1;
const ID_PATTERN = /^asset-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = Object.freeze({
    ".mp4": { kind: "video", mimeType: "video/mp4", signature: (b) => b.length >= 12 && b.subarray(4, 8).toString() === "ftyp" },
    ".mp3": { kind: "audio", mimeType: "audio/mpeg", signature: (b) => b.subarray(0, 3).toString() === "ID3" || b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
    ".jpg": { kind: "image", mimeType: "image/jpeg", signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    ".jpeg": { kind: "image", mimeType: "image/jpeg", signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    ".png": { kind: "image", mimeType: "image/png", signature: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
    ".webp": { kind: "image", mimeType: "image/webp", signature: (b) => b.length >= 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" }
});

export default class MediaAssetRepository {
    constructor({ root, uuidFactory = randomUUID, clock = () => new Date().toISOString() } = {}) {
        if (!root) throw new TypeError("MediaAssetRepository requires a storage root.");
        this.root = resolve(root);
        this.filesRoot = join(this.root, "files");
        this.tempRoot = join(this.root, ".tmp");
        this.manifestPath = join(this.root, "assets.json");
        this.uuidFactory = uuidFactory;
        this.clock = clock;
        this.assets = new Map();
        this.queue = Promise.resolve();
    }

    async initialize() {
        await Promise.all([mkdir(this.tempRoot, { recursive: true }), ...["video", "audio", "image"].map((kind) => mkdir(join(this.filesRoot, kind), { recursive: true }))]);
        try {
            const parsed = JSON.parse(await readFile(this.manifestPath, "utf8"));
            if (parsed?.version !== VERSION || !Array.isArray(parsed.assets)) throw this.error("MANIFEST_INVALID", "Media manifest is invalid.");
            for (const candidate of parsed.assets) {
                const asset = this.validateAsset(candidate);
                if (!asset || this.assets.has(asset.id)) throw this.error("MANIFEST_INVALID", "Media manifest contains invalid assets.");
                this.assets.set(asset.id, asset);
            }
        }
        catch (error) {
            if (error?.code !== "ENOENT") throw error;
            await this.writeManifest();
        }
        return this.list();
    }

    list({ kind = null } = {}) {
        return Object.freeze(Array.from(this.assets.values()).filter((asset) => !kind || asset.kind === kind).map((asset) => this.snapshot(asset)));
    }

    get(id) {
        return ID_PATTERN.test(String(id || "")) && this.assets.has(id) ? this.snapshot(this.assets.get(id)) : null;
    }

    async importTempFile({ tempPath, originalName, mimeType, size }) {
        return this.serialize(async () => {
            this.validateOriginalName(originalName);
            const extension = extname(originalName).toLowerCase();
            const contract = TYPES[extension];
            if (!contract) throw this.error("UNSUPPORTED_TYPE", "File extension is not supported.");
            if (contract.mimeType !== mimeType) throw this.error("MIME_MISMATCH", "Declared MIME does not match extension.");
            const info = await stat(tempPath);
            if (!info.isFile() || info.size !== size) throw this.error("UPLOAD_INVALID", "Uploaded file is incomplete.");
            const handle = await open(tempPath, "r");
            const signature = Buffer.alloc(16);
            const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
            await handle.close();
            if (!contract.signature(signature.subarray(0, bytesRead))) throw this.error("SIGNATURE_MISMATCH", "File signature is invalid.");
            const id = `asset-${this.uuidFactory()}`;
            if (!ID_PATTERN.test(id) || this.assets.has(id)) throw this.error("ID_COLLISION", "Could not allocate asset ID.");
            const storedName = `${id.slice(6)}${extension === ".jpeg" ? ".jpg" : extension}`;
            const target = this.safeFilePath(contract.kind, storedName);
            try { await stat(target); throw this.error("FILE_EXISTS", "Managed file already exists."); }
            catch (error) { if (error?.code !== "ENOENT") throw error; }
            const now = this.clock();
            const asset = Object.freeze({ version: VERSION, id, kind: contract.kind, originalName, storedName,
                url: `/media-library/files/${contract.kind}/${storedName}`, mimeType: contract.mimeType,
                size, createdAt: now, updatedAt: now, metadata: null });
            await rename(tempPath, target);
            this.assets.set(id, asset);
            try { await this.writeManifest(); }
            catch (error) { this.assets.delete(id); await unlink(target).catch(() => {}); throw error; }
            return this.snapshot(asset);
        });
    }

    async delete(id, { isReferenced = () => false } = {}) {
        return this.serialize(async () => {
            if (!ID_PATTERN.test(String(id || ""))) throw this.error("ASSET_ID_INVALID", "Asset ID is invalid.");
            const asset = this.assets.get(id);
            if (!asset) throw this.error("ASSET_NOT_FOUND", "Asset was not found.");
            if (await isReferenced(this.snapshot(asset))) throw this.error("ASSET_REFERENCED", "Asset is referenced and cannot be deleted.");
            const path = this.safeFilePath(asset.kind, asset.storedName);
            const quarantine = join(this.tempRoot, `delete-${randomUUID()}.tmp`);
            await rename(path, quarantine);
            this.assets.delete(id);
            try { await this.writeManifest(); }
            catch (error) {
                this.assets.set(id, asset);
                await rename(quarantine, path).catch(() => {});
                throw error;
            }
            await unlink(quarantine).catch(() => {});
            return this.snapshot(asset);
        });
    }

    safeFilePath(kind, storedName) {
        if (!Object.values(TYPES).some((type) => type.kind === kind) || basename(storedName) !== storedName || /[\\/:]|\.\./.test(storedName)) {
            throw this.error("PATH_INVALID", "Managed path is invalid.");
        }
        const target = resolve(join(this.filesRoot, kind, storedName));
        const rel = relative(this.filesRoot, target);
        if (!rel || rel.startsWith("..") || rel.includes(":")) throw this.error("PATH_INVALID", "Managed path escapes storage root.");
        return target;
    }

    validateOriginalName(value) {
        if (typeof value !== "string" || !value || value !== basename(value) || /[\\/:]|\.\./.test(value)) {
            throw this.error("CLIENT_PATH_REJECTED", "Original filename must not contain a path.");
        }
    }

    validateAsset(value) {
        const type = value && TYPES[extname(value.storedName || "").toLowerCase()];
        if (!value || value.version !== VERSION || !ID_PATTERN.test(value.id) || !type || type.kind !== value.kind ||
            type.mimeType !== value.mimeType || typeof value.originalName !== "string" ||
            value.url !== `/media-library/files/${value.kind}/${value.storedName}` ||
            !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.createdAt !== "string" ||
            typeof value.updatedAt !== "string") return null;
        try { this.safeFilePath(value.kind, value.storedName); }
        catch { return null; }
        return Object.freeze({ ...value, metadata: value.metadata ?? null });
    }

    snapshot(asset) { return Object.freeze({ ...asset, metadata: asset.metadata && Object.freeze({ ...asset.metadata }) }); }
    serialize(operation) { const next = this.queue.then(operation, operation); this.queue = next.catch(() => {}); return next; }
    async writeManifest() {
        const temp = `${this.manifestPath}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify({ version: VERSION, assets: Array.from(this.assets.values()) }, null, 2)}\n`, { flag: "wx" });
        await rename(temp, this.manifestPath).catch(async (error) => { await unlink(temp).catch(() => {}); throw error; });
    }
    error(code, message) { const error = new Error(message); error.code = code; return error; }
}

export { ID_PATTERN, TYPES };
