# LIVEZONE BUILD 1003.4C — Sponsor runtime and Scheduler UX

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION = BUILD_1003_4C_SPONSOR_RUNTIME_SCHEDULER_UX_BLOCKED

Implementation and isolated end-to-end tests are complete. The remaining blocker
is reloading the obsolete production Node process, which requires a brief Program
Output interruption. Approval was requested; no production restart has been made.

## Production evidence and first divergence

Repository: `C:/Projects/livezone-broadcast-engine-x`; branch: `build/1003.4`.

- Port 8080 is owned by Node PID **16968**, started **2026-09-13 17:46:21 +02:00**.
- Its parent PID **23932** is the running **LivezoneNode** Windows service.
- Before this fix, `EffectiveProgramOutput.js` had last-write time **19:52:47**,
  and its repository wiring in `program-output-server.js` **19:54:20**, both after
  the process started. Node retains imported server modules; static UI files are
  read from disk. The new editor was therefore visible with an older backend.
- The real persisted enabled event is
  `overlay-6d28d142-5f1b-4689-9b7b-2a3966f53247`, title `test2`, priority **1**,
  interval **2026-09-13T21:06:13.000Z–21:06:43.000Z**. It is already expired at
  inspection time. The other real sponsor event, `testsponsor`, is disabled.
- Its asset is `asset-6e5a1973-ead1-4c27-994a-5a5ea73bedb0`, `sponsor1.png`,
  kind `image`, MIME `image/png`, **1,161,160 bytes**. The real file exists and
  the production URL returns **200 image/png**:
  `/media-library/files/image/6e5a1973-ead1-4c27-994a-5a5ea73bedb0.png`.
- Replaying the persisted schedule at **21:06:14Z** with the current production
  resolver and actual repository records selects that event as the ACTIVE winner.
  The effective output includes sponsor **enabled=true**, **top-right**, width
  **12%**, opacity **1**, no suppression, and retains the crawl and channel logo.
  This is a controlled replay, not a historical capture of the live process.
- The live retained SSE read after expiry contains the accepted Program and crawl,
  with no active sponsor. Production events and Program were not mutated to force
  a new test interval.

The first divergence for Control, Public and OBS is the **running server module
version**, before sponsor projection into the outbound Program Output. No evidence
supports changing the editor's event persistence or the three renderer paths.

## Report

| Field | Result |
| --- | --- |
| REAL_SPONSOR_FAILURE | Accepted as reported: editor saves Sponsor, but live outputs do not display it. |
| SPONSOR_EVENT_STATUS | Real event valid and enabled, now expired; controlled interval replay proves ACTIVE winner selection. |
| SPONSOR_ASSET_RESOLUTION | Real managed PNG exists and is HTTP accessible. Runtime references use the managed URL, never a filesystem path. |
| SERVER_EFFECTIVE_SPONSOR | Current code projects the real replayed event with original interval, position, size and opacity. |
| PROGRAM_OUTPUT_SPONSOR_STATE | Isolated real upload → schedule API → ACTIVE → retained SSE contains `overlays.sponsor` independently of crawl. |
| CONTROL_FIRST_DIVERGENCE | Stale backend projection. Current transport/observer creates `.scheduled-sponsor` with image URL, right/top 1.5%, width 12%, opacity 1, z-index 3. |
| PUBLIC_FIRST_DIVERGENCE | Same upstream stale process; current Public controller renders sponsor from retained SSE without media recreation. |
| OBS_FIRST_DIVERGENCE | Same upstream stale process; OBS mode follows the retained composite through its own tested controller instance. |
| ROOT_CAUSE | LivezoneNode was never reloaded after sponsor server projection/wiring changed. |
| FIX | Operational reload identified. Added isolated sponsor validation, file availability checking and bounded failure diagnostics; completed Scheduler UX and shared Gallery. |
| SPONSOR_CRAWL_CONCURRENCY | Independent layers and timers retained. Existing start/end, node/phase preservation, logo coexistence and no Program/Preview mutation regressions pass. |
| ENTRY_LOSS_BREAK_POLICY | Existing ENTRY/LOSS suppression, original deadlines during suppression, recovery and BREAK behavior retained; regressions pass. |
| SPONSOR_FAILURE_SAFETY | Missing asset, wrong kind, unsafe URL and missing physical file omit only Sponsor. Crawl, logo and Program remain. Diagnostic codes are state-change-only and bounded by the existing 100-entry buffer. |
| CONFIGURED_SOURCES_COLLAPSE | Explicit chevron button, aria-expanded/aria-controls, compact default, independent persisted preference; source nodes/data untouched. |
| LIVE_SOURCES_COLLAPSE | Same independent behavior; re-expansion preserves the existing form and values. |
| MEDIA_LIBRARY_PANEL | Collapsible Gallery in Scheduler with upload, filter, refresh, metadata, image thumbnails and USE AS SPONSOR. |
| MEDIA_LIBRARY_SHARED_MODEL | The same MediaLibraryManager/Client and server repository are used by Control and Scheduler. No new asset store. |
| UPLOAD_REUSE | Existing MediaLibraryUI upload → MediaLibraryClient XHR → `/api/media-library/assets`; same validation and stable assetId. BroadcastChannel refreshes the other open workspace after upload; focus/explicit refresh covers missed notifications. |
| SPONSOR_PICKER | Existing picker and editor preview preserved. Gallery selection calls the same editor, stores assetId and preserves an existing Sponsor draft. |
| TESTS_ADDED | 10 new runtime/workspace tests plus 1 Gallery-to-Sponsor editor regression. |
| FOCUSED_TEST_RESULT | 305 passed, 0 failed. |
| FULL_TEST_RESULT | `node --test`: 1053 passed, 0 failed, 0 skipped. |
| SYNTAX_RESULT | `node --check`: all 7 changed/new JS files pass. |
| DIFF_CHECK_RESULT | `git diff --check`: exit 0; only Git LF/CRLF conversion notices. |
| BLOCKERS | Approval to reload LivezoneNode; live Control/Public/OBS visual verification after restart. |
| MANUAL_RETEST | After approved Node-only restart, reauthenticate if needed, restore/confirm Program, create a future interval with crawl + sponsor, verify all outputs and Gallery sharing. |
| NEXT_STEP | MANUAL RETEST SPONSOR + CRAWL + SCHEDULER MEDIA LIBRARY |

## Test fidelity

The new runtime tests use the real MediaAssetRepository, actual uploaded files,
existing MediaLibraryClient XMLHttpRequest upload, authenticated HTTP APIs, the
server resolver/merger, retained SSE, NetworkProgramOutputTransport,
ControlCrawlObserver/StudioGraphicsLayer and both Public/OBS controller modes.
jsdom provides the actual production HTML/form/DOM. At the test transport boundary,
the browser Origin header omitted by jsdom is supplied; production auth is unchanged.

PNG bytes include an alpha-capable image. WebP/JPEG tests exercise the existing
signature and byte-preservation contract; they do not assert visual image decoding.
No live browser or OBS screenshot verification was performed. The production backend
must not be described as updated merely because isolated tests pass.

## Files changed for this fix

- `server/program-output/EffectiveProgramOutput.js`
- `public/control/schedule/index.html`
- `public/css/schedule-workspace.css`
- `public/js/entries/schedule-app.js`
- `public/js/ui/ScheduleWorkspacePanels.js`
- `public/js/ui/MediaLibraryUI.js`
- `public/js/ui/ScheduleOverlayEditorUI.js`
- `test/sponsor-runtime-workspace.test.js`
- `test/schedule-overlay-editor.test.js`
- This audit document.

Evidence logs are in `var/1003-4c-sponsor-ux-focused.log`,
`var/1003-4c-sponsor-ux-full.log` and `var/1003-4c-sponsor-ux-diff.log`.

No stage, commit or push. Existing unstaged work and excluded files preserved.
No changes to auth, `.env`, MediaMTX, scheduler authority semantics, Program
execution suspension, AutoLive, handoff or media recovery.

LIVEZONE BUILD 1003.4C SPONSOR RUNTIME AND SCHEDULER UX AUDIT COMPLETE
