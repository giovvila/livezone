# Build 1003.4A2 — server scheduler API and private SSE audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4A2_SCHEDULER_API_SSE_READY_FOR_REVIEW

BASELINE: build/1003.4 at e249fa040b3ff5a94f00dd7efdcc978cd656d8f3, accepted A1 847/847. A2 is API/runtime integration only, not browser migration or broadcast composition.

SERVER_RUNTIME_OWNER: createProgramOutputServer constructs one SchedulerServer once, outside request handlers. It constructs one A1 store and one authority, hydrates and starts independently of connected clients. Requests await its ready promise. A process-local registry rejects a second active owner of the same resolved path (case-folded on Windows); it does not start a second timer or permit writes. Registry ownership is released only after startup completion and accepted mutations drain. This is the single-Node-process deployment model, not a cross-process/shared-filesystem lock; do not run multiple service processes against one schedule path.

PERSISTENCE_OWNER: SchedulerServer owns the single ScheduleStore for the new server event domain. All route mutations invoke that instance; no handler performs filesystem writes. Default private path is var/scheduler/schedule.json, configurable by constructor schedulePath or LIVEZONE_SCHEDULE_PATH. Public-root paths and aliasing the Studio state path are rejected. No environment file was edited. The existing Studio state's legacy scheduler domain and browser localStorage remain compatibility data; there is no dual-write bridge or migration. The new server event domain has one durable owner rather than being mirrored into those stores. Missing storage hydrates empty in memory without creating a file until a successful mutation.

API_ROUTES:
- GET /api/studio/schedule: full validated schedule plus runtime summary, ETag.
- GET /api/studio/schedule/status: runtime summary without event payloads.
- POST /api/studio/schedule/events: create event.
- PATCH /api/studio/schedule/events/:id: update; enabled true/false uses this same route.
- DELETE /api/studio/schedule/events/:id: delete.
- GET /api/studio/schedule/events: private retained SSE.

READ_SNAPSHOT_MODEL: `{ok:true,schedule:{version,revision,events},runtime:{version,sessionId,generation,status,scheduleRevision,serverTime,evaluatedAt,nextDeadline,activeEvents:[{id,type}]}}`. Status-only and SSE omit the full schedule. Reads reconcile at the injected current server time, so late connections do not wait for the next timer. No internal path is returned.

MUTATION_MODEL: JSON writes use A1 validation/normalization; routes do not implement another event validator. Persistence precedes reconciliation and notification. Unsupported methods return 405; body limit is 64 KiB (413), malformed JSON 400, wrong content type 415, invalid event/patch 422, duplicate ID 409, missing event 404. Error bodies contain bounded codes, not raw exceptions or payloads. Success returns persisted schedule/runtime and ETag, 201 for create and 200 for patch/delete.

REVISION_CONFLICT_MODEL: If-Match: "schedule-N" is required for every mutation. Missing/malformed precondition returns 428 REVISION_REQUIRED. A1 checks the expected revision within its serialized mutation queue. Stale writes return 412 with REVISION_CONFLICT and current revision; clients re-read and explicitly retry. Successful mutations increment schedule revision; failed persistence and rejected writes do not. No per-event edit revision is introduced.

AUTH_MODEL: All private schedule reads/status/SSE use existing OperatorRequestGuard.authorize. POST/PUT/PATCH/DELETE use authorizeMutation, preserving session, origin, operator request header and CSRF checks. GET never mutates events. Anonymous Public/OBS requests and bearer-only Program publishers cannot edit schedules. No global auth redesign, CORS wildcard or token disclosure. Existing explicitly configured development auth bypass retains its existing semantics. Private SSE follows the existing authenticated-at-connection model; session expiration/revocation of an already-open stream is not newly enforced by this increment.

PRIVATE_SSE_MODEL: event name schedule-state; event ID is server-instance UUID plus generation. Contains the payload-free runtime summary above. Stream is distinct from public Program Output SSE. Keepalive comments every 15 seconds are transport liveness, not logical state publications. Client callbacks, timers and connections clean up on abort/close/error. Backpressured streams are disconnected rather than retaining an unbounded logical-event queue.

RETAINED_STATE_MODEL: Owner retains a meaningful-state fingerprint of availability, schedule revision, effective winning content and next deadline. Generation advances only when that state changes. ScheduleAuthority adds a separate evaluation subscription so the owner can observe updated boundaries even if the winners do not change, while A1 effective-state subscriptions keep their original behavior. Server timestamp and evaluatedAt are sampled for current reads/bootstrap, not used to trigger periodic publications.

SSE_CHANGE_FILTERING: Unchanged one-second reconciliation generates no owner notification/SSE state message and no generation increase. Future event edits still publish schedule revision changes; active payload edits cause a new effective generation without exposing payload contents on SSE. Clients fetch the authenticated full schedule when needed.

LATE_SUBSCRIBER: Immediate current snapshot after reconciliation. Tested active event at 20:00:05 without waiting for a boundary.
RECONNECT_MODEL: Always bootstrap latest complete summary; historical delivery is not required and Last-Event-ID is not treated as an event replay request. Restart creates a fresh sessionId so generation resets cannot be mistaken for old events.
CONTROL_ABSENT_RESULT: PASS. Tests use HTTP clients/fake clock with no browser Control instance; exact starts and ends change runtime and private SSE.
SCHEDULER_ABSENT_RESULT: PASS. No browser editor/runtime exists in the integration harness; server clock alone drives activation.
RESTART_RESULT: PASS. Complete HTTP server shutdown/recreation hydrates revision/events, reconstructs active/expired state and serves retained SSE without observing historical timers.
CORRUPTION_RESULT: PASS. Corrupt/unsupported storage remains unchanged; schedule reads/writes/SSE return 503 SCHEDULE_UNAVAILABLE, no deadline timer is armed, health/public server remains available. Runtime initialization exceptions stop scheduling and set unavailable. Readiness of unrelated Program Output is not made dependent on schedule availability; private status access is the explicit scheduler availability check. Runtime persistence failures return 503 without advancing revision or changing the last validated state.

PROGRAM_OUTPUT_REGRESSION: Existing publisher authorization, POST /api/program-output, retained public SSE and network/Studio-state/auth tests pass. New integration test publishes an existing valid envelope, activates a scheduled event and asserts the same retained Program Output object remains unchanged; public SSE still contains the program event and no private schedule payload.
BROADCAST_SIDE_EFFECTS: None. No Program, Preview, AutoLive, overlay renderer, Public/OBS or browser Scheduler changes. Server authority knows effective events but does not broadcast them. P0-C1B.2 contracts/repository and existing auth modules remain untouched.

DIAGNOSTICS: Existing bounded ScheduleDiagnostics now also records scheduler-server-start/stop, api-read, api-mutation, api-conflict, sse-connect/disconnect and retained-state-update. No payload text, asset URLs, request body or secrets. No new diagnostic exports/log files are written by A2.

Lifecycle: server.close closes private SSE first, stops/destroys authority and unsubscribes listeners, drains accepted store mutations, then completes the supplied HTTP close callback. Existing close hook also calls idempotent cleanup. Closing during hydration is guarded by A1 generation checks. No process-global signal handler is added by a server factory and no browser teardown affects runtime ownership. A service termination that bypasses graceful HTTP close still relies on A1 atomic persistence for restart.

TESTS_ADDED: 37 tests in test/server-schedule-api.test.js cover owner/timer count, hydrate once, GET/status, CRUD/enable, revisions, malformed input, duplicate ID, method safety, two editors, exact start/end with no browsers, private bootstrap/mutation/activation/expiration, late join/reconnect, unchanged reconciliation filtering, active creation/edit/delete, full restart active/expired, corruption/unsupported schema, private read/SSE auth, Public/OBS/publisher mutation denial, CSRF/origin/header enforcement, shutdown with live SSE, Program Output isolation/regression, duplicate owner, protected path alias, persistence failure and body limits. These complement the 44 A1 tests; no real-minute sleeps. Tests isolate media-library startup because this suite exercises schedule lifecycle rather than unrelated asynchronous asset initialization.

FOCUSED_TEST_RESULT: node --test test/server-schedule-api.test.js test/server-schedule-core.test.js test/program-output-network.test.js test/operator-auth.test.js test/authoritative-state.test.js — 197/197 PASS.
FULL_TEST_RESULT: node --test — 884/884 PASS, zero failed/skipped/cancelled.
SYNTAX_RESULT: all five changed/new JavaScript files passed node --check.
DIFF_CHECK_RESULT: git diff --check passed; new-file whitespace/conflict marker checks passed separately.

FILES_CHANGED_FOR_THIS_FIX:
- server/program-output-server.js
- server/scheduler/ScheduleAuthority.js (existing unstaged A1 implementation extended)
- server/scheduler/SchedulerServer.js (new)
- server/scheduler/ScheduleRoutes.js (new)
- test/server-schedule-api.test.js (new)
- docs/BUILD-1003.4A2-SCHEDULER-API-SSE-AUDIT.md (new)

EXISTING_UNSTAGED_WORK_STATUS: A1 files and earlier architecture/audit documents preserved. Intentional excluded media/artwork and var remain local/uncommitted; no cleanup or staging. The full existing test suite was executed as requested. No source asset or operator configuration was edited.
PROTECTED_FILES_STATUS: AutoLive timing/recovery, Preview handoff, heavy-media TAKE, browser Scheduler, Control Desk, Program Output contract, Public/OBS, MediaMTX, auth modules and .env unchanged.
GIT_STATUS: build/1003.4 at e249fa040b3ff5a94f00dd7efdcc978cd656d8f3. Staging empty; server entrypoint and new A1/A2 files remain reviewable in the worktree alongside excluded local files.
BLOCKERS: None for single-process A2 review. Cross-process/shared-path locking, browser migration, global state migration and broadcast composition are not part of this increment; deploy one server process per schedule path.
NEXT_STEP: REVIEW 1003.4A2 SCHEDULER API/SSE BEFORE BROWSER MIGRATION

No stage. No commit. No push.

LIVEZONE BUILD 1003.4A2 SERVER SCHEDULER API SSE AUDIT COMPLETE
