# AutoLive continuous confirmed-loss grace

DECISION: AUTOLIVE_CONFIRMED_LOSS_GRACE_READY_FOR_MANUAL_RETEST

REAL_RUNTIME_RESULT: Operator accepts ENTRY → 60/60 → LIVE, long-running LIVE, disappearance of periodic LOSS flashes, audio and normal heavy-media handoff. Remaining reported failure: a short real interruption returns to A and runs a new ENTRY. This task reproduced the premature return for a ten-second interruption before changing the implementation. No new native-browser result is claimed.

VISUAL_DEBOUNCE: Accepted 2000ms policy is unchanged, evaluated by the existing one-second sampling loop. A one-second disturbance leaves LIVE visible. Longer recoverable disturbances use the existing LOSS overlay and accepted audio-continuity policy.

CONFIRMED_LOSS_THRESHOLD: One named constant, `AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS = 15000`, in `public/js/studio/AutoLivePostTakePolicy.js`. The existing controller lossTimer is reused; no second close timer is added. The active Program owner supplies the remaining interval for the current loss episode. Existing legacy/managed grace and ENTRY abandonment policy remain unchanged.

LOSS_SESSION_MODEL: Visual uncertainty, source/playback confirmation and session closure are separate. A recoverable LOSS retains the existing session, interrupted cue, Program ownership and Scheduler interruption context. Advancing usable Program playback resets confirmation and removes LOSS. Positive source availability cancels the confirmed-loss deadline even when the decoder still needs to recover; the visual overlay remains until ready playback advances. Later absence starts a new deadline.

The continuous episode starts at the later of playback uncertainty and the observed absence of positive source availability. When both begin at 0s, its deadline is exactly 15s, not 15s after the overlay appears. If source absence is observed later, closure is conservatively later. The existing low-level health classification is still required at close time; a renderer-only stall with source ONLINE cannot close the session.

SHORT_LOSS_TRACE:

| Interruption | Expected and tested result |
|---:|---|
| 1s | LIVE remains visible; same session |
| 3s | LOSS → LIVE; same session |
| 5s | LOSS → LIVE; same session |
| 10s | LOSS → LIVE; same session |
| 14.999s | LOSS → LIVE; deadline cancelled before close |
| 15s continuous confirmed absence | LOSS → A exactly once |

RECOVERY_TRACE: In the deterministic ten-second case, initial LIVE commits at simulated 60s; loss begins at 61s; LOSS appears and the sole return deadline is established at 63s for 76s. Source/playback recover at 71s. The same session returns visually to LIVE, the deadline is cleared and no session-close/restore/ENTRY occurs. Evidence: `var/confirmed-loss-recovery-trace.json` and `var/confirmed-loss-recovery-timeline.json`.

PERSISTENT_LOSS_TRACE: With loss beginning at 61s, A is not restored at 75.999s. At 76s the current confirmed episode reaches fifteen seconds, closes once and restores A at cue 37s. Later ONLINE creates a different session and requires a new full 60-second ENTRY; at 59 seconds it remains PREPARING. Evidence: `var/confirmed-loss-persistent-trace.json` and `var/confirmed-loss-persistent-timeline.json`.

SESSION_IDENTITY: Tests retain the same session object/ID, active owner and Scheduler interruption context through short losses and a Program player rebuild. No new acquisition occurs on recovery. Cleared loss timers are token-invalidated; callbacks from an earlier episode cannot restore A during a later episode. Operator TAKE B and disarm during LOSS invalidate the pending return safely.

RETURN_TARGET: A and its original 37-second cue remain stored during grace. Persistent loss restores that cue once. Preview remains P. Source recovery alone does not reveal an unusable frame: readyState below 2 remains covered, while subsequent unpaused/non-ended advancing playback clears LOSS without a 60-second gate or new preparation deadline.

ROOT_CAUSE: The previous visual debounce fed a legacy five-second loss grace. With LOSS starting near 2s and corroborated absence by 5s, that timer could restore A around 7s, so a ten-second interruption was treated as a completed session. Reacquisition after that closure was behaving correctly; the closure policy was too short.

FIX: Introduced the explicit post-TAKE return threshold and continuous-episode timestamp. Added a grace-duration hook to the base controller, preserving its default behavior; the active entry controller delegates that hook to its Program-health owner. The existing timer is armed for the remaining portion of the fifteen-second episode. Recovery clears its deadline/token; a new absence arms a fresh deadline even when the visual state remains CHECKING. The close mutation boundary requires the current episode to have expired. Player rebuilds do not close or reset the session by themselves.

PROGRAM_HISTORY:

- Sub-debounce glitch: A → ENTRY → LIVE.
- Short recoverable loss: A → ENTRY → LIVE → LOSS → LIVE.
- Persistent loss: A → ENTRY → LIVE → LOSS → A.
- Later genuine return after closure: A → ENTRY → LIVE → LOSS → A → ENTRY → LIVE.

TESTS_ADDED: 14 in `test/autolive-confirmed-loss.test.js`: initial ten-second reproducer; five boundary durations; exact persistent deadline/new acquisition; cancelled timer and second episode; source recovery while decoder remains covered; player rebuild; operator/disarm overrides; recovery trace; insufficient-frame readiness. Existing persistence tests now use the canonical fifteen-second policy, and the stale-grace test supplies source absence before capturing the timer. Their original cue, session, recovery and stale-callback assertions remain.

REGRESSION_RESULTS: Full `node --test`: 771/771 PASS (baseline 757). Focused AutoLive/loss/HLS/renderer/normal TAKE/Program Output/Public/OBS: 316/316 PASS. This includes healthy sixty-minute and periodic-gap/no-flash regressions and accepted heavy-media handoff tests. JavaScript syntax checks and `git diff --check` pass; existing Git CRLF warnings remain. Logs: `var/confirmed-loss-before.log`, `var/confirmed-loss-new.log`, `var/confirmed-loss-focused.log`, `var/confirmed-loss-all.log`.

Public/OBS continue receiving the same Program snapshots with the existing LOSS graphic. Shared output histories and existing subscriber tests pass. No Public/OBS code or protocol change, audio-policy change or native-browser/OBS playback verification is claimed.

FILES_CHANGED_FOR_THIS_FIX: New `public/js/studio/AutoLivePostTakePolicy.js`; modified `public/js/studio/AutoLiveActiveHealth.js`, `AutoLiveEntryController.js`, `DominantLiveController.js`; new `test/autolive-confirmed-loss.test.js`; updated `test/autolive-health-debounce.test.js`, `test/autolive-post-take-session.test.js`; this audit and local `var/confirmed-loss-*` evidence. Existing-file hash comparison: `var/confirmed-loss-changed-files.json`.

PROTECTED_BASELINE: Branch build/1003.3; authorized dirty worktree preserved. ENTRY gate/counter, visual debounce constant, Program-player authority, normal handoff, authorization/routing, slates, cue capture/restore, Preview and subscriber implementation hashes remain unchanged except the explicitly listed active-loss controller work. No media, auth, services, MediaMTX, .env or P0-C1B.2 changes. No reset, restore, clean, stash, stage, commit or push. Raw status: `var/confirmed-loss-status.txt`.

BLOCKERS: No implementation/test blocker. Real runtime confirmation of short publisher interruptions and native player recovery is still required. Confirmation begins from observed evidence, not an unobservable exact publisher-stop timestamp; later observations can conservatively delay return, never shorten the new fifteen-second episode.

MANUAL_RETEST: After accepted ENTRY and stable LIVE, interrupt the actual source for 1/3/5/10 seconds and just under fifteen seconds. Confirm only the longer cases show LOSS, every recovery retains the same session, and none returns to A or starts ENTRY. Keep one interruption beyond fifteen seconds to verify exactly one cue-preserving return. Restart afterward and verify a fresh full ENTRY. Repeat two separate short losses to check deadline reset; verify Control/Public/OBS, audio, Preview and operator TAKE during LOSS.

NEXT_STEP = MANUAL RETEST SHORT LOSS → LOSS SLATE → SAME LIVE

LIVEZONE AUTOLIVE CONFIRMED LOSS GRACE AUDIT COMPLETE
