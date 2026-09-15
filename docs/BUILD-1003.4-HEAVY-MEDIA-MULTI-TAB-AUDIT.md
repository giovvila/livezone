# Heavy media coexistence audit — 1003.4

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Date: 2026-09-14. Repository: `C:/Projects/livezone-broadcast-engine-x`.
Branch: `build/1003.4`.

DECISION: BUILD_1003_4_HEAVY_MEDIA_MULTI_TAB_BLOCKED.

The operator identifies failing scenes as **MEDIA B** and **audio-12**.
Control + Public passes BREAK, small VIDEO and LIVE HLS, and fails large/long
VIDEO and long AUDIO. Public + OBS is reported to pass. This replaces generic
SSE exhaustion as the primary hypothesis. No evidence implicates Sponsor.

## Actual asset definitions

Catalog mapping was read from `var/studio-state/state.json`, without changes.

| Field | MEDIA B | audio-12 | Small comparison candidate MEDIA A |
| --- | --- | --- | --- |
| Scene/source | media-demo-2-scene / media-demo-2 | audio-scene-4e76e24e-2c07-479a-9213-a591a61cfec7 / audio-89aedb9b-9da4-4b17-a4a6-7bcc87c8a166 | media-demo-scene / media-demo |
| File | demo2.mp4 | 12 Hours of Free Background Music - Copyright Free Music for Creators and Streamers [April Edition].mp3 | demo.mp4 |
| assetId | None: legacy static URL | asset-583bed1e-99db-4f0a-9eb3-de2af775996e | None: legacy static URL |
| Bytes | 2,242,262,600 | 1,035,448,480 | 10,320,286 |
| Duration seconds | 6,914.138333 (MP4 mvhd) | 43,140.005465 (catalog metadata) | 34 (MP4 mvhd) |
| Container | MP4 | MP3 | MP4 |
| Codec indication | avc1 and mp4a markers in moov | audio/mpeg; no detailed frame probe | avc1 and mp4a markers in moov |
| Average total bitrate | approximately 2,594,409 bit/s | approximately 192,016 bit/s | approximately 2,428,303 bit/s |
| Metadata placement | moov at offset 20, length 6,253,038 | MP4 moov not applicable | moov at offset 10,301,619, length 18,667 |
| URL | /media/demo2.mp4 | /media-library/files/audio/583bed1e-99db-4f0a-9eb3-de2af775996e.mp3 | /media/demo.mp4 |
| Artwork | N/A | No stillAssetId/stillUrl/motionAssetId/motionUrl in source | N/A |

Bitrates are file-size/duration estimates including container overhead, not
encoder settings. MP4 inspection reads atom headers and bounded moov data only;
it does not decode media. ffprobe was not available on PATH. The operator did
not explicitly identify the passing small video; MEDIA A is a catalog comparison
candidate, not a claimed new browser measurement.

The other managed video `VIDEO-INVERDURATA-015.mp4` is 610,009,609 bytes and is
**not MEDIA B**. Its moov is at the end; MEDIA B's is at the beginning. It was
included as an additional managed-video Range check, not relabelled as the
operator's failing file. Complete bounded read results are in
`var/heavy-media-real-ranges.jsonl`.

## HTTP Range and streaming

Two concurrent GET requests for the first and last 65,536 bytes were made to
the running service for each of five files: MEDIA A, MEDIA B, long AUDIO, the
610 MB managed video and the 86 MB managed loop video. All ten responses:

- HTTP 206; Accept-Ranges: bytes.
- Correct Content-Range and Content-Length: 65536.
- Correct video/mp4 or audio/mpeg MIME.
- Exact byte equality against bounded reads of the source file.

No media was rewritten. These checks consumed 128 KiB per file over HTTP, not
the whole file. They prove independent concurrent range responses, not sustained
browser throughput under backpressure or the browser's request scheduling.

MEDIA B uses `serveStatic` in `server/program-output-server.js`; audio-12 uses
`MediaLibraryRoutes.serveFile`. Both create a fresh `createReadStream` per request
and pipe to the response. There is no global shared file stream or media
`readFile` buffer on these serving paths. Managed stat is asynchronous; static
serving uses synchronous stat (metadata, not file contents). Pipe provides
backpressure. Open-ended and suffix ranges are supported; offsets remain JS
safe integers and the real MEDIA B tail request exceeds signed 32-bit range.

Audit limitation: both paths use bare stream.pipe(response), with no explicit
source-stream destruction on response close in the shown handler. Early abort
cleanup and file-handle residency deserve a targeted follow-up; this audit did
not prove them causal and does not claim aborted-reader resource bounds.

## Playback preparation and late join

The production Public controller handles recorded VIDEO and AUDIO as:

1. Create one source element (plus AUDIO artwork only if configured).
2. Set source and preload auto; wait for loadeddata/canplay, with 12-second bound.
3. Compute projected cue from initialTime + elapsed wall-clock milliseconds / 1000.
4. Assign currentTime directly, without requiring buffered/seekable coverage.
5. Await seeked with 12-second bound, then request play when appropriate.
6. Promote the prepared layer; clean up the previous layer.

**Relevant code-level difference:** Control's recorded Program can request its
initial seek after metadata readiness (readyState 1). Public waits for initial
data readiness (readyState 2) before assigning the projected cue. This can make
Public wait for data at the beginning before requesting a deep cue. It is a
candidate first divergence under slow loading, not an observed explanation of
the real failure. No captured browser trace establishes that it stalls here.

Tests exercise actual `PublicProgramController.createSource`, valid production
snapshot validation, cue 0 and 36,000 seconds, playing and paused, VIDEO and
AUDIO, empty buffered/seekable ranges. With simulated readiness, all complete
with exactly one media element and the expected cue, even when play() returns
a never-settling promise. Main recorded-media preparation does not await play().
These are not decoding tests or measurements of heavy-file startup latency.

Finite 12-hour durations and 10-hour cues remain valid; no 32-bit coercion was
found in the inspected projection/seek path. Duration Infinity/NaN is rejected
by the snapshot contract; a nonfinite element duration falls back to the
snapshot duration. Projected values clamp to duration, seek clamps just before
the end, paused media retains initialTime. Timers use fixed readiness deadlines,
not durations converted into large timer delays.

On preparation failure Public cleans up, shows PROGRAM UNAVAILABLE and schedules
a retry after one second. A readiness timeout therefore normally takes at least
13 seconds between starts; immediate repeated failures can recreate a surface
every second. No exponential backoff exists here. This remains an unresolved
resource-pressure risk, not a proven cause of the operator incident. Metadata
and seek have bounds, but browser responsiveness and memory residency were not
measured. No speculative retry/player changes were applied.

## Control inventory and Preview isolation

The following are expected stable source allocations, **not actual decoder or
network-activity measurements**. They exclude Technical, external AutoLive
fallback, transitions and candidates; those must be counted separately.

| Case | Control video/audio | Public video/audio | Combined video/audio |
| --- | --- | --- | --- |
| A: MEDIA B Program, BREAK Preview | 1 / 0 | 1 / 0 | 2 / 0 |
| B: MEDIA B Program, VIDEO Preview | 2 / 0 | 1 / 0 | 3 / 0 |
| C: MEDIA B Program, AUDIO Preview without motion | 1 / 1 | 1 / 0 | 2 / 1 |
| D: audio-12 Program, BREAK Preview | 0 / 1 | 0 / 1 | 0 / 2 |
| E: audio-12 Program, VIDEO Preview | 1 / 1 | 0 / 1 | 1 / 2 |
| Public + OBS MEDIA B | N/A | 2 output videos total | 2 / 0 |
| Public + OBS audio-12 | N/A | 2 output audios total | 0 / 2 |

All these base sources use zero HLS.js instances. Playing/paused comes from
transport state; element existence does not prove active hardware decoding or
an in-flight request. A and D have the same base-element count as the successful
Public + OBS pair. The exact failing Preview selections remain unmeasured, so
the audit cannot conclude whether A/D fail or only B/C/E fail.

Additional Control consumers:

- Technical: one HLS/video if selected, unrelated to Program kind. No automatic
  background suspension. Idle selection means no consumer.
- AutoLive: managed-source polling has no decoder. External-source monitoring
  shares matching Technical health or owns one hidden HLS/video fallback.
  Suspending Technical can affect this authority; no suspension was performed.
- Prepared Program: can add one source; existing Preview handoff can reuse it.
  No permanent independent prepared Preview slot was found.
- Outgoing Program: retained for transition duration, then released.
- Motion artwork: an extra video only when configured; audio-12 has none.
- Library metadata probe: detached, sequential metadata-only element for assets
  missing duration, bounded at 12 seconds; audited failing AUDIO already has duration.
- Recovery: temporary replacement/cleanup, no permanently allocated extra slot.
- Legacy PlaybackRuntime Player is disabled in Control (startPlayer:false).

Opening Public sends no Program/Preview command and has no direct path into
Control's prepareProgramScene. The prior isolated network test observed zero
additional publisher sends over each 10-second phase with Public/OBS joining.
It did not run the whole Control page and is not proof of zero real Control
seek/pause/rebuild calls. CONTROL_RECONSTRUCTION_COUNT remains unmeasured.

## Required matrix status

| Requested cases | Evidence/status |
| --- | --- |
| 1–4, 9–10: small/large VIDEO and long AUDIO individually | General standalone success reported previously; exact asset-specific browser reruns unavailable |
| 5: small VIDEO Control + Public | Operator PASS |
| 6: large VIDEO Control + Public | Operator FAIL, MEDIA B identified |
| 7–8: large VIDEO with BREAK/VIDEO Preview | Not separately measured |
| 11: long AUDIO Control + Public | Operator FAIL, audio-12 identified |
| 12: long AUDIO with BREAK Preview | Not separately measured |
| 13–14: Public + OBS | Operator PASS control group; no new per-asset browser capture |
| 15–16: concurrent Range | PASS on actual MEDIA B and audio-12; managed fixture regression also passes |
| 17–19: near/deep/paused cue | PASS in production controller with simulated media events; browser verification pending |
| 20: no Control reconstruction | Source audit and isolated transport test only; live counters unavailable |
| 21–22: no Program/Preview mutation | No operator commands issued by this audit; fixture snapshot unchanged |

The browser connector again returned zero available browsers. Therefore active
decoders, heap growth, live file handles, media request waterfalls and player
event order could not be measured. Control + Public was not secretly substituted
with jsdom and reported as a browser pass. No production TAKE or selection change
was made for the isolation matrix.

## Decision and next step

FIRST_DIVERGENCE: unobserved in the failing browser. Metadata-to-data gating is
the most specific preparation difference found; concurrent bounded Range reads
and long-cue arithmetic passed.

ROOT_CAUSE: not proven. Resource pressure remains plausible; generic SSE
exhaustion and Sponsor are not declared causes.

FIX: no production behavior changes; tests and evidence only, respecting the
requirement to establish causality before optimization.

RESOURCE_BOUNDS_AFTER_FIX: no fix claimed. Current preparation deadlines are
12 seconds readiness + 12 seconds seek; retries can repeat after one second;
actual decoder/memory/file-handle bounds remain unverified.

TESTS_ADDED: 12 in `test/heavy-media-boundaries.test.js` (two real HTTP managed
Range tests, one >32-bit Range parser test, eight actual Public preparation
cases, one long-duration arithmetic/validation test). Fixtures are 4 MB temporary
byte files, not committed binaries. No production media is copied or rewritten.

TEST_FIDELITY_GAP: media events are simulated; no real demuxing/decoding, memory
pressure or browser HTTP pool limits. Range tests use the real handler; real
service samples verify actual failing files separately.

FOCUSED_TEST_RESULT: 144/144 PASS (`var/heavy-media-focused.log`).
FULL_TEST_RESULT: 1405/1405 PASS, zero failures/skips (`var/heavy-media-full.log`).
This count includes the prior 1392 baseline, the previous coexistence test and
12 tests added here.
SYNTAX_RESULT: PASS for the new test, PublicProgramController,
MediaLibraryRoutes and program-output-server.
DIFF_CHECK_RESULT: PASS (`var/heavy-media-diff.log`, empty).
STAGING_STATUS: 117 files, unchanged index-content SHA-256:
`6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a`.
BLOCKERS: no connected browser for actual failure/consumer capture. Asset names
are resolved; this is not blocked on media identification.

MANUAL_RETEST: capture MEDIA B and audio-12 in A–E, then identical Public + OBS
control group. Record metadata, readyState, seek target/completion, buffered and
seekable, currentTime, range waterfall, active consumer identities and Control
rebuild counters. Keep Technical state recorded and vary it only when safe.

NEXT_STEP: MANUAL RETEST LARGE VIDEO + LONG AUDIO WITH CONTROL + PUBLIC.

No stage, unstage, reset, commit, push, service restart, media/data edit, TAKE,
Program/Preview/AutoLive/Scheduler/Sponsor change was performed.
