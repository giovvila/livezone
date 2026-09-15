# Control heavy-media resource ownership — 1003.4

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

2026-09-14; branch `build/1003.4`.

DECISION: BUILD_1003_4_CONTROL_HEAVY_MEDIA_RESOURCES_BLOCKED.

The operator now confirms MEDIA B + Preview BREAK + Public fails, and audio-12
+ Preview BREAK + Public fails. Small Preview VIDEO can also fail with audio-12
already in Program, without requiring Public. Preview media and Public startup
are therefore not necessary conditions. Motion artwork is absent from audio-12.
This audit prioritizes Control ownership and preparation; it does not patch
Public, Range serving, preload policy, AutoLive timing or Sponsor/Crawl.

## Production diagnostics added

`public/js/studio/ControlMediaResources.js` supplies bounded local diagnostics,
following the existing RuntimeTrace localhost enablement. On a normal new
Control page load at localhost/127.0.0.1, inspect:

```js
livezoneControlMediaResources.snapshot()
livezoneControlMediaResources.exportJSON()
```

The API is installed only by Control. No service restart or automatic browser
reload was performed. An already loaded Control page does not acquire new
JavaScript automatically. Non-local hostnames do not enable this diagnostic
API; do not change origin/profile merely to reproduce an origin-specific bug.

Hooks observe real Studio VIDEO, AUDIO, HLS, dynamic motion artwork and detached
Media Library metadata probes. They register before source assignment, so a
failed initial metadata load is visible. Events include creation, loadstart,
loadedmetadata, loadeddata, canplay, play requests, playback events, seek,
waiting/stalled, error, readiness failure and release. StudioRenderer adds
Program/Preview selection markers. Public is not instrumented or modified.

Each resource reports numeric identity, current owner/sourceId/kind, connected
and structurally hidden state, paused, readyState, networkState, source assigned
boolean, preload, duration/currentTime, up to four buffered/seekable ranges,
readiness, HLS presence and cleanup-pending state. Owner is resolved dynamically
after handoff: Program, Preview, prepared Program, outgoing Program, Technical,
AutoLive health, metadata probe or unassigned. Motion and audio share one surface
identity but count as distinct media elements. Detached tracked elements are
included; untracked DOM media is reported explicitly.

The diagnostics store at most 128 tracked elements and 512 events by default
(constructor maxima 256/1000), with explicit overflow. Weak references avoid
keeping surfaces/elements alive. Timeupdate sampling is throttled to once per
second per element. Release removes diagnostic event listeners. Released rows
with residual src/DOM attachment remain marked cleanup-pending until cleaned or
collected. Counts are incomplete if the overflow flag is set or untracked media
exists; HLS ownership of untracked elements cannot be inferred.

There are no polling timers, media commands, play/pause wrappers, URL/error-text
dumps, network sends, persistent writes or decoder-control operations. Readiness
and playback timing are not changed. `decoding` deliberately says
`not-measurable`: playback progression is evidence, not a hardware decoder count.
`networkLoading` is the media networkState proxy, not a request counter.
Optional JS heap and Resource Timing entry counts are sampled on demand;
Range headers and request sizes are not exposed by that API. Structural hidden
does not measure occlusion or compute layout. Historical released rows are
bounded evidence, not proof of browser-native resource reclamation.

## Actual browser capture status

Browser discovery again returned zero connected browsers. No real small/large/
audio inventory, Range waterfall, decoder pressure, heap comparison or Preview
event sequence was captured. This limitation is independent of identifying the
files: MEDIA B is `/media/demo2.mp4`, 2,242,262,600 bytes / 6,914 seconds;
audio-12 is managed asset `asset-583bed1e-99db-4f0a-9eb3-de2af775996e`,
1,035,448,480 bytes / 43,140 seconds, no artwork.

The exact failing event remains unknown. The new diagnostic export is intended
to locate whether Preview stops before allocation, source assignment, metadata,
data readiness or playback, and whether an extra owner exists at that point.
Control recorded `start()` can await play(); a never-settling native play promise
is a candidate stall, but its occurrence in the real incident is not established.
No speculative timeout/preload/decoder change was applied.

## Production-class simulations

Tests use the real StudioRenderer, SourceManager, transition coordinator,
PreviewProgramHandoff and source classes with deterministic media events. Durations
represent 34-second VIDEO, 6,914-second VIDEO and 43,140-second AUDIO. They do not
load or decode the large binaries.

| State | Program surfaces | Preview media surfaces | Prepared media | Video / Audio |
| --- | ---: | ---: | ---: | --- |
| Small VIDEO + BREAK Preview | 1 | 0 | 0 | 1 / 0 |
| Large VIDEO + BREAK Preview | 1 | 0 | 0 | 1 / 0 |
| Long AUDIO, no artwork + BREAK Preview | 1 | 0 | 0 | 0 / 1 |
| Small Preview VIDEO + small VIDEO Program | 1 | 1 | 0 | 2 / 0 |
| Small Preview VIDEO + large VIDEO Program | 1 | 1 | 0 | 2 / 0 |
| Small Preview VIDEO + long AUDIO Program | 1 | 1 | 0 | 1 / 1 |

All these simulated preparations pass. Switching Preview back to BREAK destroys
the former Preview source, clears its video reference/listeners and leaves
Program intact. BREAK owns no media element. These results are allocation
baselines for the pending real captures, not claims of real-browser success.

## Handoff and long-run ownership

Twenty VIDEO -> BREAK -> VIDEO cycles and twenty AUDIO -> BREAK -> AUDIO cycles
return to zero media instances after both buses are reset to BREAK in the
isolated fixture. The heavy Preview object is promoted directly to Program,
with peak one media instance when the outgoing Program is BREAK. No third
heavy preparation copy is created on this path.

Twenty heavy VIDEO/AUDIO alternations stay at two owned media elements: one
video and one audio. The promoted incoming object is preserved; outgoing
Program is destroyed before its replacement Preview is reconstructed. Prepared
Program returns to null each time. No monotonically growing instance count.

Twenty simulated Preview startup failures beside long AUDIO destroy each failed
candidate, retain exactly one Program audio instance and preserve Program
identity. This tests rejection/cleanup, not a browser play promise that never
settles. Existing handoff tests cover dissolve, stale startup completions,
rollback and ordinary TAKE. Actual jsdom source-hook tests independently verify
src cleanup, DOM removal and release accounting for VIDEO/AUDIO/native HLS.

The lifecycle review found explicit pause, source clearing, load/reset, element
removal, listener clearing, owner-map deletion and HLS destruction. A borrowed
Preview handoff must retain its element while changing owner; that retained
element is not a stale Preview copy. Schedule/AutoLive cold preparation can
legitimately need a separate candidate; the ordinary operator handoff invariant
must not be imposed blindly on every transition type.

## Technical and AutoLive

A production LiveSourceMonitor + StudioHlsSurface simulation beside AUDIO,
with an HLS implementation that supplies no manifest/signal, observes one
Technical video/HLS during each attempt. At its 12-second timeout the monitor
destroys it; during the 5-second retry delay ownership is zero. Three retries
never exceed one HLS instance, and the audio Program is unchanged. HLS network
and decode behavior are simulated; this is not a live ingest measurement.

Technical can own an unrelated live decoder while local media is Program. No
permanent suspension was made. Managed AutoLive uses server health polling,
not another decoder. External AutoLive shares matching Technical observations
or creates one fallback health player. Removing that player without replacing
its authority would change semantics; this audit preserves them.

## Preload and buffering

Studio VIDEO does not assign preload explicitly: browser default applies;
autoplay/explicit play can request data regardless of that hint. Studio AUDIO
sets preload=auto, including audio-12. Motion artwork uses preload=none during
Program preparation and auto when started; audio-12 has no motion element.
Library metadata probes use preload=metadata and a 12-second bound.

Whether the browser buffers aggressively for audio-12 or MEDIA B remains
unmeasured. The prior concurrent Range checks passed; they do not establish
browser memory/cache/request bounds. There is insufficient evidence to change
preload or to attribute both failures solely to file size. No server Range
modification or repeat production media transfer was needed in this turn.

## Resource budget and decision

Measured fixture ownership suggests the following invariants, not runtime caps:

- One base media surface per occupied Program/Preview bus.
- No additional incoming base surface for an eligible promoted Preview handoff.
- No stale owner after failure, cancellation or completed transition.
- One selected Technical HLS attempt, zero between no-signal retries.
- At most one independent external health player when Technical cannot supply it.
- Motion artwork and legitimate cold preparation/outgoing transitions are
  separately accounted for, not silently omitted from the budget.

FIRST_DIVERGENCE: not observed in the failing browser.
ROOT_CAUSE: not proven; no duplicate/stale surface reproduced in the fixtures.
FIX: bounded production diagnostics and regression tests only.
RESOURCE_BUDGET_AFTER_FIX: no behavioral/resource-limit fix claimed; invariants
above pass in simulation.
PUBLIC_SECOND_TAB_RESULT: still FAIL by operator evidence; not retested here.
TEST_FIDELITY_GAP: no real decoder, heavy-file loading, native memory pressure,
Range waterfall or exact Preview failure trace. Real resource inventory is
still required before changing ownership/preload policy.

## Validation and manual capture

TESTS_ADDED: 16 total: nine diagnostics/production-hook/Technical tests and seven
Control inventory/repeated-handoff/failure tests. Existing normal TAKE, AutoLive,
Sponsor/Crawl, Public/OBS and Media Library regressions are retained.

FOCUSED_TEST_RESULT: 264/264 PASS (`var/control-resources-focused.log`).
FULL_TEST_RESULT: 1421/1421 PASS, zero failures/skips (`var/control-resources-full.log`).
SYNTAX_RESULT: nine changed/new JavaScript files PASS.
DIFF_CHECK_RESULT: PASS (`var/control-resources-diff.log`, empty).
STAGING_STATUS: exactly 117 files, unchanged SHA-256 of `git ls-files --stage -z`:
`6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a`.

Capture the exported inventory and event history at these operator-controlled
points, with Technical selection recorded:

1. Small VIDEO Program + BREAK Preview, before/after Public.
2. MEDIA B Program + BREAK Preview, before/after Public.
3. audio-12 Program + BREAK Preview, before/after Public.
4. audio-12 Program, immediately before small Preview selection and after failure.

Compare owner IDs, created/released deltas, cleanupPending, readiness/events,
buffered ranges and browser metrics. Capture the browser network waterfall for
Range sizes/concurrency; those details cannot be reconstructed from the redacted
inventory. Do not equate an element count with decoder use or a passing simulated
Preview preparation with resolution of the operator failure.

BLOCKERS: no connected operator browser; real first divergence remains unknown.
NEXT_STEP: MANUAL RETEST LARGE VIDEO / LONG AUDIO + PREVIEW + PUBLIC.

No production bus selection, TAKE, event, DELETE, service restart, stage,
unstage, reset, commit or push was performed. The provisional index remains
protected. Public and Range code are untouched by this task.
