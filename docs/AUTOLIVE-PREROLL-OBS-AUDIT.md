# AutoLive pre-roll and OBS first LIVE

DECISION: AUTOLIVE_PREROLL_OBS_READY_FOR_MANUAL_RETEST

BASELINE: `C:/Projects/livezone-broadcast-engine-x`, branch `build/1003.3`. Authorized dirty worktree; previous full suite 575/575. No reset, restore, clean, stash, staging, commit or push.

REAL_RUNTIME_RESULT: user reports approximately 15 seconds from ONLINE to TAKE, successful Control/Public LIVE acquisition in the latest cycle, OBS remaining on A, residual LIVE/A oscillation, and successful real loss/return/cue restoration. This report is authoritative. No timestamped trace of that cycle or complete external endpoint was supplied. Findings below are code-path analysis and deterministic tests, not a claim to have reproduced the physical stream/browser incident.

CURRENT_15S_LATENCY_BREAKDOWN: the observed total cannot truthfully be split into measured browser deltas without its trace. The previous architecture had a 3000ms source-health filter followed by a separate Program surface's readiness wait, bounded at 12000ms after start. Native start also awaited play() before that deadline. These are separate waits; 3+12 is a possible timing envelope, not proof that the observed cycle spent precisely those durations there. Technical ONLINE and AutoLive's independent health ONLINE also need source/instance correlation.

The new trace provides the following boundaries. External HLS presence is established from playback, so its health consumer necessarily exists before external ONLINE; it is not a managed-publisher signal that precedes consumer creation.

| Boundary | Real reported cycle | Deterministic immediate-media test / implemented budget |
| --- | --- | --- |
| Source selection -> mapping lookup | Not measured | Existing mapping request deadline 2000ms; routing unchanged |
| HLS health consumer creation -> manifest/media | Not measured | Mock immediate; `consumer-created`, `manifest-ready` |
| Manifest/media -> first frame | Not measured | Mock immediate; `first-frame` |
| First frame -> first playback progress / external ONLINE | Not measured | Mock immediate progress; `live-player/online`, source observation |
| External ONLINE -> source filter complete | Not measured | Existing 3000ms, `stabilizing` -> `source-stabilization-complete` |
| Program candidate creation -> first frame | Not measured | Mock immediate; `preroll/surface-created` -> `preroll/first-frame` |
| First frame -> candidate's first valid progress | Not measured | Mock immediate; `preroll/stability-start` |
| Candidate progress -> stability complete | Not measured | Exactly 3000ms of wall time plus media progression in test |
| Stability complete -> actual TAKE/Program commit | Not measured | 0ms in deterministic clock; commit event ordered after stability |

The simulated immediate-media path commits at approximately 6000ms after initial health progress: 3000ms source filter plus 3000ms actual-candidate stability. There is no new blind sleep. The candidate's complete readiness/stability attempt shares a single 12000ms budget. No production wait was removed merely by assuming it explained the observed 15 seconds; the unbounded dependency on native start/play settlement was removed for pre-roll. The earlier source filter is retained because it measures a different consumer from the actual Program candidate.

PREROLL_MODEL: A remains the authoritative Program while StudioRenderer prepares a muted, connected, minimally visible background HLS surface. StudioProgramCommand passes an AutoLive-only pre-roll context through the existing transition coordinator. The coordinator cannot TAKE until the actual prepared surface passes readiness and continuous playback stability and the authorized source is still ONLINE. TAKE promotes that same warmed instance; it does not create another cold HLS player. Scheduler interruption is deferred until immediately before TAKE, and the return cue is captured at that point. The initial Preview is preserved for restoration.

STABILITY_SIGNAL: authorized source identity must match the prepared HLS surface and registered source. Media/first-frame readiness must be satisfied. Success requires multiple forward currentTime samples over the full window, at least 80% of the corresponding media-time advance, no progress gap over 1500ms, and source health ONLINE. Waiting, stalled, pause, timeline reset or a source-health epoch change resets the window. A first frame or a timer alone cannot finish it. Fatal/ended/destroyed candidates fail; stalled candidates can recover within the bounded attempt. The candidate stays muted; a pre-TAKE pause cannot invoke Program audio activation.

STABILITY_WINDOW: the existing AutoLive `ONLINE_STABLE_MS = 3000` supplies the candidate window as well as the existing source filter. Sample cadence may make actual completion later than exactly 3000ms. The overall candidate preparation deadline remains 12000ms, covering first-frame readiness and stability together.

PRE_TAKE_FAILURE_BEHAVIOR: discard candidate, preserve A and its output revision, release any reservation only if one exists, restore the original Preview when appropriate, and refresh/retry health without latching a candidate failure. No return Program command is issued for the normal failed pre-roll branch. Scheduler remains unreserved during candidate preparation. The existing canCommit/generation guards still prevent an unauthorized or superseded candidate from taking Program.

PROGRAM_TRANSITION_HISTORY: production StudioRenderer preparation, StudioHlsSurface, StudioProgramCommand, StudioTransitionCoordinator, DominantLiveController and ProgramOutputManager are exercised with simulated media/timers. Before candidate completion: `[A]`, revision `[1]`, zero TAKEs. Successful stable candidate: `[A,LIVE]`, revisions `[1,2]`, exactly one TAKE. Repeated pre-roll flaps and candidate fatal errors publish no LIVE or return revision. Tests verify promotion reuses the prepared HLS instance.

POST_TAKE_LOSS_BEHAVIOR: existing source uncertainty/5000ms grace remains unchanged. Real sustained source loss after completed pre-roll produces `[A,LIVE,A]` and one restore. Existing buffering, stale-generation and 25-transient-gap regressions pass. Return cue and Preview restoration remain intact; a dedicated new test verifies the cue is captured at actual TAKE after A has advanced during preparation.

OBS_FAILURE_BOUNDARY: the audited divergence is after snapshot acceptance. Public HLS preparation was connected, explicitly played before readiness, and had retry recovery. OBS HLS preparation was detached, native play was explicitly requested only after readiness, and the recovery method excluded OBS. These differences can leave an already-open OBS behind or unable to recover without refresh. The actual first divergence of the user's latest cycle cannot be asserted without its SSE/accepted/ready/promoted trace.

PUBLIC_VS_OBS_TRACE: both modes now attach HLS preparation, request native HLS playback before readiness, handle fatal preparation failure and retry the latest retained HLS snapshot. Their trace chain is network SSE revision -> snapshot received/accepted -> surface created -> HLS preparation/manifest -> HLS ready -> surface ready/promoted -> old surface destroyed. Existing publisher/server-store/SSE integration tests pass; Program Output transport/protocol was not changed. OBS keeps audible autoplay and Public keeps its muted/audio-gate policy. Normal recorded VIDEO/AUDIO paths retain their policies.

LONG_LIVED_SUBSCRIBER_FINDINGS: four deterministic 30-minute scenarios cover Control only, Control+Public, Control+OBS and Control+Public+OBS. Health progress and AutoLive state remain ONLINE; creation/destruction of subscribers does not change source truth or add Program revisions. In the isolated fixture there are respectively 2, 3, 3 and 4 HLS instances: health plus prepared/promoted Program plus each viewer. Real Control may additionally have Preview and selected Technical Monitor consumers; the fixture counts are not claimed as measured real-browser totals.

CONSUMER_INTERFERENCE_FINDING: no shared video element or HLS instance was found between these surfaces. The shared health code is a factory; it creates a distinct StudioHlsSurface per consumer. Each Public/OBS source also constructs its own video/HLS instance. The tests assert distinct instances, one initial loadSource per instance, unchanged health after subscriber waiting/destruction, and no health restart across 30 simulated minutes. Remote server connection limits, actual playlist timing, browser throttling and network contention were not measured by those tests. No causality is asserted for the operator's observation. Added bounded playlist-request counters, playlist sequence/fragment-count events and instance lifecycle traces permit the four real comparisons during retest; no arbitrary URLs or response bodies are logged.

ROOT_CAUSE_AUTOLIVE_OSCILLATION: the previous stability timer covered a separate health player, while the cold Program candidate needed only first-frame readiness. That did not prove sustained progression of the surface actually taken. Hidden preparation and native pending play could add latency. This is a verified gate deficiency; it is not proof that every reported post-TAKE oscillation had the same cause.

ROOT_CAUSE_OBS: verified preparation/retry asymmetry with Public after the subscriber accepts LIVE. Its role in the particular physical failing cycle remains to be confirmed with the new trace.

FIX: measurable actual-surface pre-roll, continuous-progress reset semantics, bounded preparation, deferred Scheduler reservation/TAKE-time cue capture, promotion of the same warmed instance, OBS HLS readiness/retry parity, and latency/instance/playlist diagnostics. No generic loss-grace adjustment or source-routing redesign.

TESTS_ADDED: 20 tests: 15 in `test/preroll-stability.test.js`, 5 in `test/preroll-obs.test.js`. Coverage includes all requested pre-roll, OBS and consumer-isolation cases, plus deferred cue capture and latency event ordering. Two existing request-shape assertions in `test/dominant-live.test.js` include the new internal pre-roll options.

REGRESSION_RESULTS: focused 445/445; full `node --test` 595/595, zero failures/skips/cancellations. Syntax checks for all 12 changed/new JavaScript files and `git diff --check` pass. Logs: `var/preroll-obs-focused.log`, `var/preroll-obs-all.log`, `var/preroll-new-tests.log` and narrower pre-roll/OBS test logs.

FILES_CHANGED_FOR_THIS_FIX:

- `public/js/studio/LivePlaybackStability.js` — new actual-surface progress gate.
- `public/js/studio/StudioRenderer.js` — connected bounded pre-roll and reuse of the prepared surface.
- `public/js/scheduler/StudioProgramCommand.js` — internal pre-roll context and beforeCommit hook.
- `public/js/studio/StudioTransitionCoordinator.js` — hook immediately before actual TAKE.
- `public/js/studio/DominantLiveController.js` — health epoch, pre-roll request/retry, deferred reservation and cue capture.
- `public/js/studio/renderers/StudioHlsSurface.js` — prevent pre-TAKE audio activation; frame/manifest/instance/playlist diagnostics.
- `public/js/studio/LiveHlsHealthConsumer.js` — consumer creation diagnostics.
- `public/js/public/PublicProgramController.js` — OBS HLS preparation/retry parity and playlist diagnostics.
- `public/js/core/RuntimeTrace.js` — safe numeric playlist diagnostic fields.
- `test/dominant-live.test.js` and the two new test files.
- This audit and `var/preroll-*` baseline/test artifacts.

EXISTING_UNSTAGED_WORK_STATUS: preserved. Hash comparison of 85 baseline files (media excluded) found exactly the nine intended existing files changed and no missing files. Existing media was not edited. SourcePresenceMonitor, LiveSourceMonitor, authorization config/UI, Control Desk, SchedulerEngine, output protocol/transports and entry wiring remain baseline code. Manifest: `var/preroll-obs-baseline.json`.

PROTECTED_FILES_STATUS: no .env, service, MediaMTX configuration, authentication, Program Output protocol, P0-C1B2, Scene Composition or Safe Delete changes. Existing dirty work in other areas remains intact.

GIT_STATUS: build/1003.3; worktree remains dirty with baseline plus this fix; index empty.

BLOCKERS: none for manual retest. Exact physical 15-second phase timings, the actual OBS divergence and remote-resource contention require live measurements and remain explicitly unproven.

MANUAL_RETEST:

1. Reload the updated application once. Start A, authorize testlive, arm AutoLive and keep Public/OBS already open. Confirm A continues during pre-roll and only one LIVE commit follows stable playback.
2. Exercise brief candidate stalls before TAKE: A must remain Program with no extra revision. Verify candidate reset/retry and eventual single acquisition.
3. Verify same publisherSessionId/revision in Control publication, server retained state, Public and OBS SSE/accepted/promoted traces. Delayed or failed OBS preparation must recover automatically; refreshing OBS is not the recovery mechanism.
4. Verify persistent real LIVE loss returns to A once at the captured TAKE-time cue, with Preview preserved.
5. Compare Control only, +Public, +OBS and +both over a longer live interval. Capture progress, instance lifecycle and playlist request/loaded counters; distinguish local consumer state from remote delivery failures before attributing causality.
6. Export each local tab's bounded `livezoneRuntimeTrace` immediately after a discrepancy. Compare phase timestamps by source and instance rather than inferring a 15-second breakdown from one total.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST AUTOLIVE PRE-ROLL + OBS LIVE ACQUISITION

LIVEZONE AUTOLIVE PRE-ROLL AND OBS AUDIT COMPLETE
