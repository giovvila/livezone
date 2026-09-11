# AutoLive acquisition latency and runtime loss slate

DECISION: AUTOLIVE_LATENCY_SLATE_READY_FOR_MANUAL_RETEST

BASELINE: Authorized dirty worktree, branch build/1003.3, reported suite 605/605. No reset, restore, clean, stash, staging, commit or push.

REAL_RUNTIME_RESULT: The user's authoritative result is approximately 30 seconds from Technical ONLINE to TAKE, followed by LIVE → A → LIVE without a visible slate. This run did not have a connected browser (browser discovery returned no available sessions). The exact real 30-second trace and the sole cause of the missing slate therefore remain unmeasured. The following findings are source-level findings backed by deterministic and HTTP integration tests, not a claimed real-browser PASS.

ACQUISITION_TIMELINE:

The production trace now covers Technical state, source health, candidate creation, HLS manifest, first frame, playing, first advancing sample/stability start, stable, commit start and committed. Each record has a timestamp and delta; candidate instance IDs distinguish consumers. No URL, token or raw error is added to the broadcast slate.

| Marker | Runtime event | Immediate native candidate test | First frame delayed to 10s test |
| --- | --- | --- | --- |
| T0 Technical ONLINE | technical-monitor/state ONLINE | Not a real Technical UI measurement | Not a real Technical UI measurement |
| T1 source confirmed | source-health/external-hls-observation ONLINE | 0 ms | 0 ms |
| T2 Program candidate created | preroll/surface-created | 0 ms | 0 ms |
| T3 manifest ready | live-player/manifest-ready | Native test: not independently observable | Native test: not independently observable |
| T4 first frame ready | preroll/first-frame | 0 ms | 10000 ms |
| T5 playback begins | live-player/playback-begins | Simulated media; no real playing latency measured | Simulated media; no real playing latency measured |
| T6 first currentTime advance | first advancing preroll sample | 0 ms | 10000 ms |
| T7 stability starts | preroll/stability-start | 0 ms | 10000 ms |
| T8 stability completes | preroll/stable | 3000 ms | 13000 ms |
| T9 commit starts | autolive/program-commit-start | 3000 ms | 13000 ms |
| T10 TAKE committed | autolive/program-committed | 3000 ms | 13000 ms |

Measured deterministic deltas: T1→T2 = 0; T2→T4 = 0 or 10000; T7→T8 = 3000; T8→T10 = 0. The test advances another 500 ms after commit to settle and inspect state; this is not acquisition latency. These tests assert the actual production trace timestamps.

THIRTY_SECOND_ROOT_CAUSE: An exact causal allocation of the real approximately 30 seconds is not available. Three concrete amplification mechanisms were found: a separate cold external health consumer despite an already matching Technical observation; an additional serial 3-second source-only sleep before the actual playback gate; and a shared preparation deadline that discarded a healthy late candidate because readiness consumed its stability time. The last defect was reproduced before its fix: first frame at 10 seconds left only 2 seconds of the 12-second total, making the required 3 seconds impossible. The regression failed with zero commits and now commits the same candidate at 13 seconds. Discard/retry can add another cold readiness cycle and source refresh, consistent with a long observed delay, but not proof of the precise real 30-second sequence.

DUPLICATE_READINESS_FINDING: Technical, external health and Program candidate were separate HLS consumers. AutoLive's command can also prepare Preview through the existing Preview selection path. This task leaves that normal command/Preview path unchanged. A matching Technical source ID AND exact endpoint now supplies external health observations without another health decoder or readiness cycle. If Technical selects something else, a dedicated fallback consumer takes over. SourcePresenceMonitor still performs its existing trusted mapping/authenticated probe before choosing external health; managed ingest routing is unchanged.

PREROLL_SURFACE_REUSE: The dedicated Program candidate still proves its own playback stability; the Technical player is not moved out of its monitor. That same prepared Program renderer becomes Program. Tests assert instance identity and no additional surface at TAKE. The architecture is: confirmed source observation → one Program candidate → one 3-second continuous playback proof → promote that candidate.

SHORT_LOSS_TRACE: Both explicit OFFLINE at relative t0 with ONLINE at t0+3000 and a real Program video waiting event while the independent source observer remains ONLINE are tested. Slate request and Program graphics publication happen at loss notification, before any return. Healthy advancing Program playback removes player-loss presentation; healthy source observations clear source-loss grace. Both preserve the original AutoLive session.

FIRST_A_RESTORE: In the corrected deterministic short-loss tests there is no A restore. For persistent confirmed source loss, the first restore is DominantLiveController.endSession(source-loss) → finishSession → restoreReturnTarget → StudioProgramCommand after the five-second grace. A new hard guard rejects restoreReturnTarget while any session is active or grace timer/expired ownership remains. Player-only uncertainty does not declare the source absent or close ownership.

SLATE_REQUEST_TRACE: loss-slate/binding-start → autolive/program-loss or source health uncertainty/grace → loss-slate/show-request → loss-slate/control-rendered → program-output/publish-attempt with lossSlateActive=true → network publish response → subscriber SSE revision. Program output validation failures now emit snapshot-rejected rather than silently disappearing from the trace. This instrumentation will distinguish a bootstrap/subscription problem, a rejected snapshot, and an external return during the next real retest.

SLATE_PROGRAM_MODEL: Same LIVE scene, source, ownership session, return target and committedAt. Only the existing version-1 graphics representation contains the reserved autolive-loss-slate image. Control uses the same safe presentation as Public/OBS. No normal BREAK command, no new scene or ownership, and no return-target capture is performed for the slate.

SLATE_PUBLICATION_TRACE: A production ProgramOutputManager snapshot is accepted by the server ProgramOutputStore and retained with the reserved graphic. A real ephemeral HTTP server accepts the slate envelope with HTTP 202; independent Public and OBS late SSE subscriptions receive that graphic and render the fixed text. Existing subscriber tests prove graphics-only recovery retains the LIVE player and rejects stale revisions. This is HTTP/DOM integration evidence, not physical OBS rendering evidence.

ROOT_CAUSE_SLATE: The previous presentation listened only to the independent source-health controller. It did not observe the HLS surface actually in Program. Therefore Program waiting, frozen progression or a fatal Program player could not directly request the slate while a separately buffered health player still reported ONLINE. This missing runtime path is reproduced and fixed. Without the user's browser trace, it is not possible to establish that this gap was the sole cause of the reported slate never appearing; the new request/publication trace makes that remaining distinction observable.

FIX_LATENCY:
- Reuse exact matching Technical health observations after external routing is authorized; fall back safely on Technical selection changes, with generation-guarded callbacks.
- Install LiveSourceMonitor's readiness deadline before starting a consumer, so a synchronous shared ONLINE cancels it instead of leaving a spurious 12-second loss callback.
- Production bootstrap enables immediate Program preparation on confirmed source ONLINE for the deferred-commit command. The actual 3-second playback stability barrier remains authoritative; legacy command paths retain their source-only delay.
- Keep first-frame readiness bounded at 12 seconds. Give a valid late first frame at least the existing 3-second stability window plus the existing 1.5-second maximum allowed progress-event gap. Early candidates retain the prior 12-second total bound. Per candidate the maximum is 12 seconds of readiness plus 4.5 seconds of stability observation; success still requires the full continuous advancing 3 seconds. Failed candidates can retry, so there is no unconditional end-to-end bound for an unhealthy stream or a throttled browser.

FIX_SLATE:
- Bind to the active Program video's waiting/stalled/fatal events and advancing playback, with the existing five-second progress watchdog.
- Keep player loss separate from confirmed source loss and preserve the same ownership session.
- Rebuild only a fatally failed HLS player after a bounded retry, without a TAKE or return-target recapture; hide the slate only on advancing recovered playback.
- Guard observer callbacks and rebuild timers by session, renderer identity, scene and observer generation. Operator TAKE detaches them.
- Retain the slate while the return to A is being prepared; clear it on the actual Program change.
- Add the hard return ownership invariant and trace the presentation through publication.

TRANSIENT_PROGRAM_HISTORY: A → LIVE → LOSS SLATE → LIVE; one AutoLive session, no A during grace, no extra capture.

PERSISTENT_PROGRAM_HISTORY: A → LIVE → LOSS SLATE → A, one confirmed-loss return.

CUE_RESTORE_REGRESSION: PASS. Captured 37-second media cue survives the slate and is used for the single return.

PREVIEW_REGRESSION: PASS. Existing nonempty Preview preservation tests pass; slate and player recovery do not issue Preview commands.

PUBLIC_REGRESSION: PASS in automated normal TAKE/pre-roll, slate, retained HTTP/SSE, late subscriber and recovery tests. No PublicProgramController production behavior was edited in this task.

OBS_REGRESSION: PASS in the corresponding automated normal TAKE/pre-roll and shared retained-slate tests. Actual OBS/browser manual verification remains required.

TESTS_ADDED: Eleven tests: shared Technical ONLINE/no cold health cycle/no stale readiness timer; Technical selection fallback; immediate preparation/same candidate/single 3s gate; healthy late first-frame regression; Program waiting while source ONLINE with real retained-store representation; explicit 3s OFFLINE/recovery; persistent OFFLINE/cue restore; operator override detaches old Program callbacks; fatal Program player rebuild retains session; operator override cancels stale rebuild; real HTTP/SSE slate to both Public and OBS. Existing tests also cover Preview, cue, persistent grace, repeated errors, stale callbacks, source routing, normal acquisition and subscriber playback.

REGRESSION_RESULTS: Focused 254/254 PASS; full node --test 616/616 PASS. Logs: var/latency-slate-focused.log and var/latency-slate-all.log. Before/after regression logs: var/latency-slate-late-frame-before.log and var/latency-slate-late-frame-after.log. Syntax and git diff --check pass.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/entries/control-room-app.js
- public/js/studio/SharedLiveHealthConsumer.js (new)
- public/js/studio/LiveSourceMonitor.js
- public/js/studio/DominantLiveController.js
- public/js/studio/AutoLiveLossPresentation.js
- public/js/studio/StudioRenderer.js
- public/js/studio/LivePlaybackStability.js
- public/js/core/RuntimeTrace.js
- public/js/ui/TechnicalLiveMonitorUI.js (trace only)
- public/js/studio/renderers/StudioHlsSurface.js (trace only)
- public/js/program-output/ProgramOutputManager.js (rejection trace only)
- test/autolive-shared-health.test.js (new)
- test/external-hls-stability.test.js
- test/external-hls-public.test.js
- test/preroll-stability.test.js
- this audit and validation artifacts under var/

EXISTING_UNSTAGED_WORK_STATUS: Baseline hashes were captured before edits. Only intended existing files changed; no baseline files removed. Media excluded from hashing and never edited. Existing unrelated unstaged work retained.

PROTECTED_FILES_STATUS: Environment, services, MediaMTX, authorization/armed persistence, SourcePresenceMonitor routing/browser binding, Control Desk, Scheduler, normal Public/OBS controller and wire contract untouched. The pre-roll deadline accounting was intentionally corrected as described above; first-frame readiness and the continuous 3-second requirement remain enforced.

GIT_STATUS: build/1003.3, authorized dirty worktree retained, index unchanged and empty.

BLOCKERS: No implementation/test blocker. Real browser/OBS access is unavailable, so exact measurement of the reported 30 seconds and confirmation of the slate in the user's session remain manual validation requirements.

MANUAL_RETEST: Reload Control/Public/OBS to load these modules. Select the same authorized external source in Technical Monitor. Capture the local runtime trace from Technical ONLINE through TAKE; check technical-health-reused, a single candidate and a single completed stability window. Interrupt for approximately three seconds: expect slate then LIVE, unchanged session and no A. Repeat persistently: slate then A once at its cue. TAKE B while the slate is visible and allow LIVE to recover: B must remain on air. Repeat with Public and OBS newly opened during loss. Capture binding-start, show-request, control-rendered, published lossSlateActive, network response and subscriber revision if any surface still fails to show the slate.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST AUTOLIVE ACQUISITION LATENCY + LOSS SLATE

LIVEZONE AUTOLIVE LATENCY AND LOSS SLATE AUDIT COMPLETE
