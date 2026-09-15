# LIVEZONE BUILD 1003.4C — Scheduler overlay editor audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION = BUILD_1003_4C_SCHEDULER_OVERLAY_EDITOR_READY_FOR_MANUAL_RETEST

Repository: `C:/Projects/livezone-broadcast-engine-x`; branch: `build/1003.4`.

| Report field | Result |
| --- | --- |
| REAL_UI_FAILURE_BEFORE | Production EDITOR ELEMENTO exposed only Program content. Crawl had a separate form; Sponsor creation was absent. |
| EVENT_TYPE_SELECTOR | Production HTML now exposes TIPO ELEMENTO: PROGRAMMA (default), TEXT CRAWL, SPONSOR. |
| PROGRAM_EDITOR | Existing fields, validator, Program plan persistence and edit/delete path retained. No new Program schema or execution behavior. The existing Program schema has no per-item enabled flag; no unsupported toggle was invented. |
| CRAWL_EDITOR | Title, text, date, start time, duration in seconds, enabled, top/bottom, RTL/LTR, slow/normal/fast, priority and existing background option. |
| SPONSOR_EDITOR | Title, managed image picker, date/time/duration, enabled, four corners, size 5–30%, opacity 0–100%, priority. |
| MEDIA_LIBRARY_INTEGRATION | Existing MediaLibraryPickerUI reused with managed-image filtering. PNG and WebP transparency preserved by the image thumbnail, without an added background. JPEG is already signature-validated by the existing library and is accepted. Stores assetId, never operator-entered paths or URLs. |
| EVENT_ADAPTER | ScheduleEventEditorAdapter centralizes mode/type mapping, labels, supported-image validation, overlay payload whitelists and edit hydration. Local schedule timezone converts to canonical UTC timestamps. Program continues through its existing adapter and validator. |
| TIMELINE_COEXISTENCE | Program, crawl and sponsor appear together in the selected day's chronological list; TYPE identifies each. Coverage metrics and Program timeline segments remain based only on Program items. |
| OVERLAY_OVERLAP | Crawl and multiple sponsor events can share an interval. Existing server priority selection remains unchanged; no rotation introduced. |
| CHANNEL_LOGO_SEPARATION | Sponsor editor is independent of Channel Logo controls and semantics. |
| VALIDATION_MODEL | Bounded title/text, timing, priority, enums, valid managed image, size and opacity. Errors appear in the existing feedback area. Native form validity excludes disabled inactive fieldsets. |
| EDIT_EXISTING_EVENT | List EDIT selects the correct mode and hydrates title, enabled, timing, payload, priority and sponsor thumbnail. |
| MODE_SWITCH_SAFETY | Switching type resets editing identity and incompatible fields, clears hidden assetId explicitly and invalidates pending picker/duration work. Only the selected type's whitelisted payload is saved. |
| SERVER_DEGRADED_REGRESSION | Offline/degraded state disables editor fieldsets, selector, textarea and actions. Reconnect restores the selected mode. Revision conflicts refresh state without retrying the mutation or discarding the draft. |
| PROGRAM_EXECUTION_SUSPENDED_STATUS | PROGRAM EXECUTION SUSPENDED remains visible. Program events are not automatically executed; overlays keep the existing server runtime. |
| TEST_FIDELITY_GAP | New tests load production HTML and CSS into jsdom, start the actual workspace, click actual controls, use native FormData and an isolated real HTTP Scheduler server. No connected browser was available; visual layout, actual PNG decoding/transparency and live OBS acceptance remain manual. |
| TESTS_ADDED | 23 production-DOM/API integration cases. Includes the actual submit/list event bindings, picker selection, mode visibility, CRUD, toggles, validation, overlap/coverage, conflict, degraded/reconnect, timezone, formats and stale picker completion. |
| FOCUSED_TEST_RESULT | 193 passed, 0 failed. Scheduler overlay editor, Scheduler workspace, API client, programmable crawl/sponsor and Media Library. |
| FULL_TEST_RESULT | `node --test`: 1042 passed, 0 failed, 0 skipped. Includes AutoLive, crawl/sponsor concurrency, Public/OBS and Control continuity regressions. |
| SYNTAX_RESULT | `node --check` passed for the four changed/new application JS modules and the new test file. |
| DIFF_CHECK_RESULT | `git diff --check` passed; Git emitted only existing LF/CRLF conversion notices. |
| BLOCKERS | No implementation blocker. Live visual verification is pending manual retest. |
| MANUAL_RETEST | Reload Scheduler; verify PROGRAMMA defaults and existing fields. Select TEXT CRAWL and save an event. Select SPONSOR, choose a transparent PNG/WebP from Media Library, select TOP_RIGHT and save the same interval. Confirm both list types, edit hydration, enable/disable and delete. With the accepted backend loaded, check Program + Channel Logo + crawl + sponsor on Control/Public/OBS. |
| NEXT_STEP | MANUAL RETEST PROGRAMMA / TEXT CRAWL / SPONSOR EDITOR |

## Files changed for this fix

- `public/control/schedule/index.html`: integrated selector and mode-specific fields; removed the separate crawl form.
- `public/css/schedule-workspace.css`: mode fields, thumbnail, overlay row actions and existing picker styling.
- `public/js/entries/schedule-app.js`: removed the separate crawl editor startup.
- `public/js/ui/ScheduleWorkspaceUI.js`: integrates overlay editor and same-day rows while preserving Program coverage and persistence.
- `public/js/ui/ScheduleOverlayEditorUI.js`: overlay editor and picker lifecycle.
- `public/js/scheduler/ScheduleEventEditorAdapter.js`: explicit type normalization and hydration.
- `test/schedule-overlay-editor.test.js`: production HTML/CSS and real Scheduler HTTP integration tests.
- `package.json`, `package-lock.json`: jsdom development-only test dependency.
- This audit file.

Runtime, server authority, output merger, AutoLive, handoff/recovery, MediaMTX, auth
and `.env` were not changed for this fix. Prior unstaged work and local files were
preserved. No stage, commit or push was performed.

Evidence logs: `var/1003-4c-focused-test.log`, `var/1003-4c-full-test.log`,
`var/1003-4c-diff-check.log`.

LIVEZONE BUILD 1003.4C SCHEDULER OVERLAY EDITOR AUDIT COMPLETE
