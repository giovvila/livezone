# Build 1003.4A3 — browser Scheduler migration audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4A3_BROWSER_SCHEDULER_MIGRATION_READY_FOR_MANUAL_RETEST

Baseline: build/1003.4 at e249fa040b3ff5a94f00dd7efdcc978cd656d8f3. A1/A2 work remains uncommitted. No stage, commit or push performed.

## Approved boundary

The existing editor schedules Program scenes/sources; A1/A2 accept overlay.crawl and overlay.sponsor. The user explicitly approved: “Migrare dati/editor e sospendere l’esecuzione Program pianificata fino al futuro backend server.” A3 therefore persists and edits the Program plan, with execution SUSPENDED. Program interval status is informational; ACTIVE does not mean a TAKE or broadcast overlay was issued. Overlay execution here means server resolution only, without rendering.

CURRENT_BROWSER_AUTHORITY_BEFORE: ScheduleStore persisted livezone.scheduler.schedule.v1 and synchronized storage events; ScheduleWorkspaceUI saved edits synchronously. Control instantiated SchedulerEngine, which resolved active items, scheduled deadlines and issued StudioProgramCommand actions. SchedulerRuntimeState separately persisted the enabled gate. ScheduleClock and ScheduleDayMetrics supply display/editor calculations.

SERVER_AUTHORITY_AFTER: A1 ScheduleStore owns durable revisions and serializes mutations. ScheduleAuthority owns time, overlay winners and deadlines. SchedulerServer projects interval statuses for the suspended Program plan. Client closure does not stop this owner. A2 single-process ownership and authentication limitations remain as documented in its audit.

READ_PATH: GET /api/studio/schedule supplies canonical schedule and runtime. Both Control and Scheduler use ServerScheduleStore. Initialization is asynchronous so server latency does not block Control setup. UI starts in loading/read-only state, then observes the fetched snapshot.

WRITE_PATH: Program editor create/edit/delete replace only programPlan through PUT /api/studio/schedule/program-plan. POST /api/studio/schedule/program-plan/import is the guarded migration operation. Both reuse the private auth/CSRF boundary, atomic store queue and If-Match. Existing overlay POST/PATCH/DELETE and enabled PATCH are exposed by ScheduleApiClient; no new overlay editor or renderer is introduced. Plan requests allow 512 KiB; overlay requests retain 64 KiB. Overlay mutations preserve programPlan and plan mutations preserve overlays.

SSE_PATH: GET /api/studio/schedule/events, native same-origin EventSource, retained schedule-state bootstrap. Revision changes trigger GET, effective-only updates replace runtime status. No healthy-SSE polling loop. Status includes revision, server clock, next deadline, overlay statuses and suspended Program interval IDs.

REVISION_ORDERING: minimum accepted schedule revision, ordered requests, lifecycle epoch, runtime generation and retired server-session IDs reject stale GET/SSE responses. A new server session resets the revision floor. Duplicate HTTP/SSE state is idempotent.

CONFLICT_UX: HTTP 412 produces SCHEDULE CHANGED — REFRESHED and a fresh GET. No automatic retry, field merge or overwrite. The banner retains bounded feedback.

EVENT_ADAPTER: ProgramScheduleAdapter is the single canonical Program plan adapter, shared with validation at the server boundary. The persisted schedule upgrades from {version:1,revision,events} to {version:2,revision,events,programPlan} on an explicit plan write. Existing version-1 files remain readable without boot rewrites. Program data does not masquerade as an overlay event and never enters the overlay winner resolver.

LEGACY_SCHEMA: version 1, timezone, items with id/title, sceneId or target kind/id, ABSOLUTE or AFTER_PREVIOUS, start, durationSeconds, behavior, resumePolicy and transition. Derived startMs/endMs remain computed fields rather than duplicated persistence. Existing schema validation, sequence and reference behavior are retained.

MIGRATION_MODEL: automatic one-time import only when server revision is zero, overlay events are empty and valid nonempty legacy Program data exists. Server checks the rule inside the revision-protected queue. Nonempty server wins without merging. A previously cleared/revised server requires review and cannot resurrect legacy data. Invalid legacy is visibly marked and preserved. A separate GET must verify imported content before the exact migration marker key is written. The original key is never deleted or rewritten; unrelated keys are not touched.

MIGRATION_RESULT: automated tests pass for import, verification failure, idempotence, reload, server precedence, malformed legacy and preservation. Actual operator-browser legacy data has not been imported during this implementation turn.

BROWSER_STORE_STATUS: old ScheduleStore COMPATIBILITY-ONLY, no active entry-point import. ServerScheduleStore ACTIVE as API client/observer; no local schedule persistence.

BROWSER_ENGINE_STATUS: SchedulerEngine COMPATIBILITY-ONLY in Control with programExecution:false. It receives an empty execution plan and cannot arm planned deadlines or issue planned Program commands. The existing enabled gate and external/empty-slot interruption context remain available to AutoLive. Standalone legacy engine behavior remains covered by its existing tests; active Control explicitly disables planned execution. The Control toggle now identifies AutoLive eligibility and Program suspension.

LOCAL_TIMER_STATUS: browser schedule execution timer DEPRECATED in active paths; display/calendar clocks VIEW-ONLY. Server timer ACTIVE. Existing AutoLive clocks are unchanged.

STORAGE_EVENT_STATUS: legacy schedule synchronization DEPRECATED in active entries; private SSE replaces it. SchedulerRuntimeState remains COMPATIBILITY-ONLY for the existing AutoLive eligibility setting, not an event execution authority.

MULTI_TAB_RESULT: automated two-client mutation/SSE convergence and stale-write conflict pass. Real two-tab interaction awaits manual retest.

SERVER_UNAVAILABLE_BEHAVIOR: explicit unavailable/degraded read-only state; last known server data remains visible. No legacy fallback execution or offline write queue. Initial failure leaves an empty non-authoritative editor until recovery.

SSE_RECONNECT_BEHAVIOR: EventSource reconnects; retained state restores truth and fetches a changed revision. No browser activation fallback. A replaced server session rejects old callbacks. Closing the client invalidates pending responses.

CONTROL_CONTINUITY: focused Program playback/navigation regressions and full suite pass. No retained Program/Preview reset was added. Control client teardown uses existing ENGINE_STOP; no pagehide teardown was added to Control.

BROADCAST_SIDE_EFFECTS: no new scheduled Program command, Preview mutation, AutoLive mutation or Program Output publication. No crawl/sponsor composition. Public/OBS and P0-C1B.2 remain outside A3 changes. The explicitly approved suspension of scheduled Program execution is the intentional behavioral change.

## Validation

TESTS_ADDED: 32 over the reported 884 baseline: 13 client tests, 15 migration/adapter/UI/compatibility tests and 4 additional server API tests. Existing A1/A2 tests additionally cover exact boundaries, closed-client activation, retained bootstrap, authentication and Program Output isolation.

FOCUSED_TEST_RESULT: 314/314 PASS across schedule-api-client, server-schedule-migration, server-schedule-api, server-schedule-core, schedule-workspace, scheduler, program-playback-continuity and program-output-network.

FULL_TEST_RESULT: node --test, 916/916 PASS, zero skipped/cancelled. An initial run detected a Control pagehide continuity guard; cleanup was moved to ENGINE_STOP and the full suite rerun successfully.

SYNTAX_RESULT: node --check PASS for all 15 A3 JavaScript files, including a fresh check after the Control teardown correction.

DIFF_CHECK_RESULT: git diff --check PASS; final audit and new text files checked separately for whitespace. Staging remains empty.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/entries/control-room-app.js
- public/js/entries/schedule-app.js
- public/js/scheduler/SchedulerEngine.js
- public/js/scheduler/ProgramScheduleAdapter.js (new)
- public/js/scheduler/ScheduleApiClient.js (new)
- public/js/scheduler/ServerScheduleStore.js (new)
- public/js/ui/ScheduleWorkspaceUI.js
- public/js/ui/StudioScheduleSummaryUI.js
- server/scheduler/ScheduleContract.js (extends existing uncommitted A1 work)
- server/scheduler/ScheduleStore.js (extends A1)
- server/scheduler/ScheduleRoutes.js (extends A2)
- server/scheduler/SchedulerServer.js (extends A2)
- test/schedule-api-client.test.js (new)
- test/server-schedule-migration.test.js (new)
- test/server-schedule-api.test.js (extends A2)
- docs/BUILD-1003.4A3-BROWSER-SCHEDULER-MIGRATION-AUDIT.md (new)

EXISTING_UNSTAGED_WORK_STATUS: retained. server/program-output-server.js contains the earlier A2 integration, not an A3 edit. Existing architecture/A1/A2 audit documents and remaining core files remain present.

PROTECTED_FILES_STATUS: no A3 edits to protected media, runtime files, .env, MediaMTX, AutoLive implementation, HLS, handoff, Public or OBS. The previously modified demo2.mp4 and excluded untracked media/var remain local. No cleanup, stash, stage, commit or push.

GIT_STATUS:
    M public/js/entries/control-room-app.js
    M public/js/entries/schedule-app.js
    M public/js/scheduler/SchedulerEngine.js
    M public/js/ui/ScheduleWorkspaceUI.js
    M public/js/ui/StudioScheduleSummaryUI.js
    M public/media/demo2.mp4
    M server/program-output-server.js
    ?? docs/BUILD-1003.4-PROGRAMMABLE-OVERLAYS-ARCHITECTURE.md
    ?? docs/BUILD-1003.4A-SERVER-SCHEDULER-AUTHORITY-ARCHITECTURE.md
    ?? docs/BUILD-1003.4A1-SERVER-SCHEDULER-CORE-AUDIT.md
    ?? docs/BUILD-1003.4A2-SCHEDULER-API-SSE-AUDIT.md
    ?? docs/BUILD-1003.4A3-BROWSER-SCHEDULER-MIGRATION-AUDIT.md
    ?? public/assets/logo/logo-test.svg
    ?? public/js/scheduler/ProgramScheduleAdapter.js
    ?? public/js/scheduler/ScheduleApiClient.js
    ?? public/js/scheduler/ServerScheduleStore.js
    ?? public/media/demo3.mp4
    ?? public/media/imm.jpg
    ?? public/media/test-audio.mp3
    ?? server/scheduler/
    ?? test/schedule-api-client.test.js
    ?? test/server-schedule-api.test.js
    ?? test/server-schedule-core.test.js
    ?? test/server-schedule-migration.test.js
    ?? var/

BLOCKERS: none for manual retest. Real-browser operation has not been validated in this turn. Scheduled Program execution remains intentionally unavailable pending its future server backend.

MANUAL_RETEST:
1. With a test operator profile and pristine server store, open Scheduler containing valid legacy data; verify import status, preserved original key and reload persistence. Repeat with existing server content and malformed legacy to verify precedence/preservation. Do not delete the real operator store for this test.
2. Open two Scheduler tabs; edit scene/source fields in A and observe B through SSE. Submit an already-open stale edit in B and confirm bounded conflict feedback without overwrite.
3. Stop/restart the test server; verify read-only state, preserved last snapshot and retained rehydration. Close Scheduler across an overlay deadline and reopen; server status must reflect current time without any broadcast overlay.
4. Navigate Control → Scheduler → Control while recorded heavy media is playing; verify Program cue/playback continuity and unchanged Preview. Verify AutoLive entry/loss/recovery separately and that its eligibility toggle still works.
5. Cross a Program plan interval boundary: status may change but no TAKE occurs; Public and OBS remain unchanged. Confirm the suspension banner and next-deadline display.

NEXT_STEP: MANUAL RETEST SERVER-AUTHORITATIVE SCHEDULER UI

LIVEZONE BUILD 1003.4A3 BROWSER SCHEDULER MIGRATION AUDIT COMPLETE
