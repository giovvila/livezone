# AutoLive 60-second stable entry gate

DECISION: AUTOLIVE_60S_ENTRY_GATE_READY_FOR_MANUAL_RETEST

BASELINE: Authorized dirty worktree on build/1003.3; reported baseline 616/616 tests. Existing work preserved. No reset, restore, clean, stash, stage, commit or push.

PRODUCT_POLICY: Authorized LIVE detection starts one interruption session immediately. Capture the current Program and fresh playback cue/state, pause it, present the dedicated ENTRY slate, and require 60 continuous seconds of healthy candidate playback before committing LIVE. Instability resets the counter while ENTRY remains visible. Persistent unavailability abandons the entry and returns to the captured Program. This intentionally supersedes the previous low-latency entry policy.

OLD_PREROLL_MODEL: Source-only stabilization followed by a short 3-second Program candidate gate, with A continuing to play until TAKE. The previous latency work optionally skipped the source-only wait. Neither of those entry paths is used by the new production bootstrap. Their reusable playback checks and regression coverage remain available for existing callers.

NEW_ENTRY_GATE_MODEL: Control Room creates AutoLiveEntryController. Its entry path captures and reserves the interruption before preparing LIVE, without selecting LIVE in Preview or occupying the transition coordinator for a minute. One candidate obtains readiness and proves the full 60-second gate. StudioProgramCommand.commitPrepared promotes that same prepared renderer through a Program-only state update. No second preparation, source-only sleep, 3-second add-on, or return-target capture occurs at promotion. A fatally failed candidate is retried within the same entry ownership session.

ENTRY_SLATE_MODEL: Dedicated internal AutoLive entry presentation, distinct from LOSS and operator BREAK. Text: COLLEGAMENTO LIVE IN PREPARAZIONE / La trasmissione inizierà tra pochi istanti. Control renders the dedicated overlay above paused A. The effective published Program is a valid existing SLATE/break representation identified as autolive-entry-slate, with no normal BREAK command. It includes only the safe title, message and logo; the countdown is not public.

STABILITY_SIGNAL: The actual candidate must match the authorized source, its source-health authority must be ONLINE, media readiness must be satisfied, and playback must advance. The existing progress-gap limit of 1500 ms and minimum advancing-media requirement are preserved. Waiting, stalled playback, pause, source-health discontinuity, fatal failure and backwards media-time reset invalidate continuity. Wall time alone, repeated ONLINE notifications or a decoded frozen frame cannot authorize TAKE.

STABILITY_DURATION: AUTO_LIVE_ENTRY_STABILITY_MS = 60 * 1000, exported in public/js/studio/AutoLiveEntryPolicy.js and accepted as a validated internal constructor setting. No UI duration control or presets added. The measured interval begins with actual healthy progression, so initial source/readiness latency precedes the minute. Tests prove 59,999 ms cannot commit and a qualifying new progress observation at 60,000 ms commits once.

STABILITY_RESET_BEHAVIOR: Meaningful instability immediately resets local stableElapsed to zero. ENTRY stays visible. Healthy recovery starts a new full interval on the same candidate when that candidate remains usable. Fatal preparation failure discards only the failed candidate and retries; it does not restore A or create a second interruption session. The former fixed short preparation deadline is disabled only for the entry stability observation; explicit abandonment and cancellation bound unavailable candidates.

ENTRY_ABANDONMENT_POLICY: AUTO_LIVE_ENTRY_ABANDONMENT_MS = 22,000 ms: existing 12,000 ms readiness budget + 5,000 ms retry interval + 5,000 ms loss grace. It starts at entry while no usable playback has yet been demonstrated, and restarts on a newly detected unusable interval after healthy progression. Only actual healthy candidate progress cancels it; repeated source ONLINE reports, readiness events and retries cannot extend an unavailable interval. At its deadline entry closes and restores A once. An explicit OFFLINE edge is timed immediately; silent frozen playback is first detected by the existing 1500 ms progress-gap observer, then receives the 22-second unavailable allowance. This is separate from the 60-second TAKE requirement. An intermittently recovering, still viable source may keep ENTRY visible while trying to achieve a full minute; permanent absence cannot.

INTERRUPTED_PROGRAM_PAUSE: The active renderer refreshes its transport before capture, avoiding a stale timeupdate cue. Media and audio receive pauseForInterruption, which prevents their normal Program pause-recovery logic from restarting playback behind ENTRY. Playback is stopped at the captured cue. Tests cover media and audio, fresh fractional cues, and an originally paused Program. The Program candidate remains muted during preparation.

RETURN_CUE_MODEL: A single return target contains scene/source, captured playback cue/state and Preview reference. A same-surface return after abandonment/disarm resumes that paused renderer from the saved cue. After LIVE, a Program-only command prepares A at the same saved cue and preserves its original playing/paused state. Prepared paused media no longer starts automatically at activation. The Scheduler interruption context covers the whole ENTRY → LIVE → return interval.

PREVIEW_BEHAVIOR: AutoLive never selects the LIVE candidate in Preview. Program-only commit and return paths leave Preview untouched. Tests keep P selected through entry, reset, LIVE promotion, abandonment and post-TAKE return. Explicit operator Preview changes remain operator actions; there is no AutoLive A-to-Preview swap.

OPERATOR_OVERRIDE: A successful operator TAKE B cancels entry ownership, aborts preparation, clears retry/abandonment work and prevents both LIVE and A from overwriting B. Session, attempt and generation checks reject stale callbacks. Entry completion and retries also defer to an operator TAKE that is still preparing a slow source; they cannot replace its candidate. This case has a dedicated regression test.

DISARM_BEHAVIOR: Disarming cancels entry and restores A at the captured cue/state unless a newer operator action owns Program. Explicit re-arming authorizes a fresh entry even if the external source remained continuously ONLINE and emitted no new transition. No persistence format or authorization write path changes.

SOURCE_CHANGE_BEHAVIOR: The existing authorization/source lifecycle closes the old entry and invalidates its candidate. Old-source ONLINE or progress cannot finish the gate. A newly authorized healthy source begins its own entry only after the old return/ownership rules have been reconciled.

POST_TAKE_LOSS_BEHAVIOR: After promotion the established loss controller and Program-player observation remain in use. Temporary loss shows LOSS, not ENTRY; recovery keeps the same session. Confirmed loss returns once to the original captured A cue. LOSS text is localized to SEGNALE LIVE TEMPORANEAMENTE NON DISPONIBILE using the existing shared loss-slate renderer. The post-TAKE grace duration and source-loss architecture are unchanged.

PUBLIC_BEHAVIOR: Already-open Public follows A → ENTRY → LIVE or A → ENTRY → A through existing Program Output revisions/SSE, without refresh. A is released/paused when ENTRY is displayed. The audio permission gate does not delay the safe slate. Existing post-TAKE LOSS behavior passes its regressions.

OBS_BEHAVIOR: The same sequences and safe text are exercised through the OBS subscriber mode. Existing audio behavior and normal subscriber promotion paths are unchanged. No production PublicProgramController or OBS entrypoint changes were required.

PROGRAM_OUTPUT_MODEL: Protocol version/schema remains unchanged. ENTRY uses the existing validated SLATE scene plus break source shape, with a dedicated entry identity and fixed broadcast-safe content. LOSS retains its reserved graphic representation over the same LIVE activation. Internally, StudioStateManager retains A while it is paused under ENTRY; ProgramOutputManager projects the effective ENTRY slate to subscribers. The one AutoLive session owns that temporary presentation. Normal operator BREAK does not create an AutoLive session or entry countdown. Underlying media pause notifications may create another revision of A before ENTRY; they do not create an extra Program transition. Tested effective visual history is exactly A → ENTRY → LIVE.

SESSION_OWNERSHIP: One session ID from capture through PREPARING, LIVE and LOSS_GRACE, then CLOSED. The return target is not recaptured at LIVE TAKE or candidate retry. Abandonment deadlines carry cancellation tokens, and candidate callbacks carry session/attempt/generation guards. Runtime cleanup aborts the gate and clears its timers; operator override does not run an A restore over B.

FIX: Added entry policy/controller/presentation and shared safe entry slate; reused the proven playback stability checker with entry progress/reset/cancellation hooks; added a Program-only commit path for prepared LIVE and cue-aware returns; added logical interruption pause/resume to media/audio; connected the new policy and lifecycle cleanup in Control Room; exposed local PREPARING / STABLE n / 60 s status; retained existing routing, persistence, Scheduler and subscriber architecture.

TESTS_ADDED: 22 entry/pause/UI/ownership tests and 4 Public/OBS entry sequence tests, for 26 additional tests. Existing startup-order assertion now expects AutoLiveEntryController. Existing loss text assertions use the requested localized text.

| Requested coverage | Evidence |
| --- | --- |
| 1–7 Immediate ENTRY, paused A, Preview P, 59/60 threshold, exact visual history | Same-candidate 59,999/60,000 ms integration test with production state, renderer, command and output manager |
| 8–11 Reset at 30s, retained ENTRY, recovery and new minute | Reset/recovery integration test plus fatal candidate retry |
| 12–16 Persistent loss, bounded abort, cue restore, subscriber return | 22-second OFFLINE/no-frame/frozen-frame tests and Public/OBS abandonment sequences |
| 17–20 Operator B, cancellation, stale completion, no A over B | Operator override, stale callback and slow manual preparation tests |
| 21–23 Disarm, changed authorization, stale old source | Disarm, re-arm and source-change tests |
| 24–28 Post-TAKE LOSS/recovery/return, original cue and Preview | Full ENTRY → LIVE → LOSS → LIVE/A integration tests; paused-state return |
| 29–33 Public/OBS sequences without refresh and preserved LOSS | Four new SSE subscriber sequence tests plus existing LOSS and HTTP/SSE regressions |
| 34–38 Continuous timing, 59.999 boundary, one TAKE, duplicate health, cleanup | Frame-driven clock tests, frozen candidate, repeated ONLINE, stale deadline and runtime cleanup |

REGRESSION_RESULTS: Final focused suite: 291/291 PASS (var/entry-60s-focused.log). Final full suite: 642/642 PASS, zero failures (var/entry-60s-all.log). Syntax checks and git diff --check pass. Verification uses deterministic media/DOM simulations and existing transport/server tests, not physical browser/OBS rendering.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/studio/AutoLiveEntryPolicy.js (new)
- public/js/studio/AutoLiveEntryController.js (new)
- public/js/studio/AutoLiveEntryPresentation.js (new)
- public/js/program-output/AutoLiveEntrySlate.js (new)
- public/js/entries/control-room-app.js
- public/js/core/StudioStateManager.js
- public/js/scheduler/StudioProgramCommand.js
- public/js/studio/StudioTransitionCoordinator.js
- public/js/studio/StudioRenderer.js
- public/js/studio/LivePlaybackStability.js
- public/js/studio/LiveSourceMonitor.js (named readiness constant)
- public/js/studio/renderers/StudioMediaSurface.js
- public/js/studio/renderers/StudioAudioSurface.js
- public/js/program-output/ProgramOutputManager.js
- public/js/program-output/AutoLiveLossSlate.js (localized text)
- public/js/ui/DominantLiveUI.js
- test/autolive-entry-gate.test.js (new)
- test/autolive-authorization.test.js
- test/external-hls-public.test.js
- test/external-hls-stability.test.js
- this audit and local validation artifacts under var/

EXISTING_UNSTAGED_WORK_STATUS: Baseline SHA-256 inventory retained. Only the 13 intended previously dirty files changed; no baseline files removed. Two previously clean tracked media/audio renderer files were changed for the explicit interruption pause contract. Media assets were neither edited nor included in hashing. Unrelated unstaged work remains intact.

PROTECTED_FILES_STATUS: Environment, services, MediaMTX, external/managed source routing, authorization persistence, armed persistence, SourcePresenceMonitor browser binding, Control Desk, Scheduler engine, normal Public/OBS production controllers and Program Output schema untouched. Entry-specific command/state/rendering extensions preserve normal Preview-based TAKE defaults. The previous short entry policy is intentionally superseded by the new product requirement.

GIT_STATUS: build/1003.3; authorized dirty worktree retained; index unchanged and empty.

BLOCKERS: No implementation/test blocker. Real Control/Public/OBS manual verification remains required; this run does not claim physical runtime verification.

MANUAL_RETEST: Load the updated Control/Public/OBS modules. Start A at a known cue with P in Preview, then detect the authorized LIVE source. Confirm immediate ENTRY and paused A; check STABLE n / 60 s only in Control. Confirm no LIVE before a full healthy minute and one LIVE promotion afterward. Introduce a brief instability at roughly 30 seconds: ENTRY must remain and a new full minute must be required. Keep the candidate unavailable past 22 seconds after detection: A must return once at its cue/state. TAKE B during another ENTRY, including with a slower-loading B, and wait past the old gate: B must retain authority. Test disarm, explicit re-arm and source change. After a successful minute and LIVE TAKE, verify the distinct LOSS slate and the original A return cue in both transient and persistent loss cases.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST AUTOLIVE 60S STABLE ENTRY GATE

LIVEZONE AUTOLIVE 60 SECOND ENTRY GATE AUDIT COMPLETE
