# Build 1003.4A3 — real runtime Scheduler connectivity

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4A3_REAL_BROWSER_SCHEDULER_BLOCKED

REAL_BROWSER_FAILURE: reported SERVER DEGRADED, REV — and disabled editor. Reproduced the underlying HTTP failure at http://127.0.0.1:8080, independently of browser authentication.

DEGRADED_TRIGGER: initial GET returns 404 and leaves schedule null. Native EventSource then fails on the same absent route; its error handler previously replaced the initial unavailable state with generic degraded. The original failure was lost.

SERVER_AUTHORITY_STARTED: not in the current port-8080 process. Listener PID 17652, started 2026-09-09 09:37:53 Europe/Rome, is Node launched by LivezoneNode service PID 4672 with this repository's server/program-output-server.js and .env. The server integration file was modified 2026-09-12 02:23:11; SchedulerServer was modified 2026-09-12 21:11:15. The live process predates the new route/owner code. Node module imports are retained in memory while static browser files are read from disk.

PERSISTENCE_STATUS: configured path C:/Projects/livezone-broadcast-engine-x/var/scheduler/schedule.json is absent. Nearest existing ancestor var passes read/write access checks. Missing storage initializes empty revision 0 without a write; the first explicit mutation creates its parent and writes atomically. No production schedule or excluded runtime data was written. Actual mkdir/write/read/restart hydration is verified in an isolated Windows temporary directory by the production-entrypoint test. This does not establish service-account write permission by performing an operator-store write.

API_ROUTE: GET /api/studio/schedule; GET /api/studio/schedule/status; POST /api/studio/schedule/events; PATCH/DELETE /api/studio/schedule/events/:id; PUT /api/studio/schedule/program-plan; POST /api/studio/schedule/program-plan/import.

API_REAL_HTTP_RESULT: running port 8080 GET /api/studio/schedule returns 404, application/json; charset=utf-8, safe body {"ok":false,"error":"not-found"}. Fresh executable process on an isolated loopback port returns authenticated GET 200 and revision 0, then revision 1 after a durable plan save.

API_AUTH_RESULT: running /api/operator/session returns 200 and authenticated:false for the unauthenticated probe. The missing schedule route returns 404 instead of the 401 that the current route guard returns. Thus the FIRST divergence is route absence before Scheduler authorization. Fresh executable-process tests require a real login/session and CSRF for writes; anonymous GET/SSE are 401.

SSE_ROUTE: GET /api/studio/schedule/events.

SSE_BROWSER_AUTH_MODEL: same-origin HttpOnly operator-session cookie, automatically carried by native EventSource. No Authorization header is required; no credential query parameter. Reads use OperatorRequestGuard.authorize. Writes additionally require origin, operator-request marker and CSRF through existing operatorFetch. Neither server authorization nor credential configuration changed.

SSE_REAL_CONNECTION_RESULT: running port 8080 returns 404 application/json with the same not-found body. Fresh executable-process cookie-only HTTP stream returns 200 text/event-stream and retained schedule-state. No connected browser was available through the Browser skill; native-browser visual verification remains unperformed.

CLIENT_BASE_URL: root-relative /api/studio/schedule and /api/studio/schedule/events resolve from /control/schedule/ to http://127.0.0.1:8080/api/studio/schedule and its /events sibling. No wrong prefix, relative directory, port or token URL was found.

CLIENT_BOOT_TRACE: DOM/client -> existing operator session -> GET -> failure leaves null schedule -> SSE request -> stream error -> unavailable/read-only. With a freshly started executable: login/session -> GET revision 0 -> accepted canonical snapshot -> retained SSE -> online/writable -> plan save revision 1 -> process restart -> disk hydration revision 1.

EDITOR_DISABLED_REASON: ScheduleWorkspaceUI explicitly sets form button/input/select disabled when ServerScheduleStore.writable is false. The client requires online connection and a current accepted revision. Null schedule from the 404 cannot meet that condition. No overlay or pointer-events workaround is needed; the read-only contract remains enforced.

FIRST_DIVERGENCE: LivezoneNode was not restarted after the A2/A3 server modules changed. Fresh browser JavaScript was served by the old HTTP process.

TEST_FIDELITY_GAP: existing tests instantiate the current factory or fake client responses, so they cannot detect a separately installed service still running old imports. The new test spawns the actual CLI entrypoint with normal environment configuration, performs real login/CSRF/HTTP streaming and verifies persisted reload. Its Node cookie bridge simulates the browser cookie jar; it does not fabricate API responses and does not constitute native-browser UI automation. Deployment/service freshness still requires checking the running port.

ROOT_CAUSE: stale long-running Node service plus loss of the initial HTTP failure in client status projection. Authentication and persistence were not the first failing boundary.

FIX: preserve bounded initial failure reason across SSE errors; distinguish missing API, auth requirement, HTTP/server failure, invalid response, network failure and SSE loss. Show an allowlisted operator-facing reason in the existing status banner. Retained reconnect clears the reason and restores writes after valid snapshot hydration. No local scheduling fallback, auth weakening, automatic service restart or editor unlock was added. Operational fix required: restart only LivezoneNode after operator approval, then log in/reload if its in-memory session was lost.

TESTS_ADDED: 3: initial 404 survives SSE error; reconnect after API becomes available clears failure and restores writes; actual executable startup/login/cookie SSE/CSRF save/atomic persistence/restart hydration.

FOCUSED_TEST_RESULT: 180/180 PASS, including production startup, client, migration, API/SSE, schedule core, workspace and operator auth.

FULL_TEST_RESULT: node --test 919/919 PASS, no skipped/cancelled tests.

SYNTAX_RESULT: node --check PASS for the five changed JavaScript files.

DIFF_CHECK_RESULT: git diff --check PASS. No staging, commit or push.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/scheduler/ScheduleApiClient.js
- public/js/scheduler/ServerScheduleStore.js
- public/js/ui/ScheduleWorkspaceUI.js
- test/schedule-api-client.test.js
- test/scheduler-production-startup.test.js (new)
- docs/BUILD-1003.4A3-REAL-BROWSER-SCHEDULER-AUDIT.md (new)

Existing A1/A2/A3 work, excluded media and var remain preserved. No changes to AutoLive, handoff, heavy-media TAKE, Public/OBS, Control Desk, Program Output protocol, MediaMTX, .env or P0-C1B.2.

BLOCKERS: LivezoneNode restart approval is pending because restart interrupts active broadcast connections and may require operator reauthentication. The old process was not stopped. No connected browser is available for visual verification. Do not interpret passing isolated tests as proof that port 8080 has been updated.

MANUAL_RETEST: after approved Node-only restart, reauthenticate on the existing same origin and reload Scheduler. Confirm GET 200 JSON, SSE 200 text/event-stream, SERVER ONLINE, numeric REV and valid NEXT or —. Type a title, select scene/source, set date/time and save; confirm revision increase and reload persistence. Program execution must remain suspended and no scheduled broadcast action should occur. Leave MediaMTX and all excluded files untouched.

NEXT_STEP: MANUAL RETEST SERVER ONLINE + EVENT EDITOR USABLE

LIVEZONE BUILD 1003.4A3 REAL BROWSER SCHEDULER AUDIT COMPLETE
