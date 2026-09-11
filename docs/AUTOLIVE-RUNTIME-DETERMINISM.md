# AutoLive runtime determinism investigation — 2026-09-08

## DECISION

AUTOLIVE_RUNTIME_DETERMINISM_BLOCKED

Subscriber defects were reproduced and fixed. Source-loss determinism and the first divergence in the operator's actual successful/failed runs remain unproven. Automated tests are not browser/OBS certification.

## BASELINE

Authorized dirty worktree, preserved. HEAD `2ad3fc1ea361022bf0ed5c78f0e91d0fd42d5c19`, branch `build/1003.3`, divergence `0 / 0`, staging empty.

## SUCCESS_CASE_TRACE

Operator-confirmed: A → LIVE → loss → A near captured cue; Preview P remains P. No timestamped browser trace of that run was available. Existing tests exercise actual health consumer/monitor timeout → session close → restore command/cue.

## FAILURE_CASE_TRACE

Operator-confirmed: frozen LIVE without restoration, intermittent stale OBS and Public. New deterministic reproductions: ready LIVE plus unresolved `play()` leaves old A current; preparation error retains old A; coalesced cue 40 promotes a surface still positioned at original cue 20; audio unlock after ten seconds resumes at stale cue 20 instead of current cue 30. These cases failed before this change and pass afterward.

## FIRST_STATE_DIVERGENCE

Reproduced subscriber boundaries are readiness → awaited play → promotion, and newest accepted playback snapshot → original preparation cue. Actual source-loss success/failure divergence requires the new traces; it has not been fabricated from tests.

## SOURCE_HEALTH_MODEL

AutoLive still does not consume authoritative publisher state. Its browser health consumer cannot distinguish a connected publisher from advancing buffered/replayed HLS frames. No local MediaMTX health signal was attached to arbitrary HLS sources without confirming their identity.

## PLAYER_HEALTH_MODEL

Readiness plus advancing currentTime qualifies ONLINE. Five seconds without progress reports loss. Retry creates another player; buffered progression can qualify ONLINE again and cancel grace. This remains a conflation of player health and source health.

## MEDIAMTX_STATUS_AUDIT

Read-only `/v3/paths/list` against the existing loopback API returned HTTP 200. The configured default path `livezone-test` reported `online:false`, `ready:false`, no source, zero tracks. The installed API includes `online`, `onlineTime`, `ready`, `readyTime`, `source`, `tracks`, and `tracks2`, matching the client's current online/tracks2 model for this inactive response.

`MediaIngestStatusClient` checks the configured path, online/source/tracks, then HLS usability. Missing/offline path returns offline; malformed/unavailable API returns error. The operator endpoint `/api/media-ingest/status` returned 401 without a session, confirming the existing protected boundary. No authentication or MediaMTX configuration was changed.

Limitations: no active-publisher/disconnect pair was captured; the tested authorized LIVE source has not been confirmed to map to this configured input. The endpoint supplies request/response status, not continuous publisher events. The list lookup also uses the returned page. Its fetch timeout is cleared before response-body parsing, so it is not yet a proven end-to-end deadline under a stalled body. Do not introduce this client as a guaranteed-deadline AutoLive authority without resolving those constraints.

## LOSS_COMPLETION_UPPER_BOUND

Conditional player-loss bound: five-second progress watchdog + five-second retry/grace + twelve-second failed retry = approximately **22 seconds after final playback progress**, with timely event-loop execution and no intervening false ONLINE. Grace already remembers expiry during CHECKING; retry timeout supplies OFFLINE.

There is **no guaranteed finite bound from publisher disconnection**: unknown buffered duration precedes the watchdog, and progressing cached retries can cancel loss repeatedly. The three-second acquisition stabilization does not bound loss. Browser background suspension can also delay timers. A global publisher-loss bound is not claimed or implemented by this patch.

## PERMANENT_LOSS_GRACE_PATH

Existing monitor tests prove silent CHECKING retries terminate through the twelve-second timeout. Repeated genuine OFFLINE does not restart the same grace. The unresolved path is repeated false recovery from buffered playback, not proof that the current CHECKING callback simply forgets the pending loss. New trace records expose monitor/consumer/session generations, attempts, deadlines, and state transitions to distinguish them in the failing browser.

## PROGRAM_REVISION_SUCCESS_CASE

No real A → LIVE → A revision history was captured for the operator's successful run. Automated transport/store tests cover revision retention and delivery. New tests use the actual network transport handler/envelope validation and public controller to process A → LIVE → A, with cue 37.

## PROGRAM_REVISION_FAILURE_CASE

Read-only SSE inspection during this investigation returned retained media revision 3, published at `2026-09-08T10:04:35.375Z`. This single sample cannot establish the missing revision in an earlier failure. The prior turn's LIVE revision 5 is a different observation and must not be combined into a fabricated same-session history.

## PUBLIC_FAILURE_BOUNDARY

Proven code defects: unresolved play can prevent promotion; failure only updates status while keeping obsolete content; pending snapshot coalescing can retain an obsolete cue. Actual observed failure's first boundary remains to be identified from per-tab trace.

## OBS_FAILURE_BOUNDARY

The same defects reproduce in obs mode. This does not establish that each observed OBS failure had that cause. Audible defaults, output shell, and revision validation are preserved.

## FRESH_VS_OPEN_SUBSCRIBER

Both modes share transport validation, revision handling, source creation, and expected-time calculation. An open subscriber additionally has an outgoing surface and may coalesce pending updates. New tests compare fresh source creation with an already-open subscriber at the same accepted snapshot and clock. A failed preparation now explicitly becomes unavailable (black in OBS), rather than continuing to represent an obsolete Program. This is bounded failure handling, not a guarantee that unavailable media can render successfully without another attempt.

## HLS_LIFECYCLE_FINDINGS

VIDEO/HLS preparation now has cancellation; superseded waits and resources are released, and stale manifest/play/error callbacks cannot reactivate destroyed instances. Promotion does not await an unbounded play promise. Existing twelve-second readiness timeout remains. Seek has its own existing bounded timeout. Outgoing LIVE errors do not own the incoming A generation. Cleanup is idempotent. Rejected dissolve completion releases the outgoing entry without an unhandled rejected `finally` promise.

## ROOT_CAUSE_AUTOLIVE

Publisher presence is not observed independently from player progress. The actual intermittent failing sequence is still uncaptured; no authoritative source integration was added speculatively.

## ROOT_CAUSE_PUBLIC

Reproduced stale preparation/promotion and cue handling defects; runtime correlation pending.

## ROOT_CAUSE_OBS

Reproduced shared promotion defects; runtime correlation pending.

## PUBLIC_PLAYBACK_TIME_ROOT_CAUSE

Two proven defects: coalescing updates the pending snapshot but source creation seeks using its original snapshot; ENABLE AUDIO previously played without recalculating the current Program time. Playback resuming after browser stalls also lacked event-driven catch-up. These are concrete failure paths, not proof that the operator's Public browser encountered each one.

## OBS_PLAYBACK_TIME_REFERENCE

The operator confirms ordinary OBS media follows Program time. Existing audible autoplay tests pass. Both modes use `initialTime + elapsed since startedAt`, clamped to duration. No publisher/protocol change was needed for the reproduced synchronization defects.

## PUBLIC_VS_OBS_PLAYBACK_DIFFERENCE

Public starts muted and exposes ENABLE AUDIO; OBS starts audio-enabled. Public VIDEO is intended to advance even while muted; there is no branch deliberately discarding its playback revisions. A blocked/paused Public player can spend time behind the audio gate while Program advances. The defects in pending preparation are shared by both modes.

## PLAYBACK_SYNC_FIX

Promotion applies the newest accepted playback state/cue. Promotion, native `playing`, and audio unlock catch up against the existing Program anchor. Event-driven drift correction uses a 0.5-second tolerance to avoid seek/playing feedback. The user gesture still requests audible playback directly. Newer generation/snapshot ownership guards stale asynchronous completion. No periodic synchronization polling or protocol fields were added.

## PLAYBACK_SYNC_TESTS

Both modes: original cue; newer cue arriving during readiness; restoration at cue 37; post-creation cue update to 42; later playing event catches up to 45; fresh/open position equivalence; stale readiness cannot reset cue; audio unlock after ten seconds catches up from 20 to 30. Existing paused/ended and audio authorization tests remain enabled. The old audio-recovery fixture now supplies an explicit clock instead of relying on a weeks-old timestamp.

## FIXES_IMPLEMENTED

- Subscriber promotion, bounded preparation-failure behavior, cancellation/cleanup, and timeline synchronization described above.
- Local-only development trace, capped at 1,000 entries per page; media samples at most once per second. No network export or storage writes. Explicit allowlist excludes URLs, raw snapshots/errors, tokens, cookies and credentials.
- Monitor/controller/health consumer, publication, HTTP acknowledgment, SSE receipt, accepted/rejected revisions, surface lifecycle, and playback diagnostics instrumented. AutoLive policy itself remains unchanged in this turn.

## PREVIEW_REGRESSION_STATUS

Existing tests pass. No Preview semantics changed; interrupted A is not copied into operator Preview P.

## RETURN_CUE_REGRESSION_STATUS

Existing AutoLive capture/restore tests pass; new subscriber tests verify returned cue 37 and subsequent timeline progression.

## TEST_FIDELITY_IMPROVEMENTS

New tests execute the real subscriber controller, source-creation path, network transport handler and envelope validation. Media events and HLS adapter are controlled fakes; readiness is asynchronous and play can remain pending. These improve on replacing createSource with an immediately resolved promise but do not execute a browser decoder, real EventSource networking in that test, or OBS/CEF. Existing separate HTTP/SSE server tests remain in the regression suite.

## TESTS_ADDED

15 tests in `test/runtime-determinism.test.js`, including timeout, stale generation, SSE/HLS replacement, cue timing, audio gate, fresh/open convergence, and trace bounds/redaction. Source-health/buffered-publisher upper-bound requirements remain incomplete, not silently marked covered by player-health tests.

## REGRESSION_RESULTS

Focused suites: 328/328 pass. Full suite: 431/431 pass. Syntax and diff checks are recorded in the final response.

## FILES_CHANGED_FOR_THIS_FIX

`public/js/core/RuntimeTrace.js` (new), `public/js/public/PublicProgramController.js`, `public/js/program-output/ProgramOutputManager.js`, `public/js/program-output/NetworkProgramOutputTransport.js`, `public/js/studio/LiveSourceMonitor.js`, `public/js/studio/DominantLiveController.js`, `public/js/studio/DominantLiveHealthConsumer.js`, `test/program-output-network.test.js`, `test/runtime-determinism.test.js` (new), this report (new).

## EXISTING_UNSTAGED_WORK_STATUS

Preserved; edits extend the authorized baseline. No reset, restore, checkout, stash, clean, staging, commit or push.

## PROTECTED_FILES_STATUS

No protected file, environment, runtime service/configuration or persisted Studio data was modified by this investigation.

## GIT_STATUS

Original dirty path set retained; intentional new files are the trace module, determinism tests and this report. Staging remains empty.

## BLOCKERS

No connected authenticated browser/OBS capture; no matched real success/failure traces; no verified association of the tested LIVE source with the configured MediaMTX input; no publisher-disconnection upper bound. These block full-chain determinism approval despite the passing tests and concrete subscriber fixes.

## MANUAL_RETEST

Load this build in Control, Public and OBS before the scenario. Keep those sessions open throughout; do not refresh to recover a transition.

1. Put VIDEO A at a nonzero cue in Program and P in Preview. Compare Control/Public/OBS clocks while playing, while Public is muted, and after ENABLE AUDIO. Allow approximately 0.5 seconds for event-driven alignment after readiness/seek.
2. Start the LIVE publisher and AutoLive. All three outputs should show LIVE; P stays P.
3. Stop the actual publisher with different amounts of buffered playback. Record the publisher stop time. Compare whether Control restores A, whether a restored revision is acknowledged/delivered, and whether each subscriber promotes it. Confirm A resumes near the captured cue.
4. Briefly stop/reconnect inside grace. Confirm no flash to A, no ownership churn and preserved Preview.
5. Take B manually during AutoLive, then lose LIVE. B must remain authoritative.
6. Repeat until both the success and intermittent failure are captured, if failure persists. Do not infer a source-lifecycle success merely from a subscriber showing unavailable/black.

Trace capture, on each loopback page after the scenario (no timing-sensitive breakpoint needed):

```js
livezoneRuntimeTrace.download()
```

Alternatively, `livezoneRuntimeTrace.exportJSON()` returns the bounded JSON. Save each page's capture separately as Control/Public/OBS and success/failure. Export before closing the page. No trace is persisted across navigation. OBS capture needs access to its existing browser debugging context; do not enable services or alter OBS authentication for this task. If that context is unavailable, explicitly record OBS trace as unavailable instead of substituting a Public trace.

Compare sequence: autolive acquire/health/grace/restore → program-output publish-attempt → network publish-success → network sse-revision → public/obs snapshot-accepted → surface-ready → surface-promoted → surface-destroyed. A missing restore/publication separates source lifecycle from subscriber rendering. Acknowledged revision plus missing subscriber receipt locates the transport boundary. Receipt plus missing promotion locates rendering/readiness. Samples include expected and actual playback time and player state.

## NEXT_STEP

MANUAL RETEST AUTOLIVE + PUBLIC + OBS DETERMINISM

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

LIVEZONE AUTOLIVE RUNTIME DETERMINISM AUDIT COMPLETE
