# AutoLive post-TAKE loss slate audit

DECISION: AUTOLIVE_POST_TAKE_GRACE_READY_FOR_MANUAL_RETEST

BASELINE: 595 reported passing tests; existing dirty branch build/1003.3 preserved.

MANUALLY_ACCEPTED_BEHAVIOR: A remains on air throughout pre-roll; stable LIVE commits once; Public and OBS promote without refresh; pre-TAKE failure retains A. These acquisition/readiness paths are unchanged. The latest inline request explicitly requires shared subscriber slate presentation, superseding the attachment's prohibition on subscriber changes.

POST_TAKE_FAILURE_TRACE: Reproduced deterministically using the production external HLS health chain and Program command. At relative T0 an active consumer emits error/uncertainty; T1 starts its replacement; T5 the original uncertainty callback incorrectly publishes OFFLINE using the replacement generation. Before the fix, the new regression fails with actual Program A instead of LIVE. After the fix, replacement progress recovers the original session without TAKE.

FIRST_PREMATURE_RESTORE: LiveSourceMonitor.acceptUncertainty's expired callback called accept(this.generation, this.source, OFFLINE), transferring the retired consumer's verdict to a replacement. DominantLiveController's expired grace then calls endSession(source-loss), finishSession, restoreReturnTarget, and the Program command for A.

TEN_SECOND_WINDOW_EXPLANATION: The observed approximate ten seconds has no measured real-browser trace in this run. A premature return forces fresh health stabilization (3 seconds), Program playback pre-roll (3 seconds), and variable retry/decoder readiness. This explains a possible visible interval, not an established exact ten-second timeline. Manual trace capture remains necessary.

LOSS_GRACE_CURRENT_SEMANTICS: Five seconds, unchanged. An unresolved replacement inside its existing 12-second readiness budget cannot be declared absent by a retired consumer. With replacement at T1 and no frames, readiness timeout confirms loss at T13; no unbounded wait. Fresh repeated errors still confirm loss at the original deadline. Ordinary sustained waiting returns after five seconds.

ROOT_CAUSE: Generation-unsafe uncertainty verdict. Additionally, a queued cancelled controller grace timer lacked a per-loss token and could interfere with a later grace in the same ownership session.

FIX: Preserve the current bounded readiness attempt and guard grace callbacks by token. Add a session-scoped, opaque AutoLive loss presentation with the fixed safe text LIVE SIGNAL TEMPORARILY UNAVAILABLE. Use a reserved existing image graphic ID, autolive-loss-slate, for shared subscriber presentation. No BREAK command, new scene, new ownership, Preview mutation, or return-target capture. Source, activation committedAt, and playback remain LIVE; only graphics revisions change. A shared DOM renderer supplies Control, Public and OBS. Preserve the slate through asynchronous return preparation until Program actually commits. Fresh subscribers show it even while HLS readiness is pending.

TRANSIENT_LOSS_PROGRAM_HISTORY: Identity A → LIVE. Visual A → LIVE → LOSS SLATE → LIVE. Same session and cue; no A flash; one acquisition.

PERSISTENT_LOSS_PROGRAM_HISTORY: Visual A → LIVE → LOSS SLATE → A, with one restore at the saved cue (37 seconds in tests).

RECOVERY_WITHIN_GRACE: Healthy progress clears the presentation synchronously without command or reacquisition. Recovery of a bounded replacement also retains ownership while a fresh loss verdict is pending.

SESSION_OWNERSHIP: Session ID, return target, underlying LIVE source and activation remain unchanged by the slate. Graphics revisions are not Program TAKEs.

OPERATOR_OVERRIDE_REGRESSION: Operator TAKE B during the slate clears AutoLive ownership and presentation. Queued old timers and stale ONLINE cannot re-promote LIVE. Subscriber revision rejection also rejects stale LIVE recovery after operator media promotion.

CUE_RESTORE_REGRESSION: Saved media cue 37 seconds preserved through slate and used once on confirmed loss.

PREVIEW_REGRESSION: Nonempty Preview B remains unchanged through transient and persistent loss; return target preserved by identity.

PUBLIC_REGRESSION / OBS_REGRESSION: Both render the same shared opaque slate and fixed text, retain their existing LIVE player during graphic-only updates, remove it on recovery, reject stale revisions, and display it for fresh subscribers with pending HLS readiness. Automated DOM/media simulations; physical OBS/browser rendering still requires manual retest.

TESTS_ADDED: Ten new tests cover retired-consumer deadline regression; transient slate/no A flash/same session/Preview/cue; persistent slate and cue restore; operator B override/stale recovery; Public and OBS shared rendering/player preservation/stale revisions; fresh Public and OBS pending readiness; bounded persistent replacement timeout; cancelled grace isolation. Two existing monitor tests now require the current replacement readiness timeout before asserting confirmed absence.

REGRESSION_RESULTS: Focused suite 157/157 before the two additional boundary tests; external HLS suite 17/17 after them. Final full suite: 605/605 PASS (zero failures), recorded in var/loss-slate-regression.log. JavaScript syntax checks and git diff --check pass.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/studio/LiveSourceMonitor.js
- public/js/studio/DominantLiveController.js
- public/js/studio/AutoLiveLossPresentation.js (new)
- public/js/program-output/AutoLiveLossSlate.js (new)
- public/js/program-output/ProgramOutputManager.js
- public/js/public/PublicProgramController.js
- public/js/entries/control-room-app.js
- test/dominant-live.test.js
- test/external-hls-stability.test.js
- test/external-hls-public.test.js
- this audit; local validation artifacts under var/

EXISTING_UNSTAGED_WORK_STATUS: Baseline SHA-256 comparison found only the eight expected existing code/test files changed, no missing baseline files. Media was excluded from hashing and never touched.

PROTECTED_FILES_STATUS: Environment, services, MediaMTX, auth, wire contract/schema, pre-roll renderer/stability gate, network transport, scheduler and media untouched by this task. No reset, restore, clean or stash.

GIT_STATUS: Existing dirty worktree retained on build/1003.3. Index unchanged and empty; no commit/push.

BLOCKERS: None for manual retest readiness. Actual browser/OBS/physical stream-loss verification not performed in this run.

MANUAL_RETEST: Keep Control, Public and OBS open. Play A at a known cue and keep Preview B. Let stable LIVE take once. Interrupt briefly: all three should show only the safe slate, then LIVE without another acquisition or A frame. Interrupt persistently: slate then one return to A at the recorded cue. During another slate, TAKE B: B owns Program, including after delayed LIVE recovery. Repeat with fresh Public/OBS subscribers during loss and capture source/Program traces for the reported approximate ten-second window.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no (existing version-1 image graphic representation; reserved presentation ID added)
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST POST-TAKE LOSS GRACE

LIVEZONE AUTOLIVE POST TAKE LOSS GRACE AUDIT COMPLETE
