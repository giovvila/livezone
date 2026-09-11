# External HLS stability and Public promotion

DECISION: AUTOLIVE_EXTERNAL_HLS_PUBLIC_READY_FOR_MANUAL_RETEST

BASELINE: `C:/Projects/livezone-broadcast-engine-x`, branch `build/1003.3`, authorized dirty worktree. Previous full suite: 555/555. No reset, restore, clean, stash, stage, commit or push.

REAL_RUNTIME_STATUS: the user's browser confirms external testlive routing and acquisition work independently of local-main, while reporting occasional AutoLive flap and intermittent Public promotion despite OBS following Program. No timestamped browser trace of those failures was supplied in this task. Findings below distinguish code paths and deterministic reproductions from a newly observed real-browser failure; the latter remains for manual retest.

EXTERNAL_HLS_FALSE_LOSS_ROOT_CAUSE: the first overly strong edge in the audited code was `StudioHlsSurface.handleWaiting()` -> health `stalled` -> shared consumer `reportLoss()` -> `handlers.offline()`. Normal buffering immediately became confirmed absence. LiveSourceMonitor scheduled consumer replacement at 5000ms before notifying AutoLive; its retry CHECKING could be normalized back to OFFLINE at the same boundary as AutoLive's grace expiry. The controller itself did not restore at first OFFLINE or grace start: it restored at expiry, but its verdict could be based on this weak evidence and replacement boundary. Also, native surface startup awaited play() before health observers attached, and backward HLS timeline discontinuities could leave progress compared against an obsolete larger currentTime.

HEALTH_EDGE_TRACE: bounded RuntimeTrace now records unthrottled health/event edges and throttled progress samples, source ID, consumer/monitor/HLS generation, instance identity, currentTime, readyState, networkState, paused/ended, last progressing media time and lastHealthyAt. The trace entry supplies timestamp/sequence. HLS fatal and nonfatal warnings record only a classified reason. A consumer owns one HLS/native instance; its consumer generation is also its HLS instance generation. AutoLive health traces add session/controller generation, active/expired grace and deadline. Source-level uncertainty deadlines and grace cancel/start/expire plus existing acquire/restore/effective-transition events permit correlation. No raw URLs, tokens, arbitrary error payloads or snapshots are added. Existing local-only trace capacity remains 1000 entries by default.

LOSS_GRACE_BEHAVIOR: waiting/stalled or a progress watchdog edge first publishes CHECKING with `uncertain: true`. The active consumer remains available for recovery. A 5000ms source-level confirmation deadline survives retries and cannot be extended by repeated uncertainty. Advancing playback cancels both source uncertainty and the controller's unchanged 5000ms grace. Fatal active-player recovery can replace the consumer after 1000ms, within that same deadline. Only an unrecovered deadline confirms OFFLINE. A silent frozen player is detected by the existing 5000ms progress watchdog, then has the finite 5000ms confirmation window; explicit waiting/error begins uncertainty immediately. Startup still has the existing 12000ms readiness timeout. Authorization, stabilization duration and managed publisher semantics are unchanged.

PROGRAM_TRANSITION_HISTORY: deterministic tests drive the actual shared HLS consumer, LiveSourceMonitor, SourcePresenceMonitor, DominantLiveController, StudioProgramCommand, StudioTransitionCoordinator and ProgramOutputManager. Browser media and renderer decoding are simulated. Transient waiting, stalled, paused progression, consumer replacement and timeline reset produce retained revisions `[1,2]`, scenes `A -> LIVE`, and one TAKE. Sustained waiting produces revisions `[1,2,3]`, scenes `A -> LIVE -> A`, one interruption close and cue 37. Twenty-five transient gaps retain the same session with no extra revision. Stale ONLINE/OFFLINE callbacks and a queued obsolete confirmation deadline are rejected.

AUTOLIVE_FIX: explicit uncertainty in the shared monitor; bounded source confirmation independent of consumer generation; in-place buffering recovery; native observers attached without awaiting play(); timeline baseline reset followed by fresh forward progress; stale deadline token invalidation. SourcePresenceMonitor changes are confined to external observation normalization, allowing uncertain CHECKING through. Its authority classification, descriptor lookup, pinned ingest identity and managed poll path are untouched.

OBS_REFERENCE_TRACE: the same revision is delivered through NetworkProgramOutputTransport's SSE handler to the OBS and Public modes of PublicProgramController. Both record SSE reception, accepted snapshot, created surface, HLS readiness, surface readiness and promotion. OBS retains its audio-enabled policy and preparation behavior; its entry and output transport/protocol were not edited.

PUBLIC_TRACE: existing network `sse-revision` events correlate with per-mode `snapshot-received`, `snapshot-accepted`, `surface-created`, `hls-prepare-start`, `hls-manifest`, new `play-request` and `hls-ready`, `surface-ready`, `surface-promoted`, `surface-failed` and retry events. Ready state, mute state, playback/network state and revision are safe fields. These traces are intended to identify the first divergence if a real-browser failure remains.

PUBLIC_FIRST_DIVERGENCE: deterministically reproduced in preparation after snapshot acceptance. Public with previously enabled audio prepared new HLS unmuted; native HLS only explicitly called play() after readiness, although some implementations require play() to begin decoding. A separate reproduced path let a failing outgoing HLS schedule a retry of the latest snapshot and replace its still-pending preparation. No real-browser trace is claimed to establish which of these branches caused the user's intermittent incident.

PUBLIC_AUDIO_GATE_FINDING: muted Public was already the default, but audio-enabled replacements inherited unmuted state during preparation. New Public HLS always prepares muted, including after audio was previously enabled. Stored audio preference is attempted only after visual promotion, without awaiting the audible play promise; rejection falls back to muted playback and the existing audio button. OBS audio behavior and normal recorded VIDEO/AUDIO gates are preserved.

PUBLIC_PROMOTION_FINDING: Public now explicitly starts native HLS while waiting for loadeddata/canplay, with listeners installed first; readiness is independent of play promise settlement. Preparation stays connected at minimal nonzero opacity. HLS.js fatal preparation errors have an immediate controlled failure/retry path instead of waiting out all 12000ms. Outgoing-player errors cannot replace a newer pending surface. A preparation timeout releases obsolete A and retries the latest LIVE after 1000ms; obsolete callbacks cannot promote an old surface.

PUBLIC_FIX: preparation/play/readiness ordering, muted preparation with post-promotion audio attempt, explicit HLS-ready diagnostics, abortable readiness cleanup, fatal-preparation rejection, and protection of pending latest preparation from outgoing-player retries. No Program Output contract, server protocol or normalization changes.

FRESH_VS_OPEN_RESULT: deterministic retained-LIVE and already-open A -> LIVE cases converge to the same snapshot. Public and OBS accept/promote the same SSE revision; delayed readiness, nonsettling play and audio rejection do not hold old A indefinitely.

RETURN_PATH_REGRESSION: LIVE -> A revision 3 and cue 37 pass in Public and OBS. Existing tests for Preview restoration, operator override, normal media/audio/TAKE, Scheduler continuity, authorization/armed persistence, browser timer binding, source routing and Control Desk pass.

TESTS_ADDED: 20 tests across `test/external-hls-stability.test.js` (11) and `test/external-hls-public.test.js` (9). They cover all requested cases, grouping related assertions into integration scenarios. Existing consumer-retry tests were updated to assert uncertainty before confirmation, and the existing audio test now expects replacement preparation muted while preserving permission. New promotion tests assert the saved audio preference is applied afterward. `var/external-hls-public-before.log` records the Public muted-preparation regression failing before its fix.

REGRESSION_RESULTS: focused suite 425/425; full `node --test` 575/575, zero failures/skips/cancellations. Syntax checks on all 11 changed/new JavaScript files and `git diff --check` pass. Logs: `var/external-hls-public-focused.log`, `var/external-hls-public-all.log`. Smaller new-test runs are retained in `var/external-hls-public-new-tests.log` and `var/external-hls-stability-focused.log`.

FILES_CHANGED_FOR_THIS_FIX:

- `public/js/studio/LiveHlsHealthConsumer.js`: uncertainty, immediate observer registration, timeline reset, health edges.
- `public/js/studio/LiveSourceMonitor.js`: finite uncertainty and retry lifecycle.
- `public/js/studio/SourcePresenceMonitor.js`: external uncertainty normalization only.
- `public/js/studio/DominantLiveController.js`: accept generic uncertainty and grace diagnostics; no timer duration changes.
- `public/js/public/PublicProgramController.js`: Public HLS preparation/promotion/retry and diagnostics.
- `public/js/studio/renderers/StudioHlsSurface.js`: HLS error/warning diagnostics only.
- `public/js/core/RuntimeTrace.js`: safe numeric/boolean diagnostic fields.
- `test/dominant-live.test.js`, `test/program-output-network.test.js`: existing assertions updated for new semantics.
- The two new test files, this audit and the `var/external-hls-*` logs/baseline manifest.

EXISTING_UNSTAGED_WORK_STATUS: preserved. Hash comparison of 76 baseline files, excluding existing media assets, found exactly the nine intended existing files changed and no missing files. Media assets were not edited. Baseline manifest: `var/external-hls-public-baseline.json`.

PROTECTED_FILES_STATUS: no changes to .env, services, MediaMTX configuration, authentication, Program Output protocol, P0-C1B2, Scene Composition or Safe Delete. Authorization config/UI, source-authority classification, local/managed routing, Control Room wiring, OBS entry, scheduler/Program command and Control Desk remain baseline code.

GIT_STATUS: branch build/1003.3; dirty worktree retained with these additions; index remains empty.

BLOCKERS: none for manual retest. Real external endpoint decoding, autoplay policy and the first divergence in an actual failing Public browser session remain browser-verification items; automated tests simulate those boundaries.

MANUAL_RETEST:

1. Refresh Control, OBS and Public to load the new modules. Keep mapped local-main offline and authorize external testlive. Start Program A with a recognizable cue; enable Scheduler and AutoLive.
2. Verify Control/OBS/Public converge to LIVE. Repeat with Public already open on A, freshly opened during retained LIVE, and after previously enabling Public audio. LIVE must display before any new audio interaction.
3. Exercise a brief external HLS disturbance: the trace should show uncertain CHECKING/grace start, then progress/grace cancel; Program revisions must remain A -> LIVE.
4. Exercise sustained loss: confirmed OFFLINE and grace expiry should restore A once, with the interrupted cue and Preview. Verify Public/OBS return on the same revision.
5. For any discrepancy, export `livezoneRuntimeTrace` from Control, Public and OBS immediately. Compare publisherSessionId/revision, network SSE acceptance, created/ready/promoted surface and HLS edges. The in-memory local trace is bounded, so capture it promptly.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST EXTERNAL HLS AUTOLIVE STABILITY + PUBLIC VIEWER

LIVEZONE AUTOLIVE EXTERNAL HLS AND PUBLIC VIEWER AUDIT COMPLETE
