# AutoLive post-TAKE session audit

DECISION: AUTOLIVE_POST_TAKE_SESSION_READY_FOR_MANUAL_RETEST

REAL_RUNTIME_LOOP: The operator reports A → ENTRY → LIVE → A → ENTRY repeating while the publisher continues transmitting. Normal heavy VIDEO→VIDEO and VIDEO→AUDIO+motion TAKE are manually accepted. This session reproduced a concrete false-close path deterministically; it did not capture the operator's native browser failure or establish that every reported loop has the same trigger.

ENTRY_GATE_STATUS: The accepted 60-second healthy-time gate, accumulation, uncertainty pause/resume, ENTRY presentation, return cue capture and Preview preservation are unchanged. No reacquisition suppression was introduced.

POST_TAKE_HEALTH_OWNER: For external HLS, the already-promoted Program surface now supplies session health through a controller-owned AutoLiveActiveHealth observer. This adds listeners and a one-second watchdog check, not another player, decoder or HLS connection. Technical/hidden source monitor observations remain available for discovery and later acquisition; during this active session they cannot close it. Managed ingest retains server-side source authority. Slate/Technical Monitor UI lifecycle does not own the new observer.

FALSE_CLOSE_TIMELINE: The fault-injection test explicitly restores the former monitor-authority route after a successful gate. The separate initial reproducer failed against the unmodified baseline. Safe trace artifacts: `var/post-take-session-before.log`, `var/post-take-false-loop-trace.json`, and `var/post-take-false-loop-timeline.json`.

| Point | Simulated time | Observation |
|---|---:|---|
| T0 | 0s | A interrupted, ENTRY begins |
| T1 | 60s | Candidate reaches 60/60 |
| T2 | 60s | Commit begins |
| T3 | 60s | Program commits LIVE |
| T4 | 60s | Same session phase LIVE, entry work retired |
| T5 | 61s | Separate external monitor reports OFFLINE; Program still advances |
| T6 | 61s | Source-loss grace starts |
| T7 | 66s | Old route calls endSession(source-loss) solely from monitor OFFLINE |
| T8 | 66s | Restore A at captured cue 37s |
| T9 | 66s | Session closed; return completes |
| T10 | 67s | Source monitor reports ONLINE |
| T11 | 67s | New ENTRY begins; next LIVE at 127s |

The old logical owner is cleared immediately before the asynchronous restore command; T8/T9 are not a claim that ownership remains active until restore completes. Trace events carry actual ordering. At the first false close the trace reports phase LIVE, Program scene LIVE, source live, player ready, playing=true, playbackProgressing=true, lastHealthyAt=65000, close time=66000, reason=source-loss. Session/generation, revision, grace generation/deadline and consumer identity are included when available. The synthetic monitor does not model a native HLS consumer generation; real SourcePresenceMonitor now propagates that generation for runtime tracing. Raw URLs and credentials are not recorded.

FIRST_FALSE_CLOSE_CONDITION: In DominantLiveController.handleHealth, the grace callback closes when current health is OFFLINE (or legacy non-source ERROR). SourcePresenceMonitor.startExternal maps an external monitor ERROR to OFFLINE. There was no post-entry authority check against the healthy promoted Program consumer. The real SourcePresenceMonitor error-mapping integration test exercises this conversion; the healthy Program must now survive it.

CANDIDATE_ACTIVE_HANDOFF: Before synchronous LIVE commit notifications, the session phase changes to LIVE, existing entry work is retired, and the active authority token is installed. After successful commit, its observer attaches to the same promoted surface. PREPARING abort/timers remain invalidated by the existing generation and phase checks. No renderer or Preview→Program ownership architecture changes were needed.

STALE_EVENT_FINDING: The reproduced false close does not require a stale ENTRY callback: a current, valid event from the wrong consumer is sufficient. The fix also guards active mutations by observer identity, controller generation and session identity; per-surface listeners additionally check binding generation, current renderer and Program scene. Old surface callbacks and disposed owners cannot mutate the active session. Source observation sequencing remains separate from active playback sequencing so later legitimate acquisition is not blocked by synthetic active-health revisions.

LOSS_GRACE_FINDING: Brief active-player waiting/stalled/error/ended signals enter CHECKING and the existing loss grace/slate policy. Advancing decoded Program playback restores ONLINE and cancels that grace. No progress for the existing five-second stall interval confirms playback loss; existing grace logic performs the single close/return. Replacement surfaces do not reset the last proven progress timestamp, and their old callbacks are invalidated. A failed Technical/hidden monitor alone does not start active-session grace. Persistent playback loss can close even when a publisher is connected but its Program cannot play; this is distinct from the false-close case with advancing Program playback.

ROOT_CAUSE: External monitor playback failure was treated as authoritative source absence after a different surface had proven stability and become Program. The first closure was driven by this conflicting authority, not by the new normal TAKE handoff. There is no evidence from this reproduction of scheduler reconciliation, slate cleanup or entry timeout being its first cause. Existing tests continue covering those stale paths; their absence in this reproduction is not a claim about unseen browser logs.

FIX: Added a session-owned observer of promoted external-HLS Program playback; separated source-monitor observations from active-session health; retained source sequence on close; added safe consumer/grace/Program identifiers to traces. The original 60-second gate and reacquisition policy remain intact.

HEALTHY_60MIN_HISTORY: Exactly A → ENTRY → LIVE for simulated 10, 30 and 60 minutes with alternating external monitor OFFLINE/CHECKING. Same session object and active owner, one interruption begin, zero closes, zero returns, no second TAKE/ENTRY. Evidence: `var/post-take-healthy-10min.json`, `var/post-take-healthy-30min.json`, `var/post-take-healthy-60min.json`.

TRANSIENT_LOSS_HISTORY: A → ENTRY → LIVE → LOSS → LIVE. Same session and return target, cancelled grace callbacks inert, no entry restart.

PERSISTENT_LOSS_HISTORY: A → ENTRY → LIVE → LOSS → A. One close and one return at 37 seconds.

GENUINE_REACQUISITION_HISTORY: After persistent loss, a later source ONLINE starts a new session and requires a new full gate: A → ENTRY → LIVE → LOSS → A → ENTRY → LIVE. At 59 seconds of the second entry it remains PREPARING.

SESSION_OWNERSHIP: PREPARING/LIVE/LOSS_GRACE cannot create another entry. Operator TAKE B retires the observer and owns Program; stale observer/monitor callbacks cannot restore A or re-promote LIVE. Disarm closes and restores once. Destroying presentation UI alone leaves controller health authority alive.

RETURN_TARGET_REGRESSION: Original 37-second interrupted cue is retained through transient loss and restored on confirmed loss/disarm. Accepted capture code is untouched.

PREVIEW_REGRESSION: Preview remains P through entry, active playback, grace, return and long-running tests. No Preview implementation change.

NORMAL_TAKE_REGRESSION: All accepted handoff tests remain passing, including heavy-media architecture cases VIDEO→VIDEO and VIDEO→AUDIO+motion for CUT/DISSOLVE. StudioRenderer, StudioTransitionCoordinator, StudioSourceManager and PreviewProgramHandoff hashes match the authorized baseline.

PUBLIC_REGRESSION: Shared ProgramOutput snapshots assert exact healthy, transient and persistent histories. Existing Public output tests pass. No subscriber code or protocol changes, and no real-browser visual validation claimed.

OBS_REGRESSION: Existing OBS/output tests pass against the same Program protocol. No OBS subscriber tuning or refresh workaround. Native OBS playback remains a manual retest item.

TESTS_ADDED: 15 tests in `test/autolive-post-take-session.test.js`: initial false-close reproducer; 10/30/60-minute runs; transient and persistent loss/return; UI teardown; operator override; disarm; player recreation; legacy full-loop fault injection with trace; real external SourcePresenceMonitor error mapping; stale monitor generation; retired ENTRY timers/abort/candidate cleanup; cancelled grace callback. Existing entry/handoff/output suites provide the additional protected behavior regressions.

REGRESSION_RESULTS: Full `node --test`: 743/743 PASS from baseline 728. Focused DominantLive, external HLS/Public, entry, loss, handoff, normal TAKE, ProgramOutput and OBS: 288/288 PASS. JavaScript syntax checks pass. `git diff --check` passes with existing CRLF normalization warnings.

FILES_CHANGED_FOR_THIS_FIX: New `public/js/studio/AutoLiveActiveHealth.js`; modified `public/js/studio/AutoLiveEntryController.js`, `public/js/studio/SourcePresenceMonitor.js` (diagnostic consumer generation only), `public/js/core/RuntimeTrace.js` (safe field allowlist); new `test/autolive-post-take-session.test.js`; this audit and local `var/post-take-*` evidence. Existing-file hash comparison: `var/post-take-session-changed-files.json`.

EXISTING_UNSTAGED_WORK_STATUS: Authorized dirty baseline preserved. No reset, restore, clean, stash, stage, commit or push.

PROTECTED_FILES_STATUS: Accepted normal handoff and entry policy/healthy accumulation/presentation code unchanged. No changes to media files, environment, services, MediaMTX, auth, Scheduler, Public/OBS clients or Program output protocol. Existing public/js/server/test hash baseline identifies only the three existing production files listed above as changed by this task.

GIT_STATUS: Remains dirty with prior work and this fix. Raw status recorded in `var/post-take-session-status.txt`.

BLOCKERS: No implementation/test blocker. The exact native-browser incident was not captured here; the identified false-close path is demonstrated by a failing-before/passing-after deterministic test and full-loop fault injection. Manual runtime confirmation is required before claiming the operator's loop resolved.

MANUAL_RETEST: Keep the authorized source transmitting through 60-second ENTRY, then leave LIVE active for 10/30/60 minutes. Confirm no A or second ENTRY. Restart/change Technical Monitor and confirm the Program session remains the same. Briefly disturb playback to verify LOSS→LIVE within the same session; stop the actual source long enough to verify one return, then restart it and require a fresh 60-second entry. Verify cue, untouched Preview and matching Control/Public/OBS history. The bounded local runtime trace now exposes authority and close decisions without secret-bearing URLs.

ENV_CHANGED no

SERVICES_CHANGED no

MEDIAMTX_CHANGED no

AUTH_CHANGED no

PROGRAM_OUTPUT_PROTOCOL_CHANGED no

P0_C1B2_STARTED no

STAGING_CHANGED no

COMMIT none

PUSH none

NEXT_STEP = MANUAL RETEST AUTOLIVE 60S ENTRY → LONG-RUN LIVE ACTIVE

LIVEZONE AUTOLIVE POST TAKE SESSION AUDIT COMPLETE
