# Build 1003.4A3 — Control navigation playback continuity

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4A3_CONTROL_CONTINUITY_READY_FOR_MANUAL_RETEST

REAL_BROWSER_RESULT: operator reports Scheduler ONLINE, revision 2, active event and intentionally suspended Program execution; returning to Control shows a frozen frame. This turn inspected actual Program Output SSE read-only. No browser was connected to the available Browser tooling during the preceding runtime investigation; this turn did not perform browser interaction or change live Program.

PROGRAM_EXECUTION_SUSPENDED_STATUS: preserved. No Scheduler core/API/SSE/entrypoint changes in this fix.

RETAINED_PROGRAM_STATE: present at inspection, revision 3; sceneId media-demo-2-scene; sourceId media-demo-2; initialTime 17.890617; duration 6914.139955; playing false; state paused; ended false; startedAt and publishedAt 2026-09-12T19:43:57.926Z. This is a paused authoritative snapshot, not a missing retained frame. Projection therefore remains 17.890617. Actual browser readyState, paused property, currentTime and play() outcome were not accessible; they are not inferred from the HTTP snapshot.

NAVIGATION_TRACE: Control renderer transport -> ProgramOutputManager publishes playback state -> server retains the envelope -> Scheduler does not publish Program -> returning Control reads retained SSE before renderer bootstrap -> ProgramPlaybackContinuity validates identity/age and projects elapsed playing time -> StudioRenderer seeks and waits for readiness -> activates playing media, or preserves paused media. Back/forward-cache pageshow handling already reloads Control through this bootstrap and was not changed.

FIRST_DIVERGENCE: the actual observed divergence precedes cue projection: retained playback is already paused. Code-path reproduction shows that a browser-induced pause received while the document is hidden was accepted by ProgramOutputManager as a new authoritative paused transport. The returning bootstrap then correctly preserves that unintended paused state. The exact browser lifecycle event responsible for the operator incident still needs confirmation during manual retest; no browser event trace was captured for the original failure.

PLAYBACK_PROJECTION: unchanged expectedPlaybackTime. Playing VIDEO/AUDIO with cue 37 and 20 seconds elapsed restores 57; paused sources remain at 37. Expired/future/identity-mismatched snapshots remain rejected and ended media stays ended.

PLAYBACK_RESUME: new tests exercise StudioRenderer with actual StudioMediaSurface and StudioAudioSurface implementations, backed by simulated DOM/media events. They verify cue seek, readiness, play invocation, paused state and subsequent transport time progression. This is production application code coverage, not evidence of native-browser decoder progress. Bounded existing RuntimeTrace now records navigation ready/resume-complete/resume-blocked/resume-rejected with source/scene, expected time, currentTime, readyState and paused, without URLs or payloads.

SERVER_RESTART_FINDING: ProgramOutputStore is in-memory. The authorized prior Node restart had no retained envelope observed immediately afterward. Current retained state is now present and paused, so that missing-state condition is not the current observation. If a retained read times out or is unavailable, continuity returns null. Existing normal selected-source initialization remains the fallback (default cue zero), without inventing elapsed time from Studio selection storage. New VIDEO/AUDIO tests verify that this path starts playback rather than waiting indefinitely on an unavailable cue. Exact pre-restart position cannot be recovered without an authoritative retained envelope. No server restart or persistence change was performed for this fix.

ROOT_CAUSE: reproduced defect at the browser transport-to-retained-state boundary: a hidden-document pause can overwrite a playing retained clock. This is consistent with the observed paused retained snapshot. A3 did not change the projection/bootstrap order in its active startup path; removing legacy planned Program execution may expose behavior previously masked by automatic activation, but no causal claim about that masking is established.

FIX: ignore a paused transport notification only when the document is hidden, the retained snapshot is playing the same source, the notification is not ended and no Program publication is pending. Keep the last playing transport and retained timeline. Visible pause notifications remain authoritative; new Program activation remains subject to existing readiness. Add bounded diagnostic hidden-pause-ignored. No local cue store, schedule execution or protocol field is added. Existing paused retained records are deliberately not changed to playing automatically.

VIDEO_CONTINUITY: automated projection, actual surface seek/play and hidden-pause publication protection PASS.

AUDIO_CONTINUITY: equivalent cases PASS.

PAUSED_CONTINUITY: visible pauses remain published; paused VIDEO/AUDIO restore exact cue without play or elapsed projection.

PREVIEW_REGRESSION: selected Preview is unchanged in new and existing continuity tests. No Preview setter or handoff implementation changed.

SCHEDULER_AUTHORITY_REGRESSION: existing server/migration tests pass, including suspended engine with no commands/deadlines and server Program plan without output side effects.

PROGRAM_EXECUTION_REGRESSION: suspended policy preserved. Normal TAKE, AutoLive and Public/OBS regression suites pass in the full run. No changes to AutoLive, handoff, media decoder implementation, Control Desk, MediaMTX, authentication, .env or Program Output protocol.

TESTS_ADDED: 9 in program-playback-continuity.test.js: two hidden-pause preservation/visible-pause cases; four VIDEO/AUDIO playing/paused tests with actual application surfaces; two missing-retained normal initialization tests; one delayed retained read. Existing tests cover invalid/stale snapshots, ended playback, retained SSE timeout/errors, one-shot cue consumption after TAKE, subscriber revision ordering and scheduled Program suspension. Native-browser media events remain a manual verification boundary.

FOCUSED_TEST_RESULT: 161/161 PASS for continuity, Program Output network, server schedule migration and API tests before diagnostic-only instrumentation; the final full suite includes these tests with instrumentation.

FULL_TEST_RESULT: node --test 928/928 PASS; zero failures, skipped or cancelled.

SYNTAX_RESULT: node --check PASS for ProgramOutputManager.js, StudioRenderer.js and program-playback-continuity.test.js.

DIFF_CHECK_RESULT: git diff --check PASS.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/program-output/ProgramOutputManager.js
- public/js/studio/StudioRenderer.js
- test/program-playback-continuity.test.js
- docs/BUILD-1003.4A3-CONTROL-CONTINUITY-AUDIT.md

Existing unstaged A1/A2/A3 work and protected media/runtime files remain preserved. No stage, commit, push, service restart, schedule mutation or live Program command performed.

BLOCKERS: none for manual retest. Original browser lifecycle trigger is not directly captured; actual native playback recovery is not yet verified. Previously retained paused state cannot safely be distinguished from a genuine pause and is not automatically repaired.

MANUAL_RETEST: reload Control to load updated browser modules, then use an intentional operator action to establish playing VIDEO. Confirm advancing Program and retained playing=true before navigating Control -> Scheduler -> Control. Spend approximately 20 seconds away and verify cue projection and continuing playback in Control/Public/OBS. Repeat AUDIO and genuinely paused VIDEO/AUDIO, verifying Preview unchanged. Keep a server-active scheduled event during the exercise and verify it never issues TAKE. If failure recurs, inspect existing in-memory RuntimeTrace continuity and program-output entries for hidden-pause-ignored, retained-cue, ready and resume result; do not infer autoplay failure from a still frame alone. Test server-restart/missing-retained behavior only in a separately authorized maintenance window; this fix does not require a Node restart.

NEXT_STEP: MANUAL RETEST CONTROL → SCHEDULER → CONTROL PLAYBACK CONTINUITY

LIVEZONE BUILD 1003.4A3 CONTROL CONTINUITY AUDIT COMPLETE
