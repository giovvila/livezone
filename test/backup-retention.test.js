import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const retentionScript = path.join(repoRoot, "tools", "backup-retention.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

async function createBackup(root, name, { status = "success", manifest = true } = {}) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, "manifest"), { recursive: true });
    if (manifest) {
        const payload = {
            version: 1,
            status,
            timestamp: name,
            fileCount: 1,
            totalSize: 1,
            hashAlgorithm: "SHA256",
            files: [{ backupPath: "env/.env", size: 1, sha256: "a".repeat(64) }],
        };
        await writeFile(path.join(directory, "manifest", "backup-manifest.json"), JSON.stringify(payload));
    }
    return directory;
}

function runRetention(root, apply = false) {
    const args = ["-NoProfile", "-File", retentionScript, "-BackupRoot", root, "-Json"];
    if (apply) args.push("-ApplyRetention");
    const result = spawnSync(pwsh, args, { encoding: "utf8" });
    return {
        ...result,
        plan: result.status === 0 ? JSON.parse(result.stdout.trim()) : null,
    };
}

async function withFixture(fn) {
    const root = await mkdtemp(path.join(tmpdir(), "livezone-retention-"));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("retention keeps fewer than seven verified backups", () => withFixture(async (root) => {
    for (const day of ["01", "02", "03"]) await createBackup(root, `2026-08-${day}_03-00-00`);
    const { status, plan } = runRetention(root);
    assert.equal(status, 0);
    assert.equal(plan.retentionMode, "DRY_RUN");
    assert.deepEqual(plan.deleteCandidates, []);
}));

test("retention selects seven daily, four ISO weekly, and six monthly points without duplicates", () => withFixture(async (root) => {
    const names = [
        "2026-01-15_03-00-00", "2026-02-15_03-00-00", "2026-03-15_03-00-00",
        "2026-04-15_03-00-00", "2026-05-15_03-00-00", "2026-06-15_03-00-00",
        "2026-07-01_03-00-00", "2026-07-08_03-00-00", "2026-07-15_03-00-00",
        "2026-07-22_03-00-00", "2026-07-29_03-00-00", "2026-08-05_03-00-00",
        "2026-08-12_03-00-00", "2026-08-19_03-00-00", "2026-08-20_03-00-00",
        "2026-08-21_03-00-00", "2026-08-22_03-00-00", "2026-08-23_03-00-00",
        "2026-08-24_03-00-00", "2026-08-25_03-00-00", "2026-08-26_03-00-00",
    ];
    for (const name of names) await createBackup(root, name);
    const { status, plan } = runRetention(root);
    assert.equal(status, 0);
    assert.equal(plan.dailyKeep.length, 7);
    assert.equal(plan.weeklyKeep.length, 4);
    assert.equal(plan.monthlyKeep.length, 6);
    assert.equal(new Set(plan.finalKeep).size, plan.finalKeep.length);
    assert.equal(plan.lastKnownGood, "2026-08-26_03-00-00");
    assert(plan.finalKeep.includes(plan.lastKnownGood));
    assert(plan.weekConvention === "ISO-8601");
}));

test("invalid newest, malformed, missing-manifest, and failed directories are protected", () => withFixture(async (root) => {
    await createBackup(root, "2026-08-29_03-00-00");
    await createBackup(root, "2026-08-30_03-00-00", { status: "failed" });
    await createBackup(root, "2026-08-31_03-00-00", { manifest: false });
    await mkdir(path.join(root, "notes"));
    const { status, plan } = runRetention(root);
    assert.equal(status, 0);
    assert.equal(plan.lastKnownGood, "2026-08-29_03-00-00");
    assert.deepEqual(new Set(plan.unknownOrProtected), new Set([
        "2026-08-30_03-00-00", "2026-08-31_03-00-00", "notes",
    ]));
    assert.deepEqual(plan.deleteCandidates, []);
}));

test("calculation failure fails closed with zero deletions", () => withFixture(async (root) => {
    await mkdir(path.join(root, "unknown"));
    const result = runRetention(root, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed closed/i);
    assert.equal(await readFile(path.join(root, "unknown")).catch(() => null), null);
}));

test("apply recalculates and deletes only eligible candidates in a temporary fixture", () => withFixture(async (root) => {
    const names = [];
    for (let month = 1; month <= 8; month += 1) {
        for (const day of [1, 8, 15, 22]) {
            const name = `2025-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}_03-00-00`;
            names.push(name);
            await createBackup(root, name);
        }
    }
    await mkdir(path.join(root, "..escape-attempt"));
    const dryRun = runRetention(root);
    assert.equal(dryRun.status, 0);
    assert(dryRun.plan.deleteCandidates.length > 0);
    const applied = runRetention(root, true);
    assert.equal(applied.status, 0);
    assert.deepEqual(new Set(applied.plan.deleted), new Set(dryRun.plan.deleteCandidates));
    assert.equal(applied.plan.deleted.includes(applied.plan.lastKnownGood), false);
    assert.equal(applied.plan.unknownOrProtected.includes("..escape-attempt"), true);
}));
