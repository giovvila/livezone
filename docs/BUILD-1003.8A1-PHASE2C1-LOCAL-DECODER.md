# 1003.8A1 Phase 2C-1 — local FFmpeg shadow decoder

Branch: `build/1003.8A1`. Baseline: `3cfe1886486e9a6a00d99e3ea4d98d80c38ebf3c`.
Phase 1 and Phase 2 remain uncommitted and unchanged by this phase. No application
bootstrap imports this decoder. No Program writer, ownership grant, TAKE/RETURN
callback, Scheduler executor, new API or live-state storage is present.

## Binary discovery and scope of approval

Neither ffmpeg nor ffprobe resolves on PATH. Read-only searches of application,
user, project and runtime locations found bundled binaries. No installation,
download, PATH change or binary copy was performed.

Selected absolute executable, used in place:

`C:\Program Files (x86)\Common Files\Axel Technology\Utility\FFMpeg\ffmpeg.exe`

- SHA-256: `574845e3507616421c34ae6d556c72519b1aff6fde33f094b066896c0604d743`
- Version: `n4.4.1-50-ga4e1dd6940-20220302`
- Compiler: `gcc 11.2.0 (crosstool-NG 1.24.0.533_681aaef)`
- libavcodec 58.134.100; libavformat 58.76.100; libavfilter 7.110.100.
- Verified capabilities used: showinfo, ashowinfo, testsrc2, sine, FFV1, PCM s16le.

Exact reported configure flags:

```text
--prefix=/ffbuild/prefix --pkg-config-flags=--static --pkg-config=pkg-config --cross-prefix=x86_64-w64-mingw32- --arch=x86_64 --target-os=mingw32 --enable-gpl --enable-version3 --disable-debug --disable-w32threads --enable-pthreads --enable-iconv --enable-libxml2 --enable-zlib --enable-libfreetype --enable-libfribidi --enable-gmp --enable-lzma --enable-fontconfig --enable-libvorbis --enable-opencl --disable-libpulse --enable-libvmaf --disable-libxcb --disable-xlib --enable-amf --enable-libaom --enable-avisynth --enable-libdav1d --enable-libdavs2 --disable-libfdk-aac --enable-ffnvcodec --enable-cuda-llvm --disable-frei0r --enable-libgme --enable-libass --enable-libbluray --enable-libmp3lame --enable-libopus --enable-librist --enable-libtheora --enable-libvpx --enable-libwebp --enable-lv2 --enable-libmfx --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopenmpt --enable-librav1e --enable-librubberband --enable-schannel --enable-sdl2 --enable-libsoxr --enable-libsrt --enable-libsvtav1 --enable-libtwolame --enable-libuavs3d --disable-libdrm --disable-vaapi --enable-libvidstab --disable-vulkan --enable-libx264 --enable-libx265 --enable-libxavs2 --enable-libxvid --enable-libzimg --enable-libzvbi --extra-cflags=-DLIBTWOLAME_STATIC --extra-cxxflags= --extra-ldflags=-pthread --extra-ldexeflags= --extra-libs=-lgomp --extra-version=20220302
```

Other inspected candidates: MediaHuman's FFmpeg 7.1 reports an empty configuration;
CyberLink PhotoDirector's 3.2.git build only exposes a restricted image-codec/filter
set; ClipGrab's build is 4.2.1. OBS's ffmpeg-mux executable is not a replacement
for the FFmpeg CLI. The search was not an exhaustive scan of every disk.

This older, application-bundled binary is accepted only for the generated, isolated
local fixtures in this experiment. It is not approved for untrusted remote media,
production deployment, copying or redistribution. GPL/version3 build flags require
packaging/license review; selection is not a legal or security certification.
The binary hash is checked before each decoder launch. Tests fail rather than
silently skip or substitute a fake decoder when this pinned dependency is absent.

## Worker boundary and resources

`FFmpegHealthWorker` validates an explicit fixture root and absolute file path,
hashes the file, verifies the backend and uses Node spawn with an argument array,
shell=false, windowsHide=true and a minimal environment. No PATH lookup or
operator-supplied FFmpeg options are accepted. FFmpeg decodes to a null output;
it does not stream-copy. The only input protocol is file. Demuxing is forced to
Matroska or WAV, avoiding playlist/protocol autodetection and nested HLS requests.

URL schemes, file URLs, UNC/device paths, alternate data streams, traversal,
realpath escapes, unsupported suffixes and files larger than 16 MiB are rejected.
Generated roots are trusted, private test inputs, not an upload interface or a
general sandbox for hostile media. Concurrent hostile replacement of root/files
is outside this local-fixture scope. Fixture names contain no credentials.

One decode worker may exist per Node process, including across supervisor objects.
This is not a cross-process authority lock. The supervisor allows three explicit
launch attempts per experiment and models bounded exponential restart backoff
(1, 2, 4, 8, 16, 30 seconds, capped); it never starts retries automatically.
Every launch increments worker generation and subsequent launches increment restart
generation. Timers use 500-ms observations, 2-second freshness, 5-second stall
classification, a 15-second startup deadline and a maximum 180-second experiment.

Two codec threads and one filter thread are requested. No speculative CPU or RAM
hard ceiling is imposed. stdout and stderr are continuously drained, each bounded
to 4-KiB lines, 256 KiB per second and 8 MiB total. On excess, the worker becomes
unavailable and stops. Raw stderr is not published or retained; private diagnostic
history contains at most 64 timestamped reason codes.

Graceful shutdown sends FFmpeg's fixed q command through its own stdin pipe.
After 2 seconds it requests forced termination. After 5 seconds without a close
event it reports TERMINATION_UNCONFIRMED and keeps the worker slot fenced. Stopping
seals evidence immediately; cached frames cannot restore PROGRESS after stop.

## Evidence contract

All samples are immutable, digested and localFixtureOnly. They contain:

- source ID and fixture-content SHA-256;
- backend version/configuration/binary digest and policy version;
- worker UUID/generation and restart generation;
- required-track profile, track-set and timestamp-discontinuity generations;
- monotonic observation sequence and supervisor-process receipt time;
- per-track decoded frame count, sample count, PTS and last advancing receipt;
- wall-clock diagnostic time, bounded freshness and qualification duration;
- executionAllowed=false, serverTake=false, transferReady=false.

showinfo and ashowinfo are parsed only for decoded-frame/audio sample telemetry.
HTTP availability, progress output, process liveness and packet counts cannot
qualify. Both counters and PTS must advance over at least 500 ms. Media-time
advancement cannot run more than 1 second ahead of elapsed receipt time. One frame
or a brief buffered burst does not establish sustained progression. Missing
timestamps cannot qualify. Receipt freshness does not survive process restart.

States: STARTING, PROGRESS, STALLED, ERROR, ENDED, UNAVAILABLE and UNCERTAIN, all
prefixed DECODER_. Natural finite EOF is ENDED, not live health. Malformed media
is ERROR. A missing explicitly mapped required stream is UNAVAILABLE. Stale data
becomes UNCERTAIN after 2 seconds, STALLED after 5 seconds. Worker crashes are
observation failure, never independently confirmed source loss.

AUDIO_VIDEO requires advancing video and audio; AUDIO_ONLY and VIDEO_ONLY have
explicit required tracks. The first matching stream of each required kind is
selected; this does not establish every rendition/track's health. Required tracks
are never silently optional. Codec/format/rate/channel/size changes invalidate
qualification and advance track generation. Backward PTS or a jump over 2 seconds
invalidates qualification and advances timestamp generation. These limits are a
local-fixture policy, not a claimed general low-frame-rate or LL-HLS policy.

The receiver rejects altered digests, old generations, repeated/reversed sequences,
pre-binding observations and delayed/stale monotonic receipts. The digest is an
integrity/provenance checksum, not remote authentication. No network receiver exists.

## Phase-2 comparison and hypothetical timing

`DecoderShadowComparison` retains the Phase-2 transport comparison and adds a
separate local decode comparison. Real decoded fixture progress with matching,
fresh browser-style evidence yields MATCH_HEALTHY; failure against transport ONLINE
can yield DISAGREEMENT; an unavailable decoder against healthy browser evidence
yields SERVER_WEAKER. Agreement does not assert production decoder equivalence.

`ExecutionReadinessModel` remains unchanged: local decoder samples are not an
approved executable producer. Every readiness result remains false for execution,
serverTake and transferReady.

Hypothetical timing reuses the existing decision shadow. Decoder uncertainty resets
ENTRY credit, as do missed observation intervals and generation changes; 30 seconds
of continued qualifying evidence are required. Decoder failure alone cannot start
confirmed loss. A separately supplied fresh, bound browser-style confirmed-loss
observation may exercise the existing hypothetical 15-second policy. The existing
shadow's strict >15,000-ms boundary (versus browser deadline equality) is preserved
and tested, not normalized. Decoder progress dominates contrary loss evidence.
No source-loss classifier or production AutoLive timing path is replaced.

`provenance()` provides the backend/worker/profile/timestamp generation reference.
Advancing healthy sample sequence/digest does not invalidate generation compatibility;
restarts, track changes and timestamp changes do. No action journal consumes these
local fixture observations, so Phase-2 durable transaction schema is unchanged.
Actual future action integration still needs a versioned provenance reference,
final generation/freshness validation and fresh evidence after recovery. A stored
checksum alone must never grant readiness.

## Real fixtures and Windows cleanup

Fixtures are generated with the pinned binary in unique OS temporary directories,
then removed. No binary fixture is added to the repository or public media.

- 96x64, 10-fps FFV1 video plus 16-kHz PCM audio, four seconds;
- corresponding audio-only and video-only fixtures;
- malformed container text;
- audio-only container requested as A/V to reproduce an unsupported required profile;
- a forward timestamp gap to exercise real no-progress stall and discontinuity;
- finite natural EOF, graceful q stop, forced stop and direct FFmpeg process failure.

The real tests assert exact child PIDs are absent after close, normal stop, escalation
and direct worker failure. Process CPU seconds and working-set bytes are sampled
using Windows Get-Process for the synthetic A/V child. These small-fixture samples
are observations, not production or 1080p performance estimates.

No native Windows Job Object helper/dependency was added. Ordinary child.kill does
not prove process-tree containment, parent-crash cleanup, service-stop cleanup or
cleanup of hypothetical descendants. Those remain explicit deployment blockers.
A machine-wide Win32_Process query was denied in this session; PID-specific tests
still verify the children they create. No unrelated processes are terminated.

## Files added in this phase

- server/autolive/decoder/DecoderEvidenceContract.js
- server/autolive/decoder/FFmpegHealthWorker.js
- server/autolive/decoder/DecoderSupervisor.js
- server/autolive/decoder/DecoderShadowComparison.js
- test-support/DecoderLocalFixture.js
- test/decoder-evidence-contract.test.js
- test/decoder-local-ffmpeg.test.js
- docs/BUILD-1003.8A1-PHASE2C1-LOCAL-DECODER.md

## Validation

Final validation on Windows / Node v24.15.0:

| Run | Tests | Pass | Fail | Cancelled | Skipped | Duration ms |
|---|---:|---:|---:|---:|---:|---:|
| Focused Phase 1 / Phase 2 / ENTRY / decoder (six files) | 225 | 225 | 0 | 0 | 0 | 37853.4783 |
| Full regression | 2048 | 2048 | 0 | 0 | 0 | 152768.474 |

Both commands exited 0. New decoder coverage accounts for 42 passing tests: 22
contract/timing/comparison tests and 20 local-binary/integration/security tests.
No media decoder was mocked as a substitute for the real integration tests.
The final full run observed the A/V child at 0.015625 CPU seconds and 14,524,416
bytes working/peak working set. The focused run observed 0.046875 CPU seconds
with the same working set. Sampling occurred during small-fixture decode, not at
process exit; these are neither whole-run CPU totals nor a sustained CPU percentage.

Syntax checks: seven JavaScript files passed. git diff --check passed, and explicit
whitespace checks cover all eight new untracked files. Nothing is staged. HEAD and
the closed build/1003.7A1 ref remain at the stated baseline.

An initial real shutdown assertion exposed cached progress being recomputed after
stop. Evidence is now sealed on shutdown and a regression prevents revival. The
final results above include that fix, real q-stop, direct forced stop and escalation
when the command pipe is unavailable.

Commands:

```powershell
node --test --test-timeout=60000 --test-concurrency=2 test/execution-transfer-model.test.js test/headless-health-equivalence.test.js test/action-recovery-atomicity.test.js test/autolive-entry-gate.test.js test/decoder-evidence-contract.test.js test/decoder-local-ffmpeg.test.js
node --test --test-timeout=60000 --test-concurrency=2
git diff --check
```

Test logs reside in the OS temporary directory as livezone-phase2c1-focused.log
and livezone-phase2c1-full.log. Plain git diff does not inspect untracked files;
the eight new files also receive explicit whitespace checks.

## Next gate and limitations

2C-2 is justified as an explicitly approved, shadow-only broker/containment phase,
not as execution readiness. Before contacting primecast: select a maintained,
reviewed backend build; approve provisioning/licenses; implement the existing
SSRF/DNS/redirect policy for every HLS object through a bounded fetch broker;
validate codecs, TS/fMP4/LL-HLS, audio alternatives, media freshness/lag and real
network interruption; validate resource/soak limits and Windows/WinSW cleanup;
then conduct the authorized four-way runtime comparison. No HLS broker exists here.
Unsupported-codec bitstreams, backward-PTS media, HLS and real 1080p performance
are not proved by the local fixture matrix. Unit tests cover backward PTS and
track changes; real forward-gap media covers a reproducible timestamp discontinuity.

No primecast or other external media source was contacted by the PoC. No current
server restart, browser reconciliation or ownership mutation was performed.
SERVER_OWNER remains impossible, serverTake=false, no server ENTRY/TAKE/RETURN,
no Control-closed Program execution, and Scheduler Program execution suspended.
No commit or push is authorized in this phase.
