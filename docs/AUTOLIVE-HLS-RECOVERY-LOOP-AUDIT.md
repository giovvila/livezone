# AutoLive Program HLS recovery lifecycle

DECISION: AUTOLIVE_HLS_RECOVERY_LOOP_READY_FOR_MANUAL_RETEST

REAL_TRACE_FINDING: The supplied real trace findings confirm the Scheduler guard and 15s boundary are respected, and the same AutoLive session can recover directly to LIVE. The new failure is repeated Program HLS destruction/recreation, including media/playback errors immediately after replacement. This task treats those findings as authoritative and does not reopen the earlier Scheduler diagnosis.

PROGRAM_SURFACE_REBUILD_OWNER: Before this change, AutoLiveLossPresentation owned a one-second fatal-recovery timer. For the active external-HLS AutoLive session, recovery now belongs solely to AutoLiveActiveHealth, alongside its existing Program health authority. Presentation retains visual and observation duties, but its fatal callback returns without scheduling a rebuild when the active owner exists. Legacy/non-active-owner behavior remains separate.

REBUILD_CALL_PATH: Previous path: Program video error/ended or StudioHlsSurface health error → AutoLiveLossPresentation.observeProgram fatal callback → 1000ms recoveryTimer → StudioRenderer.renderSlot(program, session.sceneId) → release old renderer/StudioSourceManager.destroyInstance → createRenderer/createInstance → StudioHlsSurface.start → observe replacement → another error → another 1000ms timer. Current path: active owner's existing one-second tick → recoverProgram → bounded attempt deadline → optional renderSlot replacement only after attempt expiration. Neither path requires a normal TAKE command; the new path cannot close the session.

COMPETING_RECOVERY_OWNERS: StudioRenderer executes replacement and SourceManager manages instances; neither autonomously schedules retries. Transition coordinator and Program Output do not trigger this recovery. Technical/source observations update corroborating evidence only; they do not call recoverProgram. HLS.js may perform its internal network recovery while retained, but only the active owner replaces the Program DOM surface. The presentation timer is disabled for that owner, avoiding a competing one-second loop.

PROGRAM_INSTANCE_SEQUENCE: The user reports studio-source-10 through 13, then 14 through 27 and beyond. The deterministic baseline reproducer created **nine replacement VIDEO elements in ten seconds**. With the fix and repeated immediate native errors, the aligned test sequence is: original instance at loss 0s; native reload on that instance at ~2s; first replacement at ~7s; second replacement at ~12s; confirmed return at 15s without another LIVE replacement. Creation records pair old/new IDs through the same recovery generation.

MEDIA_ERROR_BEHAVIOR: Native media error/networkState=3 first retries the existing resource with load(), then activates playback on the same element. It retains the source URL and does not reassign src or allocate a decoder immediately. The normal pause-triggered activation is temporarily disabled around load to avoid redundant activation from that synchronous event. If usable progress does not return during the bounded attempt, a replacement is permitted. A pending play promise does not count as success and does not cause more reloads. HLS.js surfaces first retain their current instance for the attempt window instead of invoking an unproven native reload operation.

The test proves the proposed sequence and bounded calls, not that every browser-native HLS failure can recover with load/play. A new element remains the fallback after the readiness opportunity expires. No new native-browser recovery observation was obtained in this session.

RETRY_POLICY_BEFORE: Every fatal event on each current surface could arm another one-second destruction. Surface identity guards rejected obsolete callbacks but did not prevent successive valid new surfaces from generating a retry storm.

RETRY_POLICY_AFTER: `AUTOLIVE_PROGRAM_RECOVERY_ATTEMPT_MS` aliases the existing five-second source retry cadence. The current attempt deadline is installed before invoking any synchronous player operation. Repeated health/error events cannot start another attempt before it expires. There is no additional timer: the existing active-health sampling tick checks this deadline. Native first attempt reloads in place; HLS.js first attempt retains the surface. Subsequent expired attempts may replace once per five seconds. Ordinary waiting/stalled without a failed attempt does not by itself create a new player.

STALE_CALLBACK_GUARD: Existing session/controller/surface-binding guards remain. Replacement startup settlement is observational only and is checked against current recovery generation. Old video/health callbacks cannot schedule presentation recovery for the active owner or destroy the replacement. Owner retirement on operator override/close makes later retry checks inert.

SESSION_IDENTITY: Recovery never changes the session, return target, Program scene or interruption context. Tests retain the same session across 1/5/10/14-second disturbances; Preview remains P and captured cue remains 37s. No recovery operation calls ENTRY preparation or TAKE.

LOSS_GRACE_STATUS: The existing 15s confirmed-loss threshold, source corroboration and close guard are unchanged. Attempt deadlines do not extend or reset the session-loss deadline. At confirmed grace expiry, health checks close ownership before any subsequent retry tick can create a surface. With positive source availability, the existing policy can retain a stalled session longer; retries remain controlled rather than one per second.

SAME_SESSION_RECOVERY: Only current, readyState≥2, unpaused/non-ended advancing Program playback completes an attempt and clears LOSS. Metadata, play settlement and Technical ONLINE alone do not. Successful progress also clears the recovered surface's local error status so removing LOSS cannot expose an obsolete error message. This completion path applies only to already-owned Program recovery, not ENTRY readiness.

PERSISTENT_LOSS_RESTORE: Repeated immediate replacement failures keep the existing LOSS overlay outside the replaced media content root. The tested history stays A → ENTRY → LIVE → LOSS until 15s, then restores A once at cue 37s. The user-reported real return cue near 882.686s uses unchanged capture/restore code.

ROOT_CAUSE: A valid error from each freshly created Program player restarted the presentation's one-second rebuild timer. There was no attempt-level opportunity for that player to recover before another destruction. This matches the reported Program instance churn and explains why individual stale-callback guards were insufficient.

FIX: Removed presentation-owned recovery for active external AutoLive sessions; added bounded attempts to the existing health owner; native in-place retry before replacement; HLS.js retention before replacement; progress-only completion; recovery generation tracing with old/new instance IDs, reason, session, loss generation, grace deadline/remaining time, source/player health and owner. Traces contain no URLs or credentials.

TESTS_ADDED: Twelve tests in `test/autolive-hls-recovery.test.js`: baseline error storm; 1/5/10/14-second native-error recovery; ordinary waiting retention; one native reload despite pending play/error storm; stale surface callbacks; persistent failure and exact grace return; operator override; HLS.js retention window; Technical-state changes leaving attempt identity/deadline unchanged.

PROGRAM_INSTANCE_COUNT_TESTS:

| Disturbance | Native reloads before recovery | New LIVE surfaces before recovery | Result |
|---:|---:|---:|---|
| 1s | 0 | 0 | Original LIVE continues |
| 5s | 1 | 0 | LOSS → same-instance LIVE |
| 10s | 1 on original | ≤1 | LOSS → LIVE, same session |
| 14s | 1 on original | ≤2 | LOSS → LIVE, same session |
| 15s persistent error | 1 on original | 2 | LOSS → A once |

Counts exclude the media A surface created by the legitimate final return. Destruction's existing unload/load operation is counted separately from a recovery reload. The persistent test verifies no A/black intermediate Program snapshot before return; native rendered frames still require manual validation.

REGRESSION_RESULTS: Full `node --test`: 793/793 PASS, baseline 781. Focused AutoLive/recovery/loss/HLS/restore guard/handoff/Program Output/Public/OBS: 260/260 PASS. JavaScript syntax and `git diff --check` pass with existing CRLF normalization warnings. Evidence: `var/hls-recovery-before.log`, `var/hls-recovery-focused.log`, `var/hls-recovery-all.log`, `var/hls-recovery-attempt-trace.json`, `var/hls-recovery-attempt-timeline.json`.

FILES_CHANGED_FOR_THIS_FIX: `public/js/studio/AutoLiveActiveHealth.js`, `AutoLiveLossPresentation.js`, `AutoLivePostTakePolicy.js` (recovery cadence export only), `public/js/studio/renderers/StudioHlsSurface.js`; new `test/autolive-hls-recovery.test.js`; this audit and local `var/hls-recovery-*` evidence. Existing-file hash comparison: `var/hls-recovery-changed-files.json`.

PROTECTED_WORK: Branch build/1003.3 and authorized dirty baseline preserved. Scheduler/restore guard, 60s gate/counter, 2s debounce, 15s threshold, authorization/routing, normal handoff/heavy-media TAKE, cue restore, Preview, Public/OBS protocol and implementation are unchanged. No auth, MediaMTX, .env, service or P0-C1B.2 changes. No reset/restore/clean/stash/stage/commit/push. Status: `var/hls-recovery-status.txt`.

BLOCKERS: No implementation/test blocker. Native HLS recovery effectiveness and real rendered output require manual retest; the test media elements model error/play/readiness behavior, not a native decoder.

MANUAL_RETEST: Repeat real source interruptions of 1/5/10/14 seconds. Inspect autolive-recovery records: native-reload or retain-hls-attempt, at least five seconds between replacement attempts, and progress-recovered on the same session. Verify LOSS stays visible during attempts, no A or ENTRY appears on recovery, and Control/Public/OBS agree. Keep one true loss beyond 15s to verify a single captured-cue return. Compare native media/playback errors and instance counts with the supplied trace.

NEXT_STEP = MANUAL RETEST SHORT LOSS WITH BOUNDED HLS PROGRAM RECOVERY

LIVEZONE AUTOLIVE HLS RECOVERY LOOP AUDIT COMPLETE
