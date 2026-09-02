import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import MediaAssetRepository from "../server/media-library/MediaAssetRepository.js";
import { createProgramOutputServer } from "../server/program-output-server.js";
import MediaLibraryManager from "../public/js/media-library/MediaLibraryManager.js";
import MediaLibraryUI from "../public/js/ui/MediaLibraryUI.js";

const fixtures = {
    mp4: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(8)]),
    mp3: Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00audio"),
    jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
    png: Buffer.from([137,80,78,71,13,10,26,10,0]),
    webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])
};

async function withRoot(operation) { const root = await mkdtemp(join(tmpdir(), "livezone-media-")); try { return await operation(root); } finally { await rm(root, { recursive: true, force: true }); } }

async function importFixture(repository, root, { name, mime, bytes }) {
    const path = join(root, `.upload-${Math.random()}`); await writeFile(path, bytes);
    return repository.importTempFile({ tempPath: path, originalName: name, mimeType: mime, size: bytes.length });
}

for (const [extension, mime, kind] of [["mp4","video/mp4","video"],["mp3","audio/mpeg","audio"],["jpg","image/jpeg","image"],["png","image/png","image"],["webp","image/webp","image"]]) {
    test(`repository imports ${extension.toUpperCase()} with stable managed contract`, () => withRoot(async (root) => {
        const repository = new MediaAssetRepository({ root }); await repository.initialize();
        const asset = await importFixture(repository, root, { name: `operator.${extension}`, mime, bytes: fixtures[extension] });
        assert.match(asset.id, /^asset-/); assert.equal(asset.kind, kind); assert.equal(asset.mimeType, mime);
        assert.notEqual(asset.storedName, asset.originalName); assert.equal(asset.url.includes(root), false);
        assert.equal((await readFile(join(root, "assets.json"), "utf8")).includes(asset.id), true);
    }));
}

test("duplicate original names receive different IDs and stored files", () => withRoot(async (root) => {
    let serial = 0; const repository = new MediaAssetRepository({ root, uuidFactory: () => `00000000-0000-4000-8000-${String(++serial).padStart(12,"0")}` }); await repository.initialize();
    const a = await importFixture(repository, root, { name: "same.mp4", mime: "video/mp4", bytes: fixtures.mp4 });
    const b = await importFixture(repository, root, { name: "same.mp4", mime: "video/mp4", bytes: fixtures.mp4 });
    assert.notEqual(a.id, b.id); assert.notEqual(a.storedName, b.storedName);
}));

test("manifest restores list, get and kind filters", () => withRoot(async (root) => {
    const first = new MediaAssetRepository({ root }); await first.initialize();
    const asset = await importFixture(first, root, { name: "x.mp3", mime: "audio/mpeg", bytes: fixtures.mp3 });
    const second = new MediaAssetRepository({ root }); await second.initialize();
    assert.equal(second.get(asset.id).id, asset.id); assert.equal(second.list({ kind: "audio" }).length, 1); assert.equal(second.list({ kind: "video" }).length, 0);
}));

test("finite VIDEO and AUDIO duration metadata persists while null remains valid", () => withRoot(async (root) => {
    const repository = new MediaAssetRepository({ root }); await repository.initialize();
    const video = await importFixture(repository, root, { name: "x.mp4",
        mime: "video/mp4", bytes: fixtures.mp4 });
    const audio = await importFixture(repository, root, { name: "x.mp3",
        mime: "audio/mpeg", bytes: fixtures.mp3 });
    assert.equal(video.metadata, null); assert.equal(audio.metadata, null);
    await repository.updateMetadata(video.id, { durationSeconds: 33.8 });
    await repository.updateMetadata(audio.id, { durationSeconds: 222.25 });
    const restored = new MediaAssetRepository({ root }); await restored.initialize();
    assert.equal(restored.get(video.id).metadata.durationSeconds, 33.8);
    assert.equal(restored.get(audio.id).metadata.durationSeconds, 222.25);
}));

test("long decimal media duration remains valid metadata", () => withRoot(async (root) => {
    const repository = new MediaAssetRepository({ root }); await repository.initialize();
    const audio = await importFixture(repository, root, { name: "long.mp3",
        mime: "audio/mpeg", bytes: fixtures.mp3 });
    const updated = await repository.updateMetadata(audio.id,
        { durationSeconds: 43140.005465 });
    assert.equal(updated.metadata.durationSeconds, 43140.005465);
    const restored = new MediaAssetRepository({ root }); await restored.initialize();
    assert.equal(restored.get(audio.id).metadata.durationSeconds, 43140.005465);
}));

test("duration metadata rejects invalid values and non-timeline IMAGE assets", () => withRoot(async (root) => {
    const repository = new MediaAssetRepository({ root }); await repository.initialize();
    const video = await importFixture(repository, root, { name: "x.mp4",
        mime: "video/mp4", bytes: fixtures.mp4 });
    const image = await importFixture(repository, root, { name: "x.png",
        mime: "image/png", bytes: fixtures.png });
    for (const durationSeconds of [0, -1, Infinity, NaN, "22"]) {
        await assert.rejects(repository.updateMetadata(video.id, { durationSeconds }),
            { code: "ASSET_METADATA_INVALID" });
    }
    await assert.rejects(repository.updateMetadata(image.id, { durationSeconds: 22 }),
        { code: "ASSET_METADATA_INVALID" });
    assert.equal(repository.get(image.id).metadata, null);
}));

test("extension, MIME, signature and client paths are independently rejected", () => withRoot(async (root) => {
    const repository = new MediaAssetRepository({ root }); await repository.initialize();
    for (const candidate of [
        { name: "x.svg", mime: "image/svg+xml", bytes: Buffer.from("<svg") , code: "UNSUPPORTED_TYPE" },
        { name: "x.png", mime: "image/jpeg", bytes: fixtures.png, code: "MIME_MISMATCH" },
        { name: "x.png", mime: "image/png", bytes: Buffer.from("bad"), code: "SIGNATURE_MISMATCH" },
        { name: "../x.png", mime: "image/png", bytes: fixtures.png, code: "CLIENT_PATH_REJECTED" },
        { name: "C:\\x.png", mime: "image/png", bytes: fixtures.png, code: "CLIENT_PATH_REJECTED" }
    ]) await assert.rejects(importFixture(repository, root, candidate), (error) => error.code === candidate.code);
}));

test("safe delete honors reference guard and reconstructs path from manifest", () => withRoot(async (root) => {
    const repository = new MediaAssetRepository({ root }); await repository.initialize();
    const asset = await importFixture(repository, root, { name: "x.png", mime: "image/png", bytes: fixtures.png });
    await assert.rejects(repository.delete(asset.id, { isReferenced: () => true }), { code: "ASSET_REFERENCED" });
    await repository.delete(asset.id); assert.equal(repository.get(asset.id), null);
    await assert.rejects(repository.delete("../../x"), { code: "ASSET_ID_INVALID" });
}));

test("malformed manifest is rejected instead of becoming authority", () => withRoot(async (root) => {
    await writeFile(join(root, "assets.json"), JSON.stringify({ version: 99, assets: [] }));
    const repository = new MediaAssetRepository({ root });
    await assert.rejects(repository.initialize(), { code: "MANIFEST_INVALID" });
}));

test("manifest failure rolls imported file and in-memory asset back", () => withRoot(async (root) => {
    class FailingRepository extends MediaAssetRepository { async writeManifest() { if (this.fail) throw Object.assign(new Error("disk"), { code: "MANIFEST_WRITE_FAILED" }); return super.writeManifest(); } }
    const repository = new FailingRepository({ root }); await repository.initialize(); repository.fail = true;
    await assert.rejects(importFixture(repository, root, { name: "x.png", mime: "image/png", bytes: fixtures.png }), { code: "MANIFEST_WRITE_FAILED" });
    assert.equal(repository.list().length, 0); assert.deepEqual(await readdir(join(root, "files", "image")), []);
}));

test("physical delete failure leaves manifest authority unchanged", () => withRoot(async (root) => {
    const repository = new MediaAssetRepository({ root }); await repository.initialize();
    const asset = await importFixture(repository, root, { name: "x.png", mime: "image/png", bytes: fixtures.png });
    await rm(repository.safeFilePath(asset.kind, asset.storedName));
    await assert.rejects(repository.delete(asset.id), { code: "ENOENT" }); assert.equal(repository.get(asset.id).id, asset.id);
}));

async function withServer(operation, options = {}) { return withRoot(async (root) => { const repository = new MediaAssetRepository({ root }); const { server } = createProgramOutputServer({ publisherToken: "0123456789abcdef", mediaAssetRepository: repository, ...options }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`; try { return await operation(base, root); } finally { await new Promise((resolve) => server.close(resolve)); } }); }

test("HTTP upload/list/get/serve/range/delete use structured API", () => withServer(async (base) => {
    const form = new FormData(); form.append("file", new Blob([fixtures.mp4], { type: "video/mp4" }), "clip.mp4");
    const uploaded = await fetch(`${base}/api/media-library/assets`, { method: "POST", body: form });
    assert.equal(uploaded.status, 201); const { asset } = await uploaded.json();
    assert.equal((await fetch(`${base}/api/media-library/assets?kind=video`).then((r) => r.json())).assets.length, 1);
    assert.equal((await fetch(`${base}/api/media-library/assets/${asset.id}`).then((r) => r.json())).asset.id, asset.id);
    const range = await fetch(`${base}${asset.url}`, { headers: { Range: "bytes=4-7" } });
    assert.equal(range.status, 206); assert.equal(range.headers.get("x-content-type-options"), "nosniff"); assert.equal(Buffer.from(await range.arrayBuffer()).toString(), "ftyp");
    assert.equal((await fetch(`${base}/api/media-library/assets/${asset.id}`, { method: "DELETE" })).status, 200);
}));

test("HTTP metadata update exposes persisted finite duration", () => withServer(async (base) => {
    const form = new FormData(); form.append("file",
        new Blob([fixtures.mp3], { type: "audio/mpeg" }), "clip.mp3");
    const uploaded = await fetch(`${base}/api/media-library/assets`, { method: "POST", body: form });
    const { asset } = await uploaded.json();
    const updated = await fetch(`${base}/api/media-library/assets/${asset.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { durationSeconds: 42.75 } })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).asset.metadata.durationSeconds, 42.75);
    assert.equal((await fetch(`${base}/api/media-library/assets/${asset.id}`)
        .then((response) => response.json())).asset.metadata.durationSeconds, 42.75);
}));

test("HTTP upload limit returns 413 and cleans temporary files", () => withServer(async (base, root) => {
    const form = new FormData(); form.append("file", new Blob([fixtures.mp4], { type: "video/mp4" }), "clip.mp4");
    const response = await fetch(`${base}/api/media-library/assets`, { method: "POST", body: form });
    assert.equal(response.status, 413); assert.equal((await response.json()).error.code, "UPLOAD_TOO_LARGE");
    assert.deepEqual(await readdir(join(root, ".tmp")), []);
}, { mediaLibraryMaxBytes: 8 }));

test("aborted multipart upload cleans its non-public temporary file", () => withServer(async (base, root) => {
    const url = new URL("/api/media-library/assets", base); const boundary = "livezone-abort-boundary";
    await new Promise((resolve) => {
        const request = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
        request.on("error", resolve);
        request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
        request.write(fixtures.mp4.subarray(0, 8)); request.destroy();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await readdir(join(root, ".tmp")), []);
}));

test("HTTP missing and invalid asset IDs retain structured status semantics", () => withServer(async (base) => {
    const missing = await fetch(`${base}/api/media-library/assets/asset-00000000-0000-4000-8000-000000000099`);
    assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, "ASSET_NOT_FOUND");
    const invalid = await fetch(`${base}/api/media-library/assets/not-an-asset`);
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "ASSET_ID_INVALID");
}));

test("manager snapshots, subscription, progress and guarded deletion", async () => {
    const events = []; const asset = Object.freeze({ id: "asset-00000000-0000-4000-8000-000000000001", kind: "video" });
    const client = { list: async () => ({ assets: [asset] }), import: async (_file, { onProgress }) => { onProgress({ loaded: 1, total: 2, percent: 50 }); return { asset: { ...asset, id: asset.id.replace(/1$/, "2") } }; }, remove: async (id) => ({ asset: { id } }) };
    const manager = new MediaLibraryManager(client); const unsubscribe = manager.subscribe((snapshot) => { assert.equal(Object.isFrozen(snapshot), true); events.push(snapshot.state); });
    await manager.initialize(); await manager.importAsset(Object.assign(new Blob(["x"]), { name: "x.mp4" }));
    await assert.rejects(manager.deleteAsset(asset.id), { code: "REFERENCE_GUARD_REQUIRED" });
    await manager.deleteAsset(asset.id, { referenceGuard: () => false }); unsubscribe();
    assert.ok(events.includes("uploading")); assert.ok(events.length >= 6);
});

test("manager probes imported finite media once and persists its duration", async () => {
    const id = "asset-00000000-0000-4000-8000-000000000001";
    const asset = { id, kind: "audio", url: "/managed.mp3", metadata: null };
    const updates = [];
    const client = { list: async () => ({ assets: [] }),
        import: async () => ({ asset }),
        updateMetadata: async (assetId, metadata) => {
            updates.push({ assetId, metadata });
            return { asset: { ...asset, metadata } };
        } };
    const manager = new MediaLibraryManager(client, { durationProbe: async () => 43140.005465 });
    const result = await manager.importAsset(Object.assign(new Blob(["x"]), { name: "x.mp3" }));
    assert.deepEqual(updates, [{ assetId: id, metadata: { durationSeconds: 43140.005465 } }]);
    assert.equal(result.metadata.durationSeconds, 43140.005465);
    assert.equal(manager.getAsset(id).metadata.durationSeconds, 43140.005465);
    assert.equal((await manager.discoverDuration(result)).metadata.durationSeconds, 43140.005465);
    assert.equal(updates.length, 1);
});

function mediaUiHarness({ stored = null } = {}) {
    const listeners = new Map();
    const element = () => ({ hidden: false, value: "", textContent: "", files: [],
        attributes: new Map(), children: [], classList: { values: new Set(),
            toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); } },
        addEventListener(type, listener) { listeners.set(`${this.id}:${type}`, listener); },
        removeEventListener(type, listener) { if (listeners.get(`${this.id}:${type}`) === listener) listeners.delete(`${this.id}:${type}`); },
        setAttribute(name, value) { this.attributes.set(name, value); },
        replaceChildren(...children) { this.children = children; }
    });
    const elements = Object.fromEntries(["input", "filter", "list", "status", "toggle"].map((name) => {
        const value = element(); value.id = name; return [name, value];
    }));
    const selectors = { "#media-library-input": elements.input, "#media-library-filter": elements.filter,
        "#media-library-list": elements.list, "#media-library-status": elements.status,
        "#media-library-toggle": elements.toggle };
    const root = element(); root.querySelector = (selector) => selectors[selector] || null;
    const values = new Map(stored === null ? [] : [["livezone.control.mediaLibrary.collapsed.v1", stored]]);
    const storage = { getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, value) };
    let subscriber = null; let unsubscribed = false;
    const snapshot = Object.freeze({ state: "ready", error: null, progress: null, assets: Object.freeze([]) });
    const manager = { subscribe(listener) { subscriber = listener; listener(snapshot); return () => { unsubscribed = true; }; },
        initialize: async () => snapshot, getSnapshot: () => snapshot };
    const ui = new MediaLibraryUI(root, manager, { storage });
    return { ui, root, elements, listeners, values, get unsubscribed() { return unsubscribed; } };
}

test("Media Library defaults expanded with visible count and filter", () => {
    const h = mediaUiHarness(); assert.equal(h.ui.start(), true);
    assert.equal(h.elements.list.hidden, false); assert.equal(h.elements.toggle.textContent, "COLLAPSE ▲");
    assert.equal(h.elements.toggle.attributes.get("aria-expanded"), "true");
    assert.equal(h.elements.status.textContent, "0 ASSETS"); assert.ok(h.elements.filter);
});

test("collapse hides rows, releases list space and expand restores them", () => {
    const h = mediaUiHarness(); h.ui.start(); const toggle = h.listeners.get("toggle:click");
    toggle(); assert.equal(h.elements.list.hidden, true); assert.equal(h.root.classList.values.has("is-collapsed"), true);
    assert.equal(h.elements.toggle.textContent, "EXPAND ▼"); assert.equal(h.elements.status.textContent, "0 ASSETS");
    toggle(); assert.equal(h.elements.list.hidden, false); assert.equal(h.elements.toggle.textContent, "COLLAPSE ▲");
});

test("collapsed preference survives reconstruction and malformed values default expanded", () => {
    const first = mediaUiHarness(); first.ui.start(); first.listeners.get("toggle:click")();
    const restored = mediaUiHarness({ stored: first.values.get("livezone.control.mediaLibrary.collapsed.v1") }); restored.ui.start();
    assert.equal(restored.elements.list.hidden, true);
    const malformed = mediaUiHarness({ stored: "maybe" }); malformed.ui.start();
    assert.equal(malformed.elements.list.hidden, false);
});

test("Media Library lifecycle removes upload, filter, toggle and subscription hooks", () => {
    const h = mediaUiHarness(); h.ui.start(); assert.equal(h.listeners.size, 3);
    h.ui.destroy(); assert.equal(h.listeners.size, 0); assert.equal(h.unsubscribed, true);
    h.ui.destroy(); assert.equal(h.listeners.size, 0);
});

test("B1 UI keeps destructive delete disabled and does not create Source or Scene", async () => {
    const ui = await readFile(new URL("../public/js/ui/MediaLibraryUI.js", import.meta.url), "utf8");
    const css = await readFile(new URL("../public/css/studio.css", import.meta.url), "utf8");
    assert.match(ui, /remove\.disabled = true/);
    assert.match(ui, /DELETE · SOURCE INTEGRATION/);
    assert.doesNotMatch(ui, /deleteAsset|data-delete|StudioSourceManager|StudioStateManager|createScene|addSource/);
    assert.match(css, /\.media-library-item__delete:disabled\s*\{[^}]*opacity:\s*0\.42;[^}]*cursor:\s*not-allowed;[^}]*filter:\s*grayscale\(1\);/s);
    assert.match(css, /\.media-library__list\s*\{[^}]*max-height:\s*340px;[^}]*overflow-y:\s*auto;/s);
});
