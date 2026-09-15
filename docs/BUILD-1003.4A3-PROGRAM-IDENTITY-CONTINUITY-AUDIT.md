# Build 1003.4A3 — Program identity continuity investigation

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4A3_PROGRAM_IDENTITY_CONTINUITY_BLOCKED

REAL_BROWSER_FAILURE: operator reports playing VIDEO before navigation and unavailable LIVE after returning to Control, with BREAK Preview and scheduled Program execution suspended. No browser interaction was performed by the agent. A read-only Program SSE capture was requested while the operator reproduced the round trip; no completion reply or original browser RuntimeTrace was received in this turn.

PRE_NAV_PROGRAM: observed live stream publisher 6e5953b8-993f-4ba4-8db4-542677f9feb4, revision 3, scene media-scene-fef8ea15-65ce-4640-ab64-0e57b97e218a, source video-9cc49a42-c1df-4d0f-bce6-6014cdc6c0cd, kind media, playing true, initialTime 3.727984, duration 778.68, playback.startedAt 2026-09-12T20:06:09.636Z. Browser StudioState, media instance/currentTime and live AutoLive session were not observable through SSE and were not inferred.

PROGRAM_OUTPUT_HISTORY_WHILE_CONTROL_ABSENT: captured the following history in the current runtime; exact page-absence boundaries were not supplied, so this cannot be claimed as the complete requested navigation history. Times below are UTC.

| Observation | Publisher revision | Identity | Playback | Published at |
|---|---|---|---|---|
| 20:05:21.536 | same publisher / 1 | VIDEO, source video-9cc49a42-c1df-4d0f-bce6-6014cdc6c0cd | paused, cue 39.44653 | 20:03:05.419 |
| 20:06:05.809 | same publisher / 2 | BREAK | ready | 20:06:05.804 |
| 20:06:09.644 | same publisher / 3 | same VIDEO | playing, cue 3.727984 | 20:06:09.636 |
| 20:09:04.121, second subscription | same publisher / 3 | same VIDEO | same retained playing clock | unchanged |

First observation window lasted 180 seconds; second lasted 90 seconds. No LIVE revision or new publisher was observed. SSE provides publisherSessionId and revision but no command reason; assigning these revisions to operator TAKE, AutoLive or teardown without browser traces would be speculation. The retained initial packet is not a new publication.

AUTOLIVE_OWNERSHIP: source audit shows AutoLiveEntryController constructs without a session; configuration only selects the monitor. ARMED/WAITING is not ownership. The new production-class test starts an armed offline/waiting controller alongside a suspended Scheduler, then destroys it: no LIVE publication or Program command occurs. Real operator ownership at the reported failure remains unmeasured. An actual retained LIVE snapshot is accepted as Program authority when it resolves to the registered source; this does not manufacture an AutoLive session. The retained protocol does not distinguish operator-selected LIVE from AutoLive-selected LIVE.

SCHEDULER_PROGRAM_COMMAND_COUNT: zero in the focused armed/waiting/navigation test and existing suspended-engine regression. Scheduler page does not construct ProgramOutputManager or AutoLiveEntryController. Server ACTIVE overlay/Program-plan interval state remains non-broadcast in A3. No production command count was inferred from the widget label alone.

RETAINED_PROGRAM_BEFORE_RETURN: most recent read-only capture is revision 3 VIDEO playing. The exact instant of return that produced the reported LIVE surface was not captured.

CONTROL_BOOT_SELECTED_PROGRAM: before this fix, StudioStateManager restored local selection; programPlaybackContinuity rejected retained data whenever its sceneId differed from that local selection. StudioRenderer then rendered the local scene. Therefore stale local LIVE plus fresh retained VIDEO reproducibly selected LIVE and discarded the VIDEO cue. The new bootstrap selects the validated, registered retained identity before cue projection or renderer/publisher startup.

FIRST_IDENTITY_DIVERGENCE: confirmed code-path divergence is local selection taking precedence over retained Program identity. Tests reproduce it using local LIVE, retained VIDEO, BREAK Preview. Whether this exact mismatch produced the original screenshot is not yet established by the mandatory full browser history.

ROOT_CAUSE: identified and corrected a concrete identity-authority precedence defect. The exact producer/reason of the original reported LIVE reconstruction remains unresolved; the current runtime capture does not show anyone publishing LIVE.

FIX: restoreRetainedProgramIdentity validates the existing Program Output snapshot, age, registered scene/source identity and URL, then updates only Program through StudioStateManager before computing playback continuity. It never calls TAKE, swaps Preview or reads AutoLive authorization. Valid empty retained output releases only Program. Invalid/stale/mismatched/unresolvable snapshots are rejected with a bounded trace. Missing retained output keeps the existing Studio selection, not an authorized LIVE fallback. The helper does not invent scenes/sources or overwrite a changed source definition; source-resolution failures remain visible in diagnostics and require investigation rather than accepting mismatched media. No renderer or Program Output protocol modification in this turn.

Additional bounded diagnostics record Control leave/return visibility, explicit ENGINE_STOP teardown, boot selection, actual transport source/instance/cue, retained identity/revision, authorized AutoLive source and session ownership. These listeners only record in the existing in-memory RuntimeTrace; they issue no commands. identity-accepted/identity-rejected precede retained-cue. Existing ProgramOutputManager publish-attempt traces supply publication reason. No URLs, tokens or payload dumps are recorded.

VIDEO_IDENTITY_CONTINUITY: tests PASS for retained VIDEO overriding stale local LIVE with BREAK Preview. Publisher/teardown test retains VIDEO without any LIVE revision.

VIDEO_CUE_CONTINUITY: identity resolves first, then 30 seconds plus 20 elapsed yields cue 50. Existing actual-application-surface tests verify seek and play behavior with simulated media events. Native decoder playback has not been tested in this turn.

AUDIO_REGRESSION: same identity and cue precedence tests PASS.

PAUSED_REGRESSION: paused VIDEO/AUDIO remain at cue 30, with no elapsed projection or forced play.

PREVIEW_REGRESSION: BREAK stays Preview throughout; retained empty clears only Program. No TAKE-based reconstruction.

AUTOLIVE_REGRESSION: armed/waiting startup and teardown issue zero Program commands; existing AutoLive tests pass. Timing, acquisition, ownership and loss policies unchanged. Valid retained LIVE identity is preserved without synthesizing an active session.

SCHEDULER_REGRESSION: suspended execution remains explicit; no server/API/SSE/migration changes in this fix.

PUBLIC_OBS_REGRESSION: full suite passes; Public/OBS implementation and Program Output protocol untouched.

TESTS_ADDED: 11 in test/program-identity-continuity.test.js: four VIDEO/AUDIO playing/paused identity-before-cue cases; real AutoLiveEntryController + SchedulerEngine + ProgramOutputManager + server ProgramOutputStore lifecycle with zero LIVE output; retained LIVE; missing retained/restart; empty retained; identity/source/age rejection; stale LIVE versus newer VIDEO through server revision acceptance; production Control entry ordering. These complement existing media advancement, normal TAKE, active AutoLive and subscriber revision-ordering tests.

FOCUSED_TEST_RESULT: 224/224 PASS. Final entry import smoke check also PASS.

FULL_TEST_RESULT: node --test 939/939 PASS, no skipped/cancelled tests. An initial diagnostic-listener compatibility issue in the minimal entry test was corrected before the passing run.

SYNTAX_RESULT: node --check PASS for the changed entry, continuity helper and new test.

DIFF_CHECK_RESULT: git diff --check PASS.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/entries/control-room-app.js
- public/js/studio/ProgramPlaybackContinuity.js
- test/program-identity-continuity.test.js (new)
- docs/BUILD-1003.4A3-PROGRAM-IDENTITY-CONTINUITY-AUDIT.md (new)

Existing work, media and var data preserved. No stage, commit, push, service restart, Program command or schedule mutation performed by the agent.

BLOCKERS: the user-required complete pre-navigation/absence/return history and exact LIVE producer/reason have not been captured. The observed stream remained VIDEO and no completion reply was received. Consequently this report does not claim that the original real-browser incident is resolved merely because a concrete precedence defect and automated tests are fixed.

MANUAL_RETEST: load the changed browser modules in Control, establish VIDEO playing with BREAK Preview, and capture existing RuntimeTrace across leaving and returning while a read-only SSE observer records revisions. Compare control/program-identity, control/retained-identity, control/autolive-ownership, continuity/identity-accepted or identity-rejected, retained-cue and program-output/publish-attempt. Report when the round trip is complete so page boundaries can be correlated. Expect the same VIDEO source, projected cue, continuing playback and unchanged BREAK Preview. Repeat AUDIO and paused cases. AutoLive may remain armed/waiting; no scheduled TAKE may occur. No Node restart is needed for these browser-module changes.

NEXT_STEP: MANUAL RETEST VIDEO PROGRAM → SCHEDULER → SAME VIDEO PROGRAM

LIVEZONE BUILD 1003.4A3 PROGRAM IDENTITY CONTINUITY AUDIT COMPLETE
