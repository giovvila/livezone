# Large local MP4 / Public audit — 1003.4

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

2026-09-14; branch `build/1003.4`.

DECISION: BUILD_1003_4_LARGE_MP4_PUBLIC_BLOCKED.

The new operator retest is authoritative: Control + SMALL VIDEO + Public passes;
Control + MEDIA B + Public fails; Control + audio-12 + Public now passes. This
audit does not reopen Technical retry, generic SSE exhaustion, AUDIO or lifecycle
as the remaining cause.

## Encoding comparison, read-only inspection

Windows Shell media properties were read for the two actual files. Bounded MP4
moov reads supplied AVC configuration IDs and sync-sample spacing. No transcoding,
media writes, whole-file reads or production playback commands were performed.

| Property | SMALL reference `demo.mp4` | MEDIA B `demo2.mp4` |
| --- | --- | --- |
| File bytes | 10,320,286 | 2,242,262,600 |
| Duration seconds | 34 | 6914.1383333 |
| Resolution | 1920 x 1080 | 1024 x 576 |
| Frame rate | 50 fps | 25 fps |
| Video bitrate, Shell metadata | 2,039,704 bit/s | 2,399,968 bit/s |
| Audio bitrate, Shell metadata | 384,192 bit/s | 187,248 bit/s |
| Total bitrate, Shell metadata | 2,423,896 bit/s | 2,587,216 bit/s |
| AVC profile_idc / level_idc | 100 / 42 | 77 / 41 |
| Profile family / level | High / 4.2 | Main / 4.1 |
| Sync samples | 17 | 6914 |
| Adjacent sync-sample spacing | 100 samples, approximately 2 s at reported fps | 25 samples, approximately 1 s at reported fps |
| moov offset / bytes | 10,301,619 / 18,667 | 20 / 6,253,038 |

Frame-rate property units were interpreted using Microsoft's
[System.Video.FrameRate documentation](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-video-framerate).
AVC profile/level IDs follow the identifiers described in
[RFC 6184](https://www.rfc-editor.org/rfc/rfc6184.html#section-8.1).
Sync-sample spacing is from the sample table and reported average frame rate,
not a full bitstream timing analysis. Profile family is not a complete accounting
of all encoder tools or decoded-picture-buffer requirements.

MEDIA B is much longer and has a much larger metadata/sample table, but lower
resolution and frame rate than the working reference and a similar encoded
bitrate. These fields do not establish a higher per-frame decoding workload or
GPU exhaustion. Larger sample tables or native buffering remain hypotheses,
not findings of the cause. Its front moov also rules out simply assuming that
this file must download to the end before finding metadata.

## Production preparation order

Control VIDEO leaves preload unset (browser default). Public recorded VIDEO
explicitly sets preload=auto; it is not using the browser default. Public also
sets autoplay for playing snapshots. Merely changing preload while leaving
autoplay/play demand intact is not a demonstrated resource fix.

Current Public code and deterministic tests agree on:

snapshot -> source resolution -> one video element -> src/load ->
loadedmetadata/durationchange -> loadeddata/canplay -> projected currentTime ->
seeked -> explicit play request -> promotion.

The explicit projected seek is not requested at metadata alone. Metadata-only
readiness times out if initial data never arrives. This is true in both SMALL
and LARGE fixtures: it identifies an ordering constraint, not yet a real
file-specific divergence. Native autoplay can independently request playback;
the test's explicit-play ordering is not a native browser event recording.

The isolated alternative uses preload=metadata and autoplay=false for preparation,
waits for metadata, assigns currentTime, waits for seek/data, then switches to
normal playback demand. It succeeds at cues 1, 3600 and 6900 seconds with data
made available after seek in the deterministic fixture. Existing production
wait/seek primitives are used, but this alternative is **test-only**, not a
patched playback policy. It proves the alternative can request the cue earlier;
it does not prove reduced browser buffering or resolution of MEDIA B's failure.

No production preload, seek ordering, quality, AUDIO, HLS, OBS behavior or retry
policy was changed without the required real evidence.

## Added MP4 trace points

PublicProgramController now emits bounded diagnostic events for recorded VIDEO:
source resolved, element created, src assigned (preload label only), loadstart,
loadedmetadata, durationchange, loadeddata, canplay, seeking, projected target
and actual seek request. Existing snapshot, play/playing, ready/promotion,
failure and cleanup behavior remains in place. Event listeners are removed
with the existing source cleanup.

When local RuntimeTrace is enabled, up to four buffered and four seekable ranges
are recorded per observed event. Timeupdate retains the existing one-second
throttle; the existing bounded trace ring controls history size. URLs, tokens
and raw error strings are not added. No polling timer or media command is added.
HLS and AUDIO do not acquire the new recorded-VIDEO event listeners.

On a normal new localhost Public load, use `livezoneRuntimeTrace.exportJSON()`;
in Control use `livezoneControlMediaResources.exportJSON()`. Existing tabs do not
hot-load these changes. This turn did not reload a browser or restart services.

## What is and is not measured

Browser discovery again found zero attached browsers. Therefore no new actual
Control-before/after, Public event trace, native buffering growth or network
waterfall was obtained. The earlier operator Program snapshot showed readyState
4, networkState 1, active playback, approximately 0–111 s buffered and full
seekability; it must not be presented as a new post-backoff capture.

CONCURRENT_RANGE_PATTERN: unknown for the failing browser. Prior backend Range
correctness does not supply concurrent request counts, canceled requests,
offset sequences, transferred sizes or request durations. No new server Range
change was made.

VIDEO_ELEMENT_COUNT: production-class simulations create exactly two elements
for Control + Public, with both the same large source and a different small
Public source. Control identity/currentTime/src remains unchanged. This is not
proof that two hardware decoders succeed on the operator machine.

GRACEFUL_FAILURE_BEHAVIOR: existing readiness/seek deadlines remain 12 s each;
failed source cleanup removes src, and render failure removes its candidate
layer and shows PROGRAM UNAVAILABLE. Three repeated failed preparations in tests
return to zero Public video elements. The test intercepts retry scheduling to
exercise cleanup deterministically; it does not measure actual retry cadence.
Existing one-second retry delay remains unchanged. Responsiveness of the real
browser and native-memory release remain unverified.

FIRST_DIVERGENCE: not observed in the failing browser.
ROOT_CAUSE: unresolved. Data-before-seek is a candidate constraint, not a proven
root cause. Neither decoder exhaustion nor excessive buffering is asserted.
FIX: diagnostic coverage and tests only; no speculative playback policy change.

## Tests and required retest

Eleven tests added in `test/large-mp4-preparation-order.test.js`:
SMALL/LARGE current ordering, metadata-only failure cleanup, three isolated
metadata-first deep/near-end cue cases, same/different concurrent source elements,
abort isolation, bounded redacted diagnostics/cleanup, repeated failed candidate
cleanup. Existing tests continue to cover AUDIO, LIVE, OBS, Sponsor/Crawl,
AutoLive, Program/Preview identity and normal TAKE.

Test fidelity: jsdom media events are simulated; no decoding, large-file demand,
browser cache or native resource limits are reproduced. The real file inspection
is separate evidence and does not turn a synthetic playback test into a browser
pass.

MANUAL_RETEST: compare SMALL and MEDIA B from the same Control/Preview state.
Capture both tabs' traces and the browser network waterfall before/during Public
opening. Find the first missing event/request: metadata, initial data, seek,
post-seek readiness or playback. Count active/canceled ranges, offsets, sizes
and durations. Confirm Control's surface ID and playback remain unchanged.
Then evaluate metadata-first preparation only if that trace implicates the
current data gate or excess initial buffering.

BLOCKERS: real browser event/network evidence is unavailable; a causal playback
fix cannot yet be justified.
NEXT_STEP: MANUAL RETEST MEDIA B CONTROL + PUBLIC.

No TAKE, production media/state change, service restart, stage/unstage/reset,
commit or push. The existing 117-file index is preserved.

## Final validation

- Focused production-path fixtures: 138/138 PASS.
- Full `node --test`: 1442/1442 PASS, zero failures/skips.
- Syntax: PublicProgramController.js and large-mp4-preparation-order.test.js PASS.
- `git diff --check`: PASS.
- Staged files before/after: 117/117. Raw staged-entry SHA-256 unchanged:
  `6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a`.
