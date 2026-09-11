# AutoLive 30-second entry and subscriber recovery audit

DECISION: AUTOLIVE_30S_ENTRY_SUBSCRIBER_RECOVERY_READY_FOR_MANUAL_RETEST

ENTRY_GATE_BEFORE: 60000 ms.
ENTRY_GATE_AFTER: 30000 ms, canonical AUTO_LIVE_ENTRY_STABILITY_MS in AutoLiveEntryPolicy.js.
ENTRY_COUNTER_MODEL: Existing accumulated healthy playback time; transient uncertainty pauses/resumes, confirmed/fatal entry evidence resets under the existing rules. Boundary tests cover 29999 ms and 30000 ms. Control renders STABLE 12 / 30 s; broadcast preparation text stays unchanged. No production 60-second AutoLive entry policy remains.

REAL_SUBSCRIBER_FAILURE: Operator reports Control recovers after a 3–5 second interruption while Public/OBS remain on the last frame. Real browser/OBS reproduction was not available in this environment.
LOSS_REVISION_TRACE: ProgramOutputManager.setAutoLiveLossSlate publishes graphics. publish increments revision while preserving publisherSessionId, committedAt, scene/source and playback. Tests send LIVE revision 1 and LOSS revision 2 through NetworkProgramOutputTransport and the existing envelope.
RECOVERY_REVISION_TRACE: Graphics clear is revision 3 with the same activation and playback timeline; subscriber accepts it. No protocol change is necessary.
PUBLIC_FIRST_DIVERGENCE: PublicProgramController.handleSnapshot sameActivation branch previously removed LOSS graphics and only reconciled changed playback. An unchanged playback object never restarted a frozen HLS consumer.
OBS_FIRST_DIVERGENCE: The same shared branch, with OBS audio policy retained.
SUBSCRIBER_HLS_RECOVERY_MODEL: One local verifier per accepted LOSS-to-LIVE edge. Advancing currentTime with readyState >= 2 and unpaused/non-ended playback retires the verifier and reuses the consumer. After five seconds without that evidence, one renderSnapshot rebuild uses the latest authoritative snapshot. Duplicate clear revisions do not start another verifier. Existing pending preparation coalesces updates. Existing HLS readiness/fatal retry behavior remains the owner after rebuild; this patch adds no independent retry loop. New LOSS, changed activation/source, destroy and stale callbacks retire or invalidate verification.
ROOT_CAUSE: Graphics-only recovery had no transport progress reconciliation for the retained subscriber HLS surface.
FIX: Add bounded same-session HLS progress verification and reconstruction through the existing generation-guarded renderer; change the canonical new-entry gate to 30 seconds.
PUBLIC_RECOVERY: Automated SSE/envelope tests cover a three-second loss, healthy reuse and stalled reconstruction without refresh. Muted Public policy preserved.
OBS_RECOVERY: Automated SSE/envelope tests cover a five-second loss, healthy reuse and stalled reconstruction without refresh. Audible OBS policy preserved.
PERSISTENT_LOSS_REGRESSION: Existing confirmed-loss, Scheduler restore guard and HLS recovery suites pass; 2-second visual debounce and 15-second confirmed loss are unchanged.
GENUINE_REACQUISITION_REGRESSION: Existing fresh-session boundary tests now require 30 seconds; same-session subscriber recovery does not acquire an AutoLive session.
TESTS_ADDED: Ten subscriber cases: healthy/stalled for Public and OBS, plus operator override/destroy/new loss cancellation for each. Existing entry boundary, UI, reset, retry, cue, Preview and reacquisition tests migrated to the new policy.
REGRESSION_RESULTS: Full node --test: 803/803 passing. Changed JavaScript syntax checks pass. git diff --check passes. Logs: var/entry30-all.log and var/entry30-subscriber.log.
FILES_CHANGED_FOR_THIS_FIX: public/js/studio/AutoLiveEntryPolicy.js; public/js/public/PublicProgramController.js; test/autolive-entry-gate.test.js; test/autolive-post-take-session.test.js; test/autolive-health-debounce.test.js; test/autolive-confirmed-loss.test.js; test/external-hls-public.test.js; this audit. Local evidence in var/entry30-*.
EXISTING_UNSTAGED_WORK_STATUS: Preserved; baseline SHA comparison identifies only the seven JavaScript files above changed by this task.
PROTECTED_FILES_STATUS: No changes to Control HLS recovery, ownership, Scheduler guard, normal media handoff, authorization, routing, server, MediaMTX or environment configuration.
GIT_STATUS: Existing dirty worktree retained; see var/entry30-status.txt. No reset, restore, clean, stash, stage, commit or push.
BLOCKERS: No code/test blocker. Real browser and OBS confirmation remains a manual retest; synthetic media tests cannot establish actual decoder/network recovery in those runtimes. A stalled subscriber may retain the last picture during the bounded five-second verification after the authoritative slate clears.
MANUAL_RETEST: In open Control/Public/OBS, verify A → ENTRY → LIVE at 30 accumulated healthy seconds, including a brief pause at 12/30. Interrupt LIVE for 3 and 5 seconds. Confirm same-session LOSS → LIVE in all outputs without refresh or another ENTRY; inspect loss-recovery-check/reused/rebuild events. Then interrupt beyond 15 seconds, verify one return to the captured A cue, and a fresh 30-second gate on genuine reacquisition. Repeat with operator TAKE during recovery and both native HLS/HLS.js browsers. Verify audio policies, Preview and normal heavy-media TAKE remain correct.
NEXT_STEP: MANUAL RETEST 30S ENTRY + PUBLIC/OBS SHORT LOSS RECOVERY

LIVEZONE AUTOLIVE 30 SECOND ENTRY AND SUBSCRIBER RECOVERY AUDIT COMPLETE
