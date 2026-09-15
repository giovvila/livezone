import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, stat, open, lstat } from "node:fs/promises";
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
    constructor({ root, uuidFactory = randomUUID, clock = () => new Date().toISOString(),fileOperations={} } = {}) {
        if (!root) throw new TypeError("MediaAssetRepository requires a storage root.");
        this.root = resolve(root);
        this.filesRoot = join(this.root, "files");
        this.tempRoot = join(this.root, ".tmp");
        this.manifestPath = join(this.root, "assets.json");
        this.deleteJournalPath = join(this.root, 'delete-journal.json');
        this.uuidFactory = uuidFactory;
        this.clock = clock;
        this.assets = new Map();
        this.queue = Promise.resolve();
        this.deleteFs={rename,unlink,lstat,...fileOperations};
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
        await this.recoverDelete();
        return this.list();
    }

    list({ kind = null } = {}) {
        return Object.freeze(Array.from(this.assets.values()).filter((asset) => !kind || asset.kind === kind).map((asset) => this.snapshot(asset)));
    }

    get(id) {
        return ID_PATTERN.test(String(id || "")) && this.assets.has(id) ? this.snapshot(this.assets.get(id)) : null;
    }

    async updateMetadata(id, metadata) {
        return this.serialize(async () => {
            if (!ID_PATTERN.test(String(id || ""))) {
                throw this.error("ASSET_ID_INVALID", "Asset ID is invalid.");
            }
            const current = this.assets.get(id);
            if (!current) throw this.error("ASSET_NOT_FOUND", "Asset was not found.");
            const normalized = this.validateMetadata(metadata, current.kind);
            const updated = Object.freeze({ ...current, metadata: normalized,
                updatedAt: this.clock() });
            this.assets.set(id, updated);
            try { await this.writeManifest(); }
            catch (error) { this.assets.set(id, current); throw error; }
            return this.snapshot(updated);
        });
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

    async delete(id, { isReferenced } = {}) {
        return this.serialize(async () => {
            if (!ID_PATTERN.test(String(id || ""))) throw this.error("ASSET_ID_INVALID", "Asset ID is invalid.");
            const asset = this.assets.get(id);
            if (!asset) throw this.error("ASSET_NOT_FOUND", "Asset was not found.");
            if ([...this.assets.values()].some(other => other.id !== id && other.url === asset.url))
                throw this.error('FILE_OWNERSHIP_CONFLICT', 'Managed file has multiple metadata owners.');
            if(this.deleteRecoveryRequired)throw this.error('DELETE_RECOVERY_REQUIRED','Media deletion requires recovery.');
            if(typeof isReferenced!=='function')throw this.error('REFERENCE_GUARD_REQUIRED','Complete reference audit is required.');
            if (await isReferenced(this.snapshot(asset))) throw this.error("ASSET_REFERENCED", "Asset is referenced and cannot be deleted.");
            const path = this.safeFilePath(asset.kind, asset.storedName);
            // Reject junctions/symlinks in the owned delete path, not only lexical traversal.
            for(const owned of [this.root,this.filesRoot,join(this.filesRoot,asset.kind),this.tempRoot,path]) {
                if((await this.deleteFs.lstat(owned)).isSymbolicLink())throw this.error('PATH_INVALID','Managed path is a link.');
            }
            const quarantine = join(this.tempRoot, `delete-${randomUUID()}.tmp`);
            await this.writeDeleteJournal({ version: 1, asset, quarantine: basename(quarantine) });
            try { await this.deleteFs.rename(path, quarantine); }
            catch (error) { await this.clearDeleteJournal(); throw error; }
            this.assets.delete(id);
            try { await this.writeManifest(); }
            catch (error) {
                this.assets.set(id, asset);
                try{await this.deleteFs.rename(quarantine,path);}catch{this.deleteRecoveryRequired=true;throw this.error('DELETE_RECOVERY_REQUIRED','Managed file restore failed.');}
                await this.clearDeleteJournal();
                throw error;
            }
            try {await this.deleteFs.unlink(quarantine);}
            catch {
                this.assets.set(id,asset);
                try {await this.deleteFs.rename(quarantine,path);await this.writeManifest();}
                catch {this.deleteRecoveryRequired=true;throw this.error('DELETE_RECOVERY_REQUIRED','Media deletion rollback failed.');}
                await this.clearDeleteJournal();
                throw this.error('ASSET_DELETE_FAILED','Media deletion failed; asset was restored.');
            }
            await this.clearDeleteJournal();
            return this.snapshot(asset);
        });
    }

    async writeDeleteJournal(value) {
        let handle;
        try { handle = await open(this.deleteJournalPath, 'wx');
            await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
        catch (error) { this.deleteRecoveryRequired = true; throw error; }
        finally { await handle?.close(); }
    }

    async clearDeleteJournal() {
        try { await unlink(this.deleteJournalPath); }
        catch (error) { if (error.code !== 'ENOENT') {
            this.deleteRecoveryRequired = true;
            throw this.error('DELETE_RECOVERY_REQUIRED', 'Media deletion journal requires recovery.');
        } }
    }

    async recoverDelete() {
        let journal;
        try { journal = JSON.parse(await readFile(this.deleteJournalPath, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return;
            this.deleteRecoveryRequired = true;
            throw this.error('DELETE_RECOVERY_REQUIRED', 'Invalid deletion journal.'); }
        const asset = this.validateAsset(journal?.asset);
        if (journal.version !== 1 || !asset || !/^delete-[0-9a-f-]{36}\.tmp$/.test(journal.quarantine)) {
            this.deleteRecoveryRequired = true;
            throw this.error('DELETE_RECOVERY_REQUIRED', 'Invalid deletion journal.');
        }
        const target = this.safeFilePath(asset.kind, asset.storedName);
        const quarantine = join(this.tempRoot, journal.quarantine);
        const info = async path => { try { return await this.deleteFs.lstat(path); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
        try {
            for (const owned of [this.root, this.filesRoot, join(this.filesRoot, asset.kind), this.tempRoot]) {
                if ((await info(owned))?.isSymbolicLink()) throw new Error('link');
            }
            const original = await info(target), held = await info(quarantine);
            if (original?.isSymbolicLink() || held?.isSymbolicLink() || original && held) throw new Error('ambiguous');
            if (held) await this.deleteFs.rename(quarantine, target);
            if (held || original) {
                // Recovery prefers retaining the asset. Never finish an uncommitted delete.
                this.assets.set(asset.id, asset);
                await this.writeManifest();
            }
            else if (this.assets.has(asset.id)) throw new Error('missing');
            // Neither file nor metadata: unlink committed before the process stopped.
            await this.clearDeleteJournal();
        }
        catch {
            this.deleteRecoveryRequired = true;
            throw this.error('DELETE_RECOVERY_REQUIRED', 'Media deletion requires recovery.');
        }
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
        const metadata = this.validateMetadata(value.metadata ?? null, value.kind, false);
        if (metadata === undefined) return null;
        return Object.freeze({ ...value, metadata });
    }

    validateMetadata(value, kind, throwOnInvalid = true) {
        const invalid = () => {
            if (throwOnInvalid) {
                throw this.error("ASSET_METADATA_INVALID", "Asset metadata is invalid.");
            }
            return undefined;
        };
        if (value === null) return null;
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype ||
            Object.keys(value).length !== 1 ||
            !Object.hasOwn(value, "durationSeconds") ||
            !["video", "audio"].includes(kind)) return invalid();
        const durationSeconds = value.durationSeconds;
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return invalid();
        return Object.freeze({ durationSeconds });
    }

    snapshot(asset) { return Object.freeze({ ...asset, metadata: asset.metadata && Object.freeze({ ...asset.metadata }) }); }
    serialize(operation) { const coordinated = () => this.mutationCoordinator ? this.mutationCoordinator.run(operation) : operation(); const next = this.queue.then(coordinated, coordinated); this.queue = next.catch(() => {}); return next; }
    async writeManifest() {
        const temp = `${this.manifestPath}.${randomUUID()}.tmp`;
        let handle;
        try { handle = await open(temp, 'wx');
            await handle.writeFile(`${JSON.stringify({ version: VERSION, assets: Array.from(this.assets.values()) }, null, 2)}\n`);
            await handle.sync(); }
        catch (error) { await handle?.close(); handle = null; await unlink(temp).catch(() => {}); throw error; }
        finally { await handle?.close(); }
        await rename(temp, this.manifestPath).catch(async (error) => { await unlink(temp).catch(() => {}); throw error; });
    }
    error(code, message) { const error = new Error(message); error.code = code; return error; }
}

export { ID_PATTERN, TYPES };
