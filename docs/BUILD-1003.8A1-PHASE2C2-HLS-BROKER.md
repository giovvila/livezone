# 1003.8A1 Phase 2C-2 — secure HLS input, runtime acceptance blocked

Branch `build/1003.8A1`, baseline `3cfe1886486e9a6a00d99e3ea4d98d80c38ebf3c`.
No commit/push. This phase is NOT closed: broker/local decoder tests pass, but
the required five-minute primecast decode experiment could not start under the
existing 2.5-second network deadline. No execution capability was introduced.

## Files changed in this phase

Modified existing work:

- server/autolive/AutoLiveSafeHttp.js
- server/autolive/decoder/DecoderEvidenceContract.js
- server/autolive/decoder/FFmpegHealthWorker.js
- server/autolive/decoder/DecoderShadowComparison.js
- test-support/DecoderLocalFixture.js

Added:

- server/autolive/decoder/HlsDecodeInputBroker.js
- server/autolive/decoder/BrokeredShadowExperiment.js
- test-support/BrokerShutdownFixture.js
- test/hls-decode-broker.test.js
- test/hls-broker-decoder.test.js
- tools/hls-shadow-experiment.js
- docs/BUILD-1003.8A1-PHASE2C2-HLS-BROKER.md

Prior Phase 1/2 work, existing Program/ownership/Scheduler implementations and
unrelated media/runtime files are preserved. No HLS broker is imported by the
application bootstrap. The executable CLI requires an explicit source ID, state
file, binary path and SHA; it only reads the source configuration.

## Network boundary

All HTTP uses the existing AutoLiveSafeHttp, including resolver validation, rejection
of private/mixed DNS answers, socket address pinning, original TLS host verification,
bounded redirects, complete destination revalidation, abort propagation and absence
of ambient credentials/cookies/proxy state. Existing manifest and one-byte health
probe defaults remain unchanged. The additive binary-body mode uses the same code,
disables Range probing, requests generic media, requires HTTP 200, preserves bytes
and enforces a caller cap no larger than 16 MiB. No second HTTP implementation exists.

The broker permits at most two complete GET attempts for transient timeout/network
failure, separated by 250 ms. It does not retry policy errors or explicit cancellation,
stitch partial downloads, increase the 2.5-second deadline or use direct FFmpeg HTTP.
Partial bodies are discarded. Bounded failure metadata distinguishes DNS/request
phase, response-header arrival and received byte count without exposing URLs.

Redirect-reference validation runs before URL normalization so dot traversal cannot
be hidden by URL resolution. Every object still receives complete SafeHttp validation
before fetching. URL schemes, credentials, UNC/file references, encoded traversal,
unknown URI-bearing constructs, encryption and private redirects fail closed.

## Supported grammar and local cache

Supported: one master level with explicit fixed variant index; muxed audio/video or
explicit worker track profile; ordinary HLS TS; fMP4 initialization maps and fragments;
media/discontinuity sequences; durations; program date-time; finite ENDLIST; version
1–7; independent-segments declaration. No silent rendition switching.

Unsupported and rejected: LL-HLS parts/preload hints/rendition reports/server-control/
delta updates, byte ranges, alternate audio/subtitle playlist URIs, nested masters,
DRM/encryption and unknown tags/attributes. METHOD=NONE without a key URI is allowed.
An unsupported source produces a capability failure, never a networking fallback.

Manifests are at most 128 KiB, with bounded lines, 16 variants and 16 segments, each
duration/target at most 30 seconds and the window at most 90 seconds. Full objects
are at most 16 MiB. Container signatures reject playlists disguised as TS/MP4 before
they can reach FFmpeg. This is format screening, not a security certification of
arbitrary compressed media; the native decoder still needs production containment.

Private jobs are created under the canonical OS temp directory, rejecting public-root
and UNC cache parents. Opaque UUID filenames contain no original URLs. Media bytes,
init data, durations and discontinuity counts are preserved. The generated local
manifest contains only fixed tags and those opaque names. Atomic replacement retries
Windows sharing violations up to ten attempts without unlinking the current manifest.

Cache policy retains the current and preceding windows, at most 64 objects and
128 MiB media bytes, plus bounded manifest/temporary-manifest storage. An update
that exceeds a bound fails closed. Cleanup verifies the canonical private job parent
before removal. Changed bytes/durations/discontinuities for an already accepted media
sequence, sequence regression and reuse of a segment URI for a new sequence fence the
job. A rotating media-playlist redirect may continue when its selected rendition and
accepted content remain consistent.

Refresh runs sequentially every half target duration, bounded to 1–5 seconds. Each
refresh downloads and validates complete new media before replacing the manifest.
No overlapping refreshes or partially published manifests occur. Stale remote
progress suppresses readiness after max(15 seconds, three target durations), even
if buffered frames remain. The experiment has an independent overall deadline.

## Decoder integration and provenance

A WeakMap-issued broker handle is required: callers cannot pass arbitrary m3u8 files
through the old fixture path interface. The verified absolute FFmpeg binary receives
only the local manifest, file protocol whitelist and hls/mpegts/mov demuxer whitelist.
HLS nested resource extensions are restricted to ts/m4s/mp4. No DNS name, remote URL,
cookie, header or credential reaches its command arguments. Existing shell=false,
minimal environment, pipe/output limits, explicit mappings and pacing remain intact.

Broker samples use BROKER_HLS_SHADOW_1, localFixtureOnly=false and generation provenance
version 2. They bind canonical source fingerprint, backend digest, worker/restart
generation, broker generation, fixed rendition identity, required tracks and timestamp/
track generations. Content generation advances normally; it is not strict latest-sample
CAS equality. Compatible advancement preserves qualification, while broker restart,
identity mismatch, incompatible content, discontinuity and stale broker state cannot
silently inherit it. Local-fixture version 1 semantics remain supported.

No action journal consumes this evidence. Phase-2 durable action schema/commit/recovery
semantics are unchanged. All readiness/experiment results retain executionAllowed=false,
serverTake=false and transferReady=false. Hypothetical 30-second ENTRY and existing
15-second loss behavior remain non-executing.

## Isolated validation

HTTP fixtures use an explicit test-only loopback policy injection into the REAL
SafeHttp; production construction has no local exception. Tests cover safe graphs,
DNS pinning/private/mixed answers, redirects/private redirects/traversal, nested unsafe
segments/maps/keys, unsupported features, malformed/oversized data, timeout/abort,
partial-body diagnostics, rotating URLs, stale/ENDLIST windows, sequence/content
races, atomic Windows replacement, bounds, cleanup and provenance.

Generated H.264/AAC TS and fMP4 fixtures actually decode through broker-local manifests.
Both required tracks progress, the worker naturally ends, and the tested PID disappears.
Malformed bytes in an allowed TS container cannot produce healthy evidence. Cancellation,
supervisor restart and a separate Node child performing normal experiment shutdown
prove tested decoder/cache cleanup. These tests do not assert parent-crash containment.

During fixture development, FFmpeg initially placed fMP4 init.mp4 in the working
directory. The generated test artifact was removed and generation now explicitly runs
in its isolated temporary directory. No public/demo asset was changed.

## Actual primecast observations

Only after security and real local decode tests passed was the user-authorized source
read from the existing state file. Its source ID is
`live-73e8c51e-1c6d-4481-b351-9f3a9b9d6fe4`; canonical fingerprint:
`6a5d38a162c4cd1df7fabfe5e3defb518f7b7093db35a10d965a4f7088b96397`.

The successful broker-only preflight reported:

- fixed master variant index 0;
- CODECS `avc1.100.40,mp4a.40.2`, resolution 1920x1080;
- approximately 2.8 Mb/s advertised bandwidth (slightly variable between sessions);
- ordinary HLS, no encountered LL-HLS tags, no ENDLIST;
- target duration 17 seconds, three media objects;
- media sequence 1836 through 1838 at that observation;
- 8,657,212 cached media bytes, then successful cache removal.

This preflight fetched media but did NOT run FFmpeg. Its success is not decoder proof.

The five-minute attempts then aborted before worker creation:

| Attempt | Elapsed ms | Result | Decoder observations | Cleanup |
|---|---:|---|---:|---|
| Initial | 5960 | ABORTED during segment input | 0 | yes |
| Bounded retry enabled | 11235 | ABORTED during segment input | 0 | yes |
| Binary Accept header corrected | 11315 | ABORTED during segment input | 0 | yes |
| Bounded request/body diagnosis | 13880 | ABORTED during segment input | 0 | yes |

The diagnostic attempt received response headers and 2,342,422 bytes, then exhausted
the unchanged request deadline before a complete segment arrived. DNS/private-address
policy did not reject this request. Incomplete bytes were discarded. Decoder startup
latency, decoded A/V/PTS results, sustained decode duration and primecast FFmpeg CPU/RAM
are therefore NOT MEASURED (zero decoder observations), not passing or zero-cost results.

Separately, three bounded samples using the existing production HLS observer returned
UNCERTAIN/AWAITING_PROGRESSION, then ONLINE/PLAYLIST_ADVANCING twice; segments were
reachable in all three. This confirms transport progression under the lightweight
probe policy, not equivalence to full-media delivery or decoding. It was an independent
read-only instance of the production observer, not a claim about the running server's
authority snapshot.

No browser was connected to the available Browser runtime (discovery returned no
browsers). No Control tab was opened, refreshed or navigated. Browser/active-Program
evidence was requested read-only if an existing tab is available; absent supplied
evidence, comparison remains INSUFFICIENT_EVIDENCE. No synthetic MATCH_HEALTHY is
reported for primecast. Program was not made LIVE for this test.

## Tests and logs

Final validation on Windows / Node v24.15.0:

| Run | Tests | Pass | Fail | Cancelled | Skipped | Duration ms |
|---|---:|---:|---:|---:|---:|---:|
| Focused nine-file matrix, including all Phase 1/2/2C-1 suites | 322 | 322 | 0 | 0 | 0 | 37768.4901 |
| Full regression on final code | 2089 | 2089 | 0 | 0 | 0 | 155057.6589 |

Both commands exited 0. The two new suites add 41 tests. Syntax checks passed for
all 11 JavaScript files changed/added in this phase; explicit whitespace checks
passed for all 12 files, including untracked files. git diff --check exited 0
(only existing LF/CRLF conversion warnings). Nothing is staged. HEAD and the closed
build/1003.7A1 ref remain at the stated baseline. Runtime acceptance remains blocked
despite these automated results.

Focused command:

```powershell
node --test --test-timeout=60000 --test-concurrency=2 test/hls-decode-broker.test.js test/hls-broker-decoder.test.js test/autolive-health-http.test.js test/execution-transfer-model.test.js test/headless-health-equivalence.test.js test/action-recovery-atomicity.test.js test/autolive-entry-gate.test.js test/decoder-evidence-contract.test.js test/decoder-local-ffmpeg.test.js
node --test --test-timeout=60000 --test-concurrency=2
git diff --check
```

Logs are in the OS temp directory: livezone-phase2c2-focused.log, livezone-phase2c2-full.log,
livezone-phase2c2-transport.log and the four livezone-phase2c2-primecast*.log files.
These contain bounded diagnostics, not media, URLs or credentials. Test media and broker
jobs are temporary and removed. No current service/server restart was performed.

## Provisioning, containment and next gate

The Axel Technology binary remains an explicitly supplied machine-local PoC dependency,
not a production default. It was not downloaded, copied or redistributed. See Phase 2C-1
for exact path/version/SHA/configuration. Future supported Windows/Linux x64 packages
need pinned versions/hashes, provenance, build flags, required HLS/TS/MOV/H.264/AAC
capabilities, licensing notices/source obligations and security review.

No unsafe native dependency was added. Windows Job Object process-tree containment,
unexpected parent death and WinSW stop/restart guarantees remain unproven. Normal
cooperative Node shutdown/cancellation/restart tests passing do not close those gaps.

Headless Decoder Evidence Equivalence — Shadow Acceptance is NOT MET. The immediate
blocker is full-media transfer completion under the existing deadline. A separate
broker-only 10-second media deadline was proposed for explicit approval; it has NOT
been implemented. Manifest/probe and full-media requests remain at 2.5 seconds. An
alternative is an environment/source delivery path that completes within that policy.

Before Phase 3: resolve the approved media-fetch budget, complete sustained real decode
and truthful browser comparison, validate resource/soak limits, provisioning and
containment, then separately approve and prove ownership transfer/action/Program
atomicity, manual dominance and recovery. Passing local broker tests is not authority
to implement an executor.

No Program mutation path, ownership grant, automatic reconciliation/takeover, server
ENTRY/TAKE/RETURN, Control-closed execution or Scheduler execution was added.
SERVER_OWNER remains impossible and serverTake=false. No commit or push.
