# Build 1003.4B — Server-authoritative programmable text crawl

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

## Decision and validation

| Field | Result |
|---|---|
| DECISION | BUILD_1003_4B_PROGRAMMABLE_CRAWL_READY_FOR_MANUAL_RETEST |
| BASELINE | Accepted 939/939; prior manually validated VIDEO/AUDIO navigation continuity retained |
| EXISTING_CRAWL_REUSE | Shared TextCrawlElement reuses existing crawl DOM, CSS classes, directions, speeds and backgrounds |
| SCHEDULE_EVENT_MODEL | overlay.crawl; optional name, enabled, UTC start/end, priority, text, position, direction, speed, background; interval [start,end) |
| SCHEDULER_UI | Existing Scheduler page and authenticated ScheduleApiClient; create, edit, enable/disable, delete; device-local date inputs converted to UTC |
| SERVER_EFFECTIVE_CRAWL_STATE | Existing hydrated scheduler runtime determines the winning event; no browser activation timer |
| MANUAL_SCHEDULED_PRECEDENCE | Visible manual crawl wins; hiding manual restores the still-active scheduled winner |
| COLLISION_PRIORITY | Existing resolver: higher priority, then later start, then deterministic ID ordering |
| PROGRAM_OUTPUT_MERGE_MODEL | EffectiveProgramOutput is the sole outward merge owner; raw publisher store remains unchanged |
| REVISION_MODEL | Raw publisher session/revision retained; additive snapshot.output version 1 contains independent server session/revision, overlayOnly and fresh serverTime; forged publisher output/scheduled metadata rejected |
| CONTROL_CLOSED_RESULT | Automated HTTP/SSE start/end verification passes without Control or Scheduler clients |
| CONTROL_RECONNECT_RESULT | Retained composite and read-only Control crawl observer tested; no manual graphics republish |
| CRAWL_PHASE_MODEL | CSS negative delay derived from server-calibrated time minus event start; existing 24/16/9 second durations; stable node for unchanged crawl |
| ENTRY_POLICY | Scheduled crawl visually suppressed; event continues |
| LOSS_POLICY | Scheduled crawl visually suppressed; recovery restores current eligible crawl |
| BREAK_POLICY | Scheduled crawl remains visible |
| AUTOLIVE_REGRESSION | Focused AutoLive tests pass; timing/state machine unchanged |
| PUBLIC_MODEL | Same Program Output SSE, server revision gate, shared crawl view; overlay updates do not recreate or seek active media |
| OBS_MODEL | Same PublicProgramController and SSE projection as Public |
| CHANNEL_LOGO_COEXISTENCE | Existing image graphics preserved; scheduled band reserves top/bottom space |
| LOWER_THIRD_REGRESSION | Existing graphics preserved; lower graphics inset above bottom scheduled band |
| TEXT_SAFETY | Text rendered through textContent; existing validated lengths and enum values; no injected markup |
| PERFORMANCE_MODEL | Logical state publications only; no frame/pixel broadcasts; unchanged winner/content does not increment composite revision; local timer only expires visuals |
| PROGRAM_MUTATION_COUNT | 0 from crawl activation/edit/end; verified raw scene/source/playback preservation |
| PREVIEW_MUTATION_COUNT | 0 from crawl path; observer targets only Program graphics |
| TESTS_ADDED | 49 in programmable-crawl.test.js |
| FOCUSED_TEST_RESULT | 417/417 PASS |
| FULL_TEST_RESULT | 988/988 PASS; node --test --test-reporter=dot, exit 0 |
| SYNTAX_RESULT | 18 changed JavaScript files PASS |
| DIFF_CHECK_RESULT | git diff --check PASS; only Git line-ending notices |
| EXISTING_UNSTAGED_WORK_STATUS | Earlier A1/A2/A3 work preserved; no stage, commit or push |
| PROTECTED_FILES_STATUS | Excluded media/runtime paths untouched by this implementation |
| GIT_STATUS | build/1003.4; staging empty; existing and B changes remain unstaged/untracked |
| BLOCKERS | No implementation/test blocker; production browser retest pending loading this backend and client code |
| MANUAL_RETEST | A–G below; not represented as completed real-browser validation |
| NEXT_STEP | MANUAL RETEST SERVER-AUTHORITATIVE PROGRAMMABLE TEXT CRAWL |

## Operational boundaries

The running Node service was not restarted during this task. Load the current backend through an operator-authorized LivezoneNode-only restart before real-browser testing, and reload the client pages once to load the new modules. No restart of MediaMTX, OBS or other services is part of this implementation.

The Program Output envelope remains version 1 with additive server output metadata. Publisher acknowledgements and publisher stale-write checks retain their existing sequence. Updated consumers use the independent server revision, so a scheduled overlay update with an unchanged publisher revision is accepted. A late join receives fresh server time without creating a new output revision. Phase calibration includes transport latency and uses each viewport's existing CSS geometry; it does not promise identical pixel coordinates across differently sized displays.

Scheduled state survives restart through the existing schedule store. Raw Program Output retains its existing in-memory lifetime. If no publisher snapshot exists after restart, the server exposes an explicitly empty overlay-only composite, with no scene/source. It does not invent or restore Program media authority. Control identity bootstrap ignores this empty overlay-only state. Manual precedence uses the last accepted publisher snapshot; existing local manual persistence resumes through the normal Control path when it opens.

Program scheduling remains suspended. No AutoLive acquisition, loss timing, media handoff, Program cue, Preview state, media recovery routine, authentication model or Control Desk layout change is introduced. Existing schedule authentication and conflict handling are reused; a revision conflict does not silently overwrite server data.

## Files changed for this fix

New files:

- server/program-output/EffectiveProgramOutput.js
- public/js/program-output/OutputRevisionGate.js
- public/js/program-output/ControlCrawlObserver.js
- public/js/studio/renderers/TextCrawlElement.js
- public/js/ui/CrawlScheduleUI.js
- test/programmable-crawl.test.js
- docs/BUILD-1003.4B-PROGRAMMABLE-CRAWL-AUDIT.md

Changes to existing files, including files already modified by earlier builds:

- server/program-output/ProgramOutputStore.js
- server/program-output-server.js
- server/scheduler/ScheduleContract.js
- server/scheduler/ScheduleStore.js
- public/js/program-output/ProgramOutputContract.js
- public/js/program-output/NetworkProgramOutputTransport.js
- public/js/studio/renderers/StudioGraphicsLayer.js
- public/js/public/PublicProgramController.js
- public/js/ui/ScheduleWorkspaceUI.js
- public/js/entries/control-room-app.js
- public/js/entries/schedule-app.js
- public/control/schedule/index.html
- public/css/public-viewer.css
- public/css/studio-renderer.css
- public/css/schedule-workspace.css
- test/server-schedule-migration.test.js

Other dirty files, including ProgramOutputManager, SchedulerEngine, ProgramPlaybackContinuity, StudioRenderer and earlier audit documents, contain preceding work and are not attributed to B.

Excluded local status remains:

```text
 M public/media/demo2.mp4
?? public/assets/logo/logo-test.svg
?? public/media/demo3.mp4
?? public/media/imm.jpg
?? public/media/test-audio.mp3
?? var/
```

## Manual browser retest

Prerequisite: load current server/client code as described above. Use a short future event and an end a few minutes later. Record Program identity, playback cue, Preview and manual crawl state before each case. Do not use an operational broadcast for disruptive navigation or AutoLive loss simulation.

| Test | Action | Expected |
|---|---|---|
| A | Schedule crawl with Control open; let start/end pass | Crawl appears and expires; Program media and Preview unchanged; no TAKE or seek |
| B | Save future crawl, then close Control and Scheduler before start | Existing Public/OBS receives activation and expiry from server |
| C | Keep Public and OBS open through start, text edit and end | Both show same text/options and timely lifecycle; no media recreation, audio interruption or repeated animation reset |
| D | Open Public/OBS after start; reconnect Control during active event | Current crawl appears with elapsed phase, without new activation or Program reset; opening after end shows none |
| E | Observe scheduled crawl through AutoLive ENTRY and LOSS on a test source | Scheduled visual hides while slate active; event timing continues; recovery restores only if still eligible |
| F | Use BREAK during active crawl | Crawl stays visible using existing broadcast graphics; no new ownership session from crawl |
| G | Show manual crawl while scheduled event active, then hide it | Manual wins; hide restores scheduled event at current elapsed phase; if scheduled event ended, nothing is restored |

Also inspect top/bottom, rtl/ltr, all three speeds, background off/on, logo and lower-third coexistence at actual output resolution. Verify literal markup-like text is displayed as text. Test priority collision/fallback, disable/delete, invalid dates and concurrent editor revision conflict. Re-run VIDEO and AUDIO + motion Control → Scheduler → Control continuity manually on the loaded build.

Automated tests additionally cover hydrated active events after restart, exact boundaries, stale revisions, forged server metadata, expiry callbacks, device clock skew, empty overlay-only bootstrap, and media activation reuse. Real-browser visual and operational service checks remain manual.
