import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const installScript = join(root, "tools/install-livezone-services.ps1");
const templates = [
    join(root, "ops/windows-services/livezone-node.xml.template"),
    join(root, "ops/windows-services/livezone-mediamtx.xml.template")
];

test("committed service templates are deterministic and contain no secrets", async () => {
    const node = await readFile(templates[0], "utf8");
    const media = await readFile(templates[1], "utf8");
    assert.match(node, /<id>LivezoneNode<\/id>/);
    assert.match(media, /<id>LivezoneMediaMtx<\/id>/);
    assert.match(node, /<workingdirectory>__REPOSITORY_ROOT__<\/workingdirectory>/);
    assert.match(node, /__NODE_EXECUTABLE__/);
    assert.match(media, /__MEDIAMTX_LAUNCHER__/);
    for (const content of [node, media]) {
        assert.doesNotMatch(content, /LIVEZONE_PROGRAM_OUTPUT_TOKEN\s*=/);
        assert.doesNotMatch(content, /LIVEZONE_RTMP_PUBLISH_(?:USER|PASSWORD)\s*=/);
        assert.doesNotMatch(content, /var[\\/]media-library|public[\\/]media/);
        assert.match(content, /<onfailure action="restart" delay="10 sec" \/>/);
        assert.match(content, /<onfailure action="none" \/>/);
        assert.match(content, /<keepFiles>8<\/keepFiles>/);
        assert.match(content, /<hidewindow>true<\/hidewindow>/);
    }
});

test("runtime service definitions and logs are ignored", async () => {
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(ignore, /^\/var\/runtime\/winsw\/\*$/m);
    assert.match(ignore, /^\/var\/log\/livezone\/\*$/m);
});

test("installer uses deterministic WinSW bundled wrapper pairs", async () => {
    const installer = await readFile(installScript, "utf8");
    assert.match(installer, /servicesRuntime = Join-Path \$runtime "services"/);
    assert.match(installer, /LivezoneNode\/LivezoneNode\.exe|"LivezoneNode\.exe"/);
    assert.match(installer, /LivezoneNode\/LivezoneNode\.xml|"LivezoneNode\.xml"/);
    assert.match(installer, /LivezoneMediaMtx\/LivezoneMediaMtx\.exe|"LivezoneMediaMtx\.exe"/);
    assert.match(installer, /LivezoneMediaMtx\/LivezoneMediaMtx\.xml|"LivezoneMediaMtx\.xml"/);
    assert.match(installer, /& \$bundle\.Wrapper install/);
    assert.doesNotMatch(installer, /& \$winSw install/);
    assert.doesNotMatch(installer, /WinSW-x64\.xml/);
});

test("MediaMTX service path retains pinned version 1.20.1", async () => {
    const launcher = await readFile(join(root, "tools/start-mediamtx.ps1"), "utf8");
    assert.match(launcher, /\$pinnedVersion\s*=\s*"1\.20\.1"/);
    const installer = await readFile(installScript, "utf8");
    assert.match(installer, /\$mediaMtxVersion\s*=\s*"1\.20\.1"/);
    assert.match(installer, /\$winSwVersion\s*=\s*"2\.12\.0"/);
});

test("install validation fails closed when WinSW is absent", async () => {
    await withFixture(async (fixture) => {
        const result = runInstaller(fixture, {
            winSw: join(fixture.root, "missing-winsw.exe")
        }, "-ValidateOnly");
        assert.notEqual(result.status, 0);
        assert.match(result.output, /WinSW v2\.12\.0 executable is missing/);
    });
});

test("WinSW metadata normalization accepts only pinned release representations", () => {
    const accepted = [
        "2.12.0",
        "2.12.0.0",
        "2.12.0+eef5bade",
        "2.12.0.0+eef5bade"
    ];
    for (const version of accepted) {
        assert.equal(normalizeWinSWVersion(version), "2.12.0", version);
    }
});

test("WinSW metadata normalization fails closed for wrong or malformed versions", () => {
    const wrong = [
        "2.11.9",
        "2.13.0",
        "3.0.0"
    ];
    for (const version of wrong) {
        assert.notEqual(normalizeWinSWVersion(version), "2.12.0", version);
    }
    const malformed = [
        "2.12.0.1",
        "prefix-2.12.0",
        "2.12.0-suffix",
        "garbage",
        ""
    ];
    for (const version of malformed) {
        assert.equal(normalizeWinSWVersion(version), null, version);
    }
});

test("real WinSW binary validates read-only from executable VersionInfo", async () => {
    await withFixture(async (fixture) => {
        const realWinSW = join(root, "var/runtime/winsw/WinSW-x64.exe");
        const result = runInstaller(fixture, { winSw: realWinSW }, "-ValidateOnly");
        assert.equal(result.status, 0, result.output);
        assert.match(result.output, /Status\s*:\s*VALID/);
        assert.match(result.output, /WinSWVersion\s*:\s*2\.12\.0/);
    });
});

test("install validation fails closed when MediaMTX runtime is absent", async () => {
    await withFixture(async (fixture) => {
        const result = runInstaller(fixture, {
            mediaMtx: join(fixture.root, "missing-mediamtx.exe")
        }, "-ValidateOnly");
        assert.notEqual(result.status, 0);
        assert.match(result.output, /MediaMTX v1\.20\.1 executable is missing/);
    });
});

test("generated Node and MediaMTX configs use safe absolute paths without secrets", async () => {
    await withFixture(async (fixture) => {
        const sourceBefore = await readFile(fixture.winSw);
        const result = runInstaller(fixture, {}, "-GenerateOnly");
        assert.equal(result.status, 0, result.output);
        const nodeRoot = join(fixture.runtime, "services", "LivezoneNode");
        const mediaRoot = join(fixture.runtime, "services", "LivezoneMediaMtx");
        const nodeWrapper = join(nodeRoot, "LivezoneNode.exe");
        const mediaWrapper = join(mediaRoot, "LivezoneMediaMtx.exe");
        const node = await readFile(join(nodeRoot, "LivezoneNode.xml"), "utf8");
        const media = await readFile(join(mediaRoot, "LivezoneMediaMtx.xml"), "utf8");
        assert.deepEqual(await readFile(nodeWrapper), sourceBefore);
        assert.deepEqual(await readFile(mediaWrapper), sourceBefore);
        assert.deepEqual(await readFile(fixture.winSw), sourceBefore);
        await assert.rejects(readFile(join(fixture.runtime, "WinSW-x64.xml")));
        assert.match(node, new RegExp(escapeRegex(process.execPath)));
        assert.match(node, new RegExp(escapeRegex(join(root,
            "server/program-output-server.js"))));
        assert.match(media, new RegExp(escapeRegex(join(root,
            "tools/start-mediamtx.ps1"))));
        for (const content of [node, media, result.output]) {
            assert.equal(content.includes(fixture.programSecret), false);
            assert.equal(content.includes(fixture.publishSecret), false);
            assert.equal(content.includes(fixture.passwordSecret), false);
        }
        assert.doesNotMatch(node + media, /__[A-Z0-9_]+__/);
    });
});

test("bundled service validation fails closed when generated config is missing", async () => {
    await withFixture(async (fixture) => {
        const wrapper = join(fixture.root, "LivezoneNode.exe");
        const config = join(fixture.root, "LivezoneNode.xml");
        await writeFile(wrapper, "wrapper fixture");
        const result = assertBundledServiceFiles(wrapper, config, "LivezoneNode");
        assert.notEqual(result.status, 0);
        assert.match(result.output, /LivezoneNode bundled WinSW configuration is missing/);
    });
});

test("uninstall targets only deterministic LIVEZONE services and deletes no data", async () => {
    const script = await readFile(join(root, "tools/uninstall-livezone-services.ps1"),
        "utf8");
    const ids = Array.from(script.matchAll(/Id\s*=\s*"([^"]+)"/g), (match) => match[1]);
    assert.deepEqual(ids, ["LivezoneNode", "LivezoneMediaMtx"]);
    assert.doesNotMatch(script, /Remove-Item|\.env|media-library|public[\\/]media/);
    assert.match(script, /service\.PathName/);
    assert.match(script, /refusing to remove it/);
    assert.match(script, /& \$target\.Wrapper uninstall/);
    assert.doesNotMatch(script, /& \$winSw uninstall/);
});

test("status distinguishes source WinSW from generated service wrappers", async () => {
    const script = await readFile(join(root, "tools/status-livezone-services.ps1"),
        "utf8");
    assert.match(script, /SourceWinSWPresent/);
    assert.match(script, /WrapperPresent = Test-Path -LiteralPath \$definition\.Wrapper/);
    assert.match(script, /ConfigPresent = Test-Path -LiteralPath \$definition\.Config/);
});

test("explicit service start performs bounded liveness and readiness gates", async () => {
    const script = await readFile(installScript, "utf8");
    assert.match(script, /Wait-HttpReady "http:\/\/127\.0\.0\.1:8080\/healthz" 30/);
    assert.match(script, /Wait-HttpReady "http:\/\/127\.0\.0\.1:8080\/readyz" 10/);
    assert.doesNotMatch(script, /Wait-HttpReady[^\n]*9997/);
});

function runInstaller(fixture, overrides = {}, mode) {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
        installScript, "-RepositoryRoot", root, "-WinSWPath",
        overrides.winSw || fixture.winSw, "-RuntimeRoot", fixture.runtime,
        "-LogDirectory", fixture.logs, "-NodePath", process.execPath,
        "-MediaMtxBinaryPath", overrides.mediaMtx || fixture.mediaMtx,
        "-EnvironmentPath", fixture.environment, "-ServiceIdentity", "LocalSystem",
        mode];
    const result = spawnSync("pwsh", args, { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

async function withFixture(operation) {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "livezone-services-"));
    const fixture = {
        root: fixtureRoot,
        runtime: join(fixtureRoot, "runtime"),
        logs: join(fixtureRoot, "logs"),
        winSw: join(root, "var/runtime/winsw/WinSW-x64.exe"),
        mediaMtx: join(fixtureRoot, "mediamtx.cmd"),
        environment: join(fixtureRoot, ".env"),
        programSecret: "fixture-program-secret-1234",
        publishSecret: "fixture-publish-user",
        passwordSecret: "fixture-publish-password"
    };
    await writeFile(fixture.mediaMtx, "@echo MediaMTX v1.20.1\r\n");
    await writeFile(fixture.environment,
        `LIVEZONE_PROGRAM_OUTPUT_TOKEN=${fixture.programSecret}\n` +
        `LIVEZONE_RTMP_PUBLISH_USER=${fixture.publishSecret}\n` +
        `LIVEZONE_RTMP_PUBLISH_PASSWORD=${fixture.passwordSecret}\n`);
    try { return await operation(fixture); }
    finally { await rm(fixtureRoot, { recursive: true, force: true }); }
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWinSWVersion(version) {
    const script = String.raw`
        $source = Get-Content -Raw -LiteralPath $env:LIVEZONE_INSTALL_SCRIPT
        $start = $source.IndexOf('function ConvertTo-WinSWReleaseVersion')
        $end = $source.IndexOf('function Assert-WinSWVersion', $start)
        if ($start -lt 0 -or $end -lt 0) { throw 'WinSW normalizer not found.' }
        . ([scriptblock]::Create($source.Substring($start, $end - $start)))
        $normalized = ConvertTo-WinSWReleaseVersion $env:LIVEZONE_TEST_VERSION
        if ($null -eq $normalized) { 'NULL' } else { $normalized }
    `;
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-Command", script], {
        encoding: "utf8",
        env: {
            ...process.env,
            LIVEZONE_INSTALL_SCRIPT: installScript,
            LIVEZONE_TEST_VERSION: version
        }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = result.stdout.trim();
    return output === "NULL" ? null : output;
}

function assertBundledServiceFiles(wrapper, config, serviceId) {
    const script = String.raw`
        function Assert-File([string]$Path, [string]$Label) {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                throw "$Label is missing."
            }
        }
        $source = Get-Content -Raw -LiteralPath $env:LIVEZONE_INSTALL_SCRIPT
        $start = $source.IndexOf('function Assert-BundledServiceFiles')
        $end = $source.IndexOf('function Wait-HttpReady', $start)
        if ($start -lt 0 -or $end -lt 0) { throw 'Bundled validator not found.' }
        . ([scriptblock]::Create($source.Substring($start, $end - $start)))
        Assert-BundledServiceFiles $env:LIVEZONE_TEST_WRAPPER $env:LIVEZONE_TEST_CONFIG $env:LIVEZONE_TEST_SERVICE
    `;
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-Command", script], {
        encoding: "utf8",
        env: {
            ...process.env,
            LIVEZONE_INSTALL_SCRIPT: installScript,
            LIVEZONE_TEST_WRAPPER: wrapper,
            LIVEZONE_TEST_CONFIG: config,
            LIVEZONE_TEST_SERVICE: serviceId
        }
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}
