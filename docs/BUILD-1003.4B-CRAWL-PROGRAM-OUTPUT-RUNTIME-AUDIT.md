# Build 1003.4B — Crawl / Program Output runtime repair

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Date: 2026-09-13. Branch: build/1003.4. This audit supersedes the previous B audit's overlay-only restart policy. Earlier work and documents remain intact.

| Requested field | Result |
|---|---|
| DECISION | BUILD_1003_4B_CRAWL_PROGRAM_OUTPUT_RUNTIME_READY_FOR_MANUAL_RETEST |
| REAL_RUNTIME_FAILURE | Operator reports no scheduled crawl in Control and unsuccessful Public/OBS startup. The original active-window client error was not captured by this investigation. |
| SCHEDULE_EVENT_STATUS | Persisted revision 6 contains enabled overlay.crawl event crawl-920a110e-d4a1-415b-bd51-425d922b26ed, name test, priority 1; start 2026-09-13T11:40:01Z, end 11:42:01Z. Already expired at inspection around 11:51Z. |
| SERVER_EFFECTIVE_CRAWL_STATUS | Isolated production resolver replay at 11:40:02Z selects this event and produces a validated effective crawl. This is replay evidence, not a historical capture of the running scheduler. |
| CONTROL_CRAWL_FIRST_DIVERGENCE | Control has a separate NetworkProgramOutputTransport SSE subscriber, wired to Program graphicsLayer after StudioRenderer.start. It is not limited to locally published overlays. First reproducible client boundary defect is TextCrawlView's timer receiver; actual browser stack remains unobserved. |
| PROGRAM_BASE_STATUS | Two independent live SSE reads at 11:51:08/10Z received a valid complete MEDIA B snapshot; base therefore exists now. Raw store has no separate read endpoint; base details below derive from the valid outward composite. |
| PROGRAM_BASE_AFTER_RESTART | Absent in previous restart observation, as expected for the existing in-memory store. New exact restart test verifies no synthetic Program is published. |
| EFFECTIVE_MERGE_MODEL | Retain resolved crawl separately; only project into an existing scene/source base. Preserve publisher-owned scene/source/playback/graphics/identity; change crawl overlay plus server output metadata. |
| MERGED_SNAPSHOT_VALIDATION | Every projected envelope uses production createProgramOutputEnvelope/validateProgramOutputSnapshot. Rejected crawl projection falls back to validated original base with server output revision. |
| REVISION_HISTORY | Observed publisher revision 5, server output revision 19. Earlier history unavailable. Tests verify server-only increments, stale publisher rejection, server-session ordering and no unchanged raw duplicate at scheduler readiness. |
| PUBLIC_FIRST_DIVERGENCE | Independent live SSE probe received HTTP 200 text/event-stream and a validator-accepted complete snapshot. Page preparation/error during the failed event unavailable. Timer receiver defect affects shared crawl rendering, including empty crawl. |
| OBS_FIRST_DIVERGENCE | Separate live SSE probe independently received HTTP 200 and a valid complete snapshot. Actual OBS browser-source preparation remains unobserved. Separate OBS-mode HTTP-to-preparation regression passes. |
| ROOT_CAUSE | Reproduced implementation defects: browser timer functions invoked with TextCrawlView as receiver; synthetic overlay publisher when base missing; unguarded invalid optional merge/subscriber callbacks; duplicate raw delivery on scheduler readiness. Attribution of the original operator failure to the timer defect requires native retest. No claim of a malformed live envelope was established. |
| FIX | Wrap timer calls without view receiver; wait for real base; validate/fall back to original Program; isolate consumer callbacks and optional crawl rendering errors; deduplicate unchanged raw output; bounded traces. |
| MISSING_BASE_POLICY | No invented BREAK/LIVE/media identity or synthetic Program publisher. Effective crawl retained separately until a real base arrives. Explicit empty snapshots published by Control remain legitimate, unmodified empty output. |
| CONTROL_RECONNECT_BEHAVIOR | Existing publisher startup publishes when Program transport is ready; publisher SSE reconnect queues its latest envelope. This mechanism is unchanged. Exact HTTP test verifies first real post-restart publication merges the active event for two subscribers. |
| CONTROL_CLOSED_BEHAVIOR | With a valid retained base, scheduler activation/expiry continues through server SSE without Control. |
| PROGRAM_MEDIA_CONTINUITY | VIDEO/AUDIO/LIVE/BREAK fields preserved; unchanged media surface and playback transport on crawl start/end tested. No Program or Preview commands added. |
| MANUAL_CRAWL_REGRESSION | Manual > scheduled preserved; release restores current scheduled winner. Timer fix also applies to existing manual crawl. |
| AUTOLIVE_REGRESSION | Focused AutoLive and full suite pass; state machine/timing unchanged. |
| TEST_FIDELITY_GAP | Earlier tests permitted synthetic empty output and used Node timers that accept arbitrary receivers. New receiver-contract test models the browser constraint. DOM/media doubles still do not replace native decoding or operator browser evidence. |
| TESTS_ADDED | 19 additional tests; existing restart test replaced with exact missing-base → first Control publication → Public/OBS sequence. Crawl suite now 68 tests. |
| FOCUSED_TEST_RESULT | 436/436 PASS, default test concurrency |
| FULL_TEST_RESULT | 1007/1007 PASS, node --test --test-reporter=tap |
| SYNTAX_RESULT | Five changed JavaScript files checked |
| DIFF_CHECK_RESULT | git diff --check PASS; Git line-ending notices only |
| BLOCKERS | No code/test blocker for manual retest. Actual browser inspection blocked by automatic approval review; authenticated runtime scheduler state and historical client error not observed. Updated backend requires separately authorized loading/restart. |
| MANUAL_RETEST | Load updated backend and client modules, then perform sequence below. No operational event/Program mutation or service restart performed in this task. |
| NEXT_STEP | MANUAL RETEST PROGRAM + SCHEDULED CRAWL ON CONTROL/PUBLIC/OBS |

## Actual observations and their limits

The persisted event payload is text `TEST LIVEZONE — CRAWL PROGRAMMATO`, bottom, rtl, medium, repeat continuous, style broadcast-default, background true. The event is enabled but expired at inspection. Reading the existing file did not modify it. No event was created, extended, activated or deleted for diagnosis.

Both live probes returned scene media-demo-2-scene / MEDIA B / MEDIA, source media-demo-2 / media, playing true, initialTime 2.413996, duration 6914.139955, startedAt 2026-09-13T11:48:06.814Z. Server output session was 86ae5b15-0b30-4f00-a43f-9d8ece116d97, revision 19, overlayOnly false; publisher revision 5. Source URLs and credentials are omitted. The manual crawl was disabled and there was no active scheduled crawl after expiry. The publisher session ID was not recorded in the safe probe summary, so its exact historical origin is not asserted.

Production resolveSchedule was replayed against the saved event at one second after start, and EffectiveProgramOutput merged it into the observed valid media base in an isolated object graph. Validation passed and identity was preserved. The replay did not change the service clock, schedule file, live retained state or subscriber streams.

Browser connection was rejected by automatic approval review, citing the prior restart-only instruction to stop before browser/manual testing. No alternative browser access was attempted. Consequently neither Public nor OBS native decoding success is claimed. The separate probes establish transport/content, while separate output-mode tests establish the production preparation code path using media/DOM doubles.

## Implementation and safety

TextCrawlView previously assigned setTimeout/clearTimeout as instance members and invoked them as this.setTimer/this.clearTimer. Native browser functions can reject the foreign receiver. The fix uses wrapper closures, consistent with NetworkProgramOutputTransport. Even an empty initial crawl called clearTimer, explaining why the defect can affect startup without a visible scheduled crawl; this remains an explanation to confirm with the real browser stack.

The server now stores effectiveCrawl independently while base is missing and emits no synthetic output. When raw Program is available, projection uses only the currently accepted base. Invalid overlay payload or failing scheduler reads do not prevent delivery of the base. Consumer exceptions are isolated from publisher acceptance. Public/OBS optional crawl-render failures clear only the crawl layer and do not escape into media promotion.

A focused concurrent run exposed a duplicate unchanged raw Program event around asynchronous scheduler readiness. The pass-through path now emits only when the raw envelope changes. A dedicated test covers this; final focused and full concurrent suites pass. No media test timeout was increased.

Server diagnostics use a bounded 100-entry, payload-free ScheduleDiagnostics ring: SCHEDULE_CRAWL_ACTIVE, EFFECTIVE_OVERLAY_CHANGED, PROGRAM_BASE_AVAILABLE/MISSING, PROGRAM_EFFECTIVE_MERGE, PROGRAM_EFFECTIVE_VALIDATION and PROGRAM_EFFECTIVE_PUBLISH. Existing browser RuntimeTrace records CONTROL_CRAWL_ACCEPT and PUBLIC/OBS_EFFECTIVE_ACCEPT/REJECT plus crawl-render-failed. Diagnostics are internal; no public debug endpoint, raw URL, secret or full snapshot is exposed. Validation failures are observable through absence of scheduled output and the fallback tests; no new operator-facing diagnostics are rendered.

## Persistence follow-up

ProgramOutputStore is in memory and has no durable Program envelope persistence. Existing studio state persistence is not equivalent to an authoritative playback timeline. This fix does not add disk retention or automatically restore media. Unattended recovery across Node restarts would require a separate design: publisher ownership/leases, expiration, source availability, seek/ended semantics, AutoLive recovery and handling elapsed wall time during downtime. Blindly restoring initialTime/startedAt could seek beyond media duration or revive an obsolete LIVE session. Control-closed operation during one server lifetime already works with a valid retained base.

## Files changed for this repair

- server/program-output/EffectiveProgramOutput.js
- public/js/studio/renderers/TextCrawlElement.js
- public/js/program-output/ControlCrawlObserver.js
- public/js/public/PublicProgramController.js
- test/programmable-crawl.test.js
- docs/BUILD-1003.4B-CRAWL-PROGRAM-OUTPUT-RUNTIME-AUDIT.md

Previous unstaged work retained. Staging empty; no commit/push. Excluded demo2.mp4 modification, untracked demo3.mp4, imm.jpg, test-audio.mp3, logo-test.svg and var/ retained. No .env, auth, schedule data, media files, AutoLive timing, handoff, HLS recovery, Program scheduling policy or service configuration change.

## Manual retest sequence

1. After authorized backend reload and client reload, open Control with a known valid Program. Confirm retained SSE has complete scene/source/playback, and Public and OBS both start.
2. Schedule a fresh short crawl. Confirm ACTIVE state during its actual interval; observe Control Program, Public and OBS. Preview must not change. Capture bounded trace only if failure recurs.
3. Keep Program playing through crawl start, edit and expiry. Verify no source replacement, seek, pause, TAKE or audio interruption.
4. Show manual crawl during scheduled activity; hide it to restore the scheduled winner. Confirm logo/lower third coexistence, ENTRY/LOSS suppression and BREAK visibility.
5. Close Control after a valid base exists; observe a later scheduled event on Public/OBS, including separate late joins.
6. In an explicitly authorized restart test, close Control, restart only Node, and verify no fabricated Program before a publisher returns. Reopen Control and verify a real base plus still-active crawl reaches Public and OBS. Do not issue a replacement Program merely to hide missing retained state.

Native browser diagnosis remains pending authorization/availability and is not marked as completed by these automated results.
