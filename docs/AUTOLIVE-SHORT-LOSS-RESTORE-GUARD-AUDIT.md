# AutoLive short-loss restore boundary audit

DECISION: AUTOLIVE_SHORT_LOSS_RESTORE_GUARD_BLOCKED

This decision concerns identification of the complete reported browser sequence, not a failed implementation test. A concrete production bypass was reproduced and fixed, and the Program mutation invariant is now enforced. However the reproduced old path ends at A; it does not explain the reported immediate final LIVE. Without the requested browser trace, claiming an exact incident diagnosis or READY would exceed the evidence.

REAL_RUNTIME_RESULT: Operator reports LIVE → LOSS → A → LIVE for a 1–2-second loss and confirms A appears in Control Room Program, not only Public/OBS. Browser-tool enumeration returned no connected browser. The requested local trace has not yet been provided.

ALL_RESTORE_PATHS:

| Production path | Can make A authoritative? | Ownership/guard result |
|---|---|---|
| DominantLiveController.handleHealth → loss grace callback → AutoLiveEntryController.endSession(source-loss) → finishSession → restoreReturnTarget → StudioProgramCommand.execute(preservePreview) | Yes, intended persistent return | Existing 15s/current-evidence checks retained; actual close must precede restore |
| AutoLiveEntryController.endSession with alternate automatic reason, including stale activation-failed | Previously could close around source-loss guard | Active external Program now applies the same close check to automatic reasons; successful automatic close normalizes to source-loss |
| Entry abandonment timer | A may resume while ENTRY is unavailable | Existing PREPARING/session/generation checks; unchanged threshold |
| Disarm, authorized source change, operator override, runtime stop | Explicit lifecycle retirement | Preserved; operator TAKE remains authorized |
| Direct/stale finishSession callback | Could clear Scheduler context before restore guard rejects actual return | Blocked while any current AutoLive session exists |
| restoreReturnTarget while session active | Would invoke captured-target command if unguarded | Existing active-session rejection retained and tested |
| Failed return → Scheduler.reconcile(releaseWhenEmpty) | Can choose scheduled A or release Program | Valid only after closure; active Program write guard also covers it |
| Scheduler.setSchedule → lost external context → later reconcile(true) → StudioProgramCommand.execute(A) → transition → StateManager.take | **Yes: reproduced before 15s** | Fix preserves external/empty-slot context; command preflight and state mutation guard reject automatic displacement while LIVE-owned |
| Scheduler.endInterruption(default reconcile), stop/context loss, scheduled interruption expiry, queued schedule reconciliation | Can submit a schedule command after context retirement | State guard rejects conflicting writes while active AutoLive ownership persists |
| StudioProgramCommand.release → StateManager.releaseProgram | Releases LIVE; could permit later schedule activation | Release guarded at state mutation boundary |
| StateManager.setProgramScene / take | Direct authoritative write | Guard runs before persistence/event dispatch; rejected TAKE does not swap Preview |
| StateManager.handleStorage → applyExternalSelection(program), restoreRegisteredSelection | Can project persisted A from another context | Program identity guard covers both; generic storage synchronization is not treated as a proven explicit operator TAKE |
| AutoLiveLossPresentation show/hide → ProgramOutputManager graphics | No | Visual overlay only; no return-target read or command |
| AutoLiveLossPresentation fatal recovery → renderer.renderSlot(program, session.sceneId) | No A target | Rebuilds LIVE only; session identity retained |
| Renderer activation/CUT/DISSOLVE/cleanup | Can render the scene selected by authoritative state | No stored-return-target projection found; renderer/normal handoff code untouched |
| ProgramOutputManager → PublicProgramController | Follows published identity; subscriber can retain outgoing visual while preparing incoming | No captured AutoLive return target available to these components; subscriber code unchanged |

SHORT_LOSS_TIMELINE: The baseline reproducer uses real SchedulerEngine, StudioProgramCommand, transition coordinator, StateManager, renderer and output manager. A normal schedule item A spans the test. ENTRY commits LIVE at simulated 60s. At 61s loss begins; at 63s LOSS is visible and the deadline is 76s (13 seconds remaining). Refreshing the schedule discarded the external interruption context; reconcile(true) submitted A. The old guardless state committed A, after which AutoLive classified the Scheduler Program event as manual override and closed. Separate fixed-path tests retain LIVE and recover directly when source/playback return.

SESSION_CLOSED_DURING_SHORT_LOSS: **Yes in the reproduced baseline Scheduler bypass**, but only after the first authoritative write of A. The browser incident itself remains unclassified without its trace. With the fix, tested short losses retain the same session.

FINAL_LIVE_SAME_SESSION: **Not established for the reported incident.** The baseline bypass stays at A after an ONLINE observation because its manual-override latch blocks reacquisition; it does not produce immediate final LIVE. In fixed short-loss tests final LIVE is explicitly the same session/owner/context, with no new ENTRY. This distinction is why the decision remains BLOCKED rather than presenting a partially matching reproduction as the exact incident.

FIRST_PREMATURE_A_PATH: Proven test path is `StudioScheduleSummaryUI.handleSchedule → SchedulerEngine.setSchedule → external context discarded → SchedulerEngine.reconcile(true) → StudioProgramCommand.execute(origin=scheduler, scene=A) → StudioTransitionCoordinator.transition → StudioStateManager.take`. The schedule refresh itself calls reconcile(false); a subsequent activation reconciliation causes the write. The test explicitly exercises that subsequent production call. There is no evidence yet that a schedule refresh/reconciliation occurred during the user's incident.

CONFIRMED_LOSS_TIMER_STATUS_AT_A: In the old reproduced path, A commits at 63s with deadline 76s and 13000ms remaining. The timer did not authorize A. The authoritative write arrived first through Scheduler; session teardown followed as a consequence. Evidence: `var/restore-guard-before.log` and `var/restore-guard-legacy-path.json`. The latter explicitly reinstates the former context loss and removes only the new guard to document old-path behavior without reverting repository files.

PROGRAM_OWNERSHIP_MODEL: While an AutoLive session is LIVE-owned, automatic commands cannot replace/release its Program identity. The controller installs a state-level guard; same LIVE identity and explicit operator commands are allowed. The guard applies before persistence/events on setProgramScene, TAKE, release and external selection. StudioProgramCommand additionally checks before changing Preview or preparing media. Persistent return occurs only after the controller retires ownership, so its normal cue-restoring command remains authorized. The guard is removed on controller teardown.

LOSS_SLATE_MODEL: Program remains LIVE, visual may be LOSS, A remains stored only as return target. Slate display/cleanup still issues zero TAKE/release/return commands. No 2s visual or 15s confirmed-loss policy changes.

ROOT_CAUSE: A verified bypass existed because schedule refresh preserved only empty-slot interruption context, losing externally owned interruption of a scheduled item. It could bypass AutoLive's return timer entirely. The exact full reported short-loss sequence still needs runtime attribution; the immediate return from A to LIVE is not explained by this reproduced path.

FIX: Preserve external Scheduler context across schedule updates. Enforce active AutoLive ownership at Program command preflight and the final state mutation boundary. Reject active-session cleanup and alternate automatic closes before confirmed loss. Add bounded trace of allowed/blocked Program writes with command origin/path, session, phase, Program/source IDs, deadline and remaining milliseconds; Program-changed traces now include origin. Normal rendering, subscribers, cue code and timers remain unchanged.

1S_HISTORY: A → ENTRY → LIVE; deliberate automatic A/release/storage attempts are blocked. The accepted 2s debounce means one-second loss need not show LOSS.

2S_HISTORY: A → ENTRY → LIVE → LOSS → LIVE, same session.

5S_HISTORY: A → ENTRY → LIVE → LOSS → LIVE, same session.

14S_HISTORY: A → ENTRY → LIVE → LOSS → LIVE, same session; 14.999s also tested.

15S_HISTORY: A → ENTRY → LIVE → LOSS → A exactly once, captured cue 37s restored.

RESTORE_COMMAND_COUNTS: Short fixed-path tests: zero successful captured-A commands and zero restoreReturnTarget executions that commit; direct attempts return false. Persistent case: one actual StudioProgramCommand.execute(A) succeeds at 15s. Old Scheduler bypass: one Scheduler A command, **zero restoreReturnTarget calls**—showing why only counting the named return method misses this defect.

SESSION_CLOSE_COUNTS: Short fixed-path tests: zero successful closes/interruption ends. Persistent case: one. Old context-discard reproducer: one close as manual override after A has already committed.

ENTRY_RESTART_COUNTS: Short fixed-path tests: one original begin, zero additional entry sessions/60s gates. Existing genuine post-closure reacquisition tests remain passing. Old reproducer does not re-enter automatically within the short recovery window.

TESTS_ADDED: Ten real-Scheduler tests in `test/autolive-restore-guard.test.js`: schedule refresh preservation; five timing boundaries (1/2/5/14/14.999s) with actual command/state/release/storage/cleanup attempts; exact persistent command/close counts; direct TAKE guard and operator override; independent lost-context guard trace; old-path fault-injection trace. Previous deterministic suites remain unchanged.

REGRESSION_RESULTS: Full `node --test`: 781/781 PASS (baseline 771). Focused restore/confirmed-loss/debounce/entry/Scheduler/state persistence/handoff/output/OBS suites pass. Syntax checks pass; `git diff --check` passes with existing CRLF warnings. Logs: `var/restore-guard-new.log`, `var/restore-guard-focused.log`, `var/restore-guard-all.log`.

FILES_CHANGED_FOR_THIS_FIX: `public/js/scheduler/SchedulerEngine.js`, `StudioProgramCommand.js`, `public/js/core/StudioStateManager.js`, `RuntimeTrace.js`, `public/js/studio/AutoLiveEntryController.js`; new `test/autolive-restore-guard.test.js`; this audit and `var/restore-guard-*` evidence. Existing-file hash comparison is in `var/restore-guard-changed-files.json`.

PROTECTED_WORK: Authorized dirty baseline on build/1003.3 preserved. No ENTRY gate/counter, 2s debounce, 15s threshold, renderer/handoff architecture, source routing/authorization, cue restore, media, Public/OBS implementation, auth, environment or service edits. Generic external storage writes cannot displace an active AutoLive Program; explicit operator TAKE still can. No reset/restore/clean/stash/stage/commit/push. Status: `var/restore-guard-status.txt`.

BLOCKERS: No connected browser and no real incident trace. Required answers about the incident's session close, exact first A writer and final LIVE identity cannot honestly be supplied yet. The operator confirmed Control Room involvement; the requested `livezoneRuntimeTrace.exportJSON()` after an episode remains the missing evidence. Exported local trace is bounded and filters URLs/credentials.

MANUAL_RETEST: Test a 1–2s real interruption with this guard; verify no A in Control/Public/OBS and no new session. If A appears, export the trace immediately. Correlate program-write-allowed/blocked, program-changed, session-close, loss decision and output revision events; identify whether any renderer-only A appears without an authoritative identity event. Verify 15s persistent return and operator takeover separately.

NEXT_STEP = MANUAL RETEST 1–2s LOSS WITHOUT MEDIA A RETURN

LIVEZONE AUTOLIVE SHORT LOSS RESTORE GUARD AUDIT COMPLETE
