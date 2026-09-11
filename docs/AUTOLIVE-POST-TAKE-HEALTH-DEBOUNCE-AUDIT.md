# AutoLive post-TAKE visual health audit

DECISION: AUTOLIVE_POST_TAKE_HEALTH_DEBOUNCE_READY_FOR_MANUAL_RETEST

REAL_RUNTIME_RESULT: Operator reports successful ENTRY and normal heavy-media TAKE, followed by fraction-second LOSS flashes roughly every ten seconds while LIVE audio continues, and one return/reacquisition. This task reproduced the short-event visual flash in a deterministic test before changing production code. The exact native-browser cadence and the operator's single closure were not captured; runtime confirmation remains required.

TEN_SECOND_TIMER_FINDING:

| Mechanism | Timing | Relationship to LOSS |
|---|---:|---|
| Program active-health sampling | 1s | Previously classified missing progress as OFFLINE after 5s |
| Program presentation progress watchdog | 5s | Previously set playback-lost and showed overlay independently |
| HLS source-monitor progress watchdog | 5s | Separate source corroboration; does not own active session |
| Source-monitor uncertainty/retry | 5s each | May explain recurring observations, not proof of the observed cadence |
| Existing AutoLive loss grace | 5s | Former missing-progress watchdog plus grace could close at approximately 10s |
| Failed Program player recovery | 1s | Rebuilds failed player without a Program command |
| Source presence polling/timeout | 1s / 2s | Source corroboration |
| HLS/candidate readiness | 12s | Entry/preparation; unchanged |
| Program Output transport retry | 1s, 2s, 5s, 10s | Publication retry; does not itself create LOSS state |
| New visual debounce | 2s, sampled by existing 1s loop | No additional timer |

No fixed ten-second LOSS-display timer was found. The cadence cannot be attributed conclusively without a real trace. A test injects brief waiting/stalled disturbances every ten seconds and now produces no LOSS revisions.

SLATE_RENDERING_SEMANTICS: LOSS is an overlay above the current Program LIVE, not a BREAK command, source replacement, new surface promotion or new ownership session. Control appends a loss-slate element over Program; ProgramOutputManager publishes the loss graphic while retaining the LIVE source/playback. Public and OBS consume that shared visual state. The underlying media is not paused by the overlay.

AUDIO_CONTINUITY_FINDING: Continuous audio during the flash is consistent with that overlay architecture; it does not imply another audio source was promoted. The prior immediate overlay paths could cover an otherwise still-playing audio/video element. Tests verify the same unmuted, unpaused primary and unchanged playing output snapshot during the deliberate overlay; they do not measure native audio audibility.

POST_TAKE_HEALTH_MODEL: The promoted Program remains the sole active external-HLS health owner. Short uncertainty is retained internally without changing published visual state. Sustained uncertainty becomes CHECKING/LOSS. Missing playback is confirmed only with corroborating source absence, or a longer bounded absence of both playback and positive source evidence. Separate source observations cannot close a progressing Program and are not a second session owner. Managed-ingest/legacy paths are unchanged.

FALSE_LOSS_TRIGGER: AutoLiveActiveHealth previously published CHECKING immediately on waiting/stalled; the base controller started grace and presentation showed LOSS. Independently AutoLiveLossPresentation set programPlaybackLost immediately on those same events or its watchdog. Both paths could show an overlay until the next progressing timeupdate. The new test failed on the baseline with repeated A → ENTRY → LIVE → LOSS → LIVE flashes.

FALSE_SESSION_CLOSE_TRIGGER: The former Program watchdog classified five seconds without progress events as OFFLINE regardless of an externalObservation still ONLINE. Base grace could then restore A after another five seconds, or sooner if uncertainty grace had already elapsed. Current code samples native currentTime as well as events, requires corroborating evidence, and rechecks permission to close at endSession. An ONLINE observation withdraws confirmation even when the Program decoder is still stalled.

VISUAL_LOSS_THRESHOLD: 2000ms of uninterrupted uncertainty/progress absence. The existing one-second sampling loop evaluates it, so visibility occurs at 2–3 seconds depending on event alignment. Progress clears uncertainty immediately. Short waiting/stalled events do not issue LOSS revisions. No new debounce timer and no additional media consumer are introduced.

CONFIRMED_LOSS_THRESHOLD: At least the existing 5000ms without advancing playable Program media plus source OFFLINE; existing 5000ms loss grace still controls return. With source CHECKING/unknown, confirmation requires 5000ms stall interval + 5000ms grace duration without progress or positive source evidence. ONLINE prevents renderer-only closure. The visual threshold and grace overlap: with a disturbance aligned to a watchdog tick, LOSS appears around 2s, corroborated OFFLINE around 5s, and return around 7s; unknown-source confirmation is around 10s. A callback cannot bypass these checks at the close mutation boundary.

ROOT_CAUSE: Low-level transient playback signals were treated as immediate visual loss, and two observers could request that visual state. Event silence could also become source-loss truth without checking positive source evidence. The output retry timer, ENTRY counter and accepted normal handoff are not changed as a response to the approximate cadence.

FIX: Added visualLost/uncertainty state to the existing active Program owner and reused its sampling loop. Presentation follows that owner's debounced decision rather than its independent raw waiting/watchdog flag for active external HLS. Polling supplements timeupdate events. Source observations corroborate loss, and close revalidates current owner/evidence. Superseded watchdog tokens and surface/session generations cannot re-arm or act. Added bounded decision tracing and HLS fatal/nonfatal diagnostic capture without changing HLS recovery behavior.

HEALTHY_LONG_RUN_HISTORY: A → ENTRY → LIVE for 60 simulated minutes with 360 periodic short disturbances, one session, one acquisition, zero closes. Prior healthy 10/30/60-minute tests also pass. Evidence: `var/health-debounce-60min-history.json`.

TRANSIENT_HISTORY: Below threshold: A → ENTRY → LIVE, no LOSS revision. Sustained but recoverable uncertainty: A → ENTRY → LIVE → LOSS → LIVE once, retaining session/cue/Preview. A renderer-only stall with source ONLINE stays in the same session even after 60 seconds and cannot be forcibly closed through source-loss.

PERSISTENT_HISTORY: With absent source and stalled Program: A → ENTRY → LIVE → LOSS → A once at the original cue. Later genuine source return creates a new session and must accumulate a fresh full 60 seconds. Unknown source plus prolonged missing playback also remains bounded; loss handling is not globally suppressed.

AUDIO_SLATE_POLICY: Chosen continuity model: below threshold keep LIVE picture/audio. During a visible LOSS overlay retain available LIVE audio deliberately. The slate covers video only; no mute, pause, source swap or duplicate audio is introduced. This preserves useful audio and existing output behavior. A future silent full-signal slate would require a separate explicit product change across consumers. Current tests explicitly verify the chosen unmuted/unpaused behavior.

PUBLIC_REGRESSION: No subscriber change. Shared snapshots retain LIVE and omit LOSS for short gaps; sustained LOSS adds the existing graphic. Existing Public/output regression tests pass. Native browser rendering was not observed in this task.

OBS_REGRESSION: No OBS behavior/protocol tuning. Existing OBS/output tests pass and the same snapshot graphic drives the visual state. Native OBS retest remains required.

PREVIEW_REGRESSION: Preview remains P through the long run, loss and return; selection/preservation implementation untouched.

CUE_REGRESSION: Interrupted cue 37s remains captured and is restored on confirmed loss. Cue restoration implementation untouched.

NORMAL_TAKE_REGRESSION: Accepted heavy VIDEO→VIDEO and VIDEO→AUDIO+motion handoff tests remain passing. StudioRenderer, SourceManager, TransitionCoordinator and PreviewProgramHandoff hashes match this task's authorized baseline.

TESTS_ADDED: 14 in `test/autolive-health-debounce.test.js`: periodic short waiting; subsecond waiting and stalled; 60-minute repeated-gap run; delayed timeupdate; sustained uncertainty/audio/recovery; renderer stall with ONLINE evidence; persistent loss/new entry; source recovery withdrawing confirmation; stale watchdog after operator override; safe decision trace; brief progress gap; bounded unknown-source loss; superseded watchdog token. One existing cancelled-grace test now advances through the new deliberate visual threshold before capturing its grace callback; its recovery/stale-callback assertions remain intact.

REGRESSION_RESULTS: Full `node --test`: 757/757 PASS, baseline 743. Focused AutoLive/HLS/renderer/normal TAKE/Program Output/Public/OBS: 302/302 PASS. Syntax checks pass. `git diff --check` passes with existing CRLF warnings. Before-fix failure: `var/health-debounce-before.log`; current logs: `var/health-debounce-new.log`, `var/health-debounce-focused.log`, `var/health-debounce-all.log`.

FILES_CHANGED_FOR_THIS_FIX: `public/js/studio/AutoLiveActiveHealth.js`, `AutoLiveEntryController.js`, `AutoLiveLossPresentation.js`; `public/js/studio/renderers/StudioHlsSurface.js` (one diagnostic assignment only); `public/js/core/RuntimeTrace.js` (fatal flag allowlist); `test/autolive-post-take-session.test.js` (threshold-aware stale callback test); new `test/autolive-health-debounce.test.js`; this audit and local evidence in `var/health-debounce-*`. Existing-file hash comparison is in `var/health-debounce-changed-files.json`.

DIAGNOSTICS: The bounded local trace records session generation/ID, source, reason, currentTime, progress age, paused/ended, readyState/networkState, player health, native/HLS mode and last observed HLS fatal/nonfatal status, source observation, SUPPRESSED/SHOWN, and close NO/YES with reason. No HLS error observed is distinct from nonfatal; native mode has no HLS.js fatal flag. Repeated raw events in the same disturbance are coalesced. Example: `var/health-debounce-decisions.json`. No credentials or full URLs are included.

BLOCKERS: No implementation/test blocker. The exact real ten-second cadence and native audio/video behavior remain unmeasured. READY means ready for manual retest, not a claim of observed production resolution. Positive source evidence can intentionally keep a stalled Program session on the visual slate until playback recovers or corroborating availability changes; the observer does not treat that slate as a completed session.

PROTECTED_BASELINE: Branch build/1003.3; dirty worktree preserved. No ENTRY gate/counter, authorization/routing, normal handoff, media assets, cue restore, Preview preservation, Public/OBS normal behavior, auth, MediaMTX, .env or P0-C1B.2 changes. No reset, restore, clean, stash, stage, commit or push. Raw status: `var/health-debounce-status.txt`.

MANUAL_RETEST: Run 60s ENTRY then at least ten minutes of LIVE; verify no brief LOSS flashes or extra ENTRY. Capture the local decision trace if the cadence persists. Test a brief disturbance, a sustained recoverable disturbance, and actual publisher loss/return. Confirm the chosen audio-continuity policy during visible LOSS, identical Control/Public/OBS visual state, unchanged Preview and original return cue.

NEXT_STEP = MANUAL RETEST LONG-RUN AUTOLIVE POST-TAKE HEALTH

LIVEZONE AUTOLIVE POST TAKE HEALTH DEBOUNCE AUDIT COMPLETE
