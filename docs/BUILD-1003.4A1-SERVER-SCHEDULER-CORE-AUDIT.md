# Build 1003.4A1 — server scheduler core audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4A1_SERVER_SCHEDULER_CORE_READY_FOR_REVIEW

BASELINE: build/1003.4 at e249fa040b3ff5a94f00dd7efdcc978cd656d8f3. Previously validated 803 tests; final suite now 847 passing.

EVENT_SCHEMA: Schedule `{version:1, revision, events}`; event `{id, version:1, type, enabled, startAt, endAt, priority, payload, createdAt, updatedAt}`. Supports overlay.crawl and overlay.sponsor validation only, with no rendering. Future program.* types fail explicitly until supported. Maximum 500 events, unique bounded IDs, integer priority -100..100. Payloads use the previously audited bounded fields; no arbitrary CSS, URLs or code. Store authors createdAt/updatedAt; immutable identity and creation time cannot be patched. Payload and event normalization produces frozen snapshots ordered by ID.

TIME_SEMANTICS: Canonical UTC ISO strings with milliseconds and Z are required. Invalid calendar dates, timezone-less strings, equal/reversed intervals are rejected. UI conversion remains future work. Active means `startAt <= now < endAt`.

CLOCK_MODEL: Injectable numeric epoch-millisecond clock, Date.now default only at constructor boundaries. Pure resolver accepts current time as an argument.

STORE_MODEL: Internal ScheduleStore provides initialize, getSnapshot/getStatus, listEvents/getEvent, insert, update, delete, setEnabled, subscription and draining destroy. Caller-owned inputs are cloned before queued work. Explicit path required; no default production/operator file is touched. Missing file produces revision-zero empty state in memory with no boot write. Failed hydration returns unavailable instead of silently replacing operator data.

PERSISTENCE_MODEL: Same private JSON/temp-and-rename convention as the audited repository: unique sibling temp opened exclusively, write, file sync, close, rename; snapshot changes and observers run only after successful rename. Failure cleans only its own temporary file and preserves prior schedule/revision. Corrupt or unknown-version disk contents are preserved and writes fail closed. No database. No automatic backup rollback or destructive migration. This does not claim directory-fsync/power-loss guarantees on every filesystem. Explicit operator backup recovery and cross-process fencing are integration work.

Architecture boundary: The accepted architecture proposes eventual integration into the authoritative Studio state coordinator. A1 deliberately does not extend its schema or modify P0-C1B.2. The isolated, explicit-path store is the testable persistence adapter for this foundation, not a second running authority: nothing instantiates it in the HTTP server. A2 must choose one durable production owner and adapt/migrate this domain before enabling it; it must not run parallel Studio and schedule writers. This internal store assumes one owning instance per path and serializes all mutations through that instance. It is not a multiprocess database.

REVISION_MODEL: Every mutation requires the current schedule revision. The check runs inside the serialized operation; concurrent matching revisions yield one commit and one REVISION_CONFLICT. No event edit revision is needed yet. Successful mutations increment schedule revision once; rejected/failed mutations do not. Unknown/deleted IDs and duplicate inserts return explicit codes. Destroy drains accepted operations and rejects later ones.

RECONCILIATION_MODEL: Pure normalize/resolve derives effective active winners from persisted schedule and current time. Returns activeEvents, nextDeadline, scheduleRevision, evaluatedAt. Authority refreshes its evaluated snapshot each reconciliation but notifies effective-state observers only when winning event content changes; ordinary time evaluation never writes persistence.

NEXT_DEADLINE_MODEL: Earliest future start/end among enabled events, including losing candidates whose eligibility may matter later. Null when no boundary remains. One timer owned by ScheduleAuthority; replacement and generation guards invalidate stale callbacks.

PERIODIC_RECONCILIATION: One canonical RECONCILIATION_INTERVAL_MS = 1000. Timer delay is the smaller of the next boundary and this ceiling. Reconciliation occurs on start, successful mutation and timer wake. A delayed callback evaluates actual current time rather than replaying missed events. With no events, the same one bounded periodic timer detects clock changes without publishing unchanged state.

COLLISION_MODEL: One winner per supported type; descending priority, descending startAt, then ascending ASCII ID. Crawl and sponsor are separate logical slots. When higher-priority sponsor B ends, still-active A resumes. No image placement, asset availability or presentation suppression is executed in A1.

RESTART_BEHAVIOR: New store/authority hydration reconstructs current active events before/during/after intervals without prior callbacks. Initialization is idempotent per store instance; unavailable data requires a new explicitly recovered instance, never an automatic empty reset.

CLOCK_JUMP_BEHAVIOR: Forward jumps skip already elapsed events; backward jumps re-enter an active interval or return to future/inactive according to literal timestamps. No activation-history flags affect overlay truth. Future side-effectful Program adapters must define separate idempotency rules.

INVALID_EVENT_POLICY: Reject malformed writes as a whole with a safe code. Reject corrupt/unsupported persisted schedules as unavailable; do not run a partial silently modified operator schedule. Pure validation throws coded errors; store operations contain them and return explicit failure results. There is no process-level timer dependency on unvalidated disk data.

SERVER_LIFECYCLE: ScheduleAuthority exposes async start, stop, destroy, subscribe and getSnapshot. Stop removes the store listener and timer, and invalidates delayed initialization/callbacks. Restart reevaluates current time. No timer survives teardown. Store destroy drains writes and removes listeners. A1 is an internal Node module; HTTP startup, readiness wiring and API integration are intentionally deferred. Running start requires no browser, DOM or connected subscriber.

DIAGNOSTICS: Bounded structured in-memory history (100 default, maximum configurable 1000), numeric allowlist only. Events: schedule-hydrated, schedule-mutated, reconcile, effective-state-changed, deadline-scheduled, deadline-fired, persistence-error, conflict. No payload, asset URL, text, secret or raw exception logging. No diagnostic files are written by the module.

BROADCAST_SIDE_EFFECTS: None. No imports/calls to StudioProgramCommand, Program Output, AutoLive, Public, OBS, Program/Preview, browser Scheduler or media renderer. UI, auth, protocol, MediaMTX and existing server composition remain unchanged. There is no running server authority rollout in this increment.

TESTS_ADDED: 44 deterministic tests in test/server-schedule-core.test.js: empty/future/start/midpoint/end/expired/disabled; four sponsor overlap checkpoints; tie ordering and independent types; malformed IDs/types/timestamps/calendar dates/intervals/priorities/payloads; three cold hydration positions; forward/backward jumps; active/future edits, disable/delete and priority change; concurrent revision conflict; duplicate and invalid-write preservation; missing/corrupt/unsupported persistence; rename failure and flush/close/rename ordering; next boundary; delayed deadline convergence/no duplicate publication; stop/restart/stale initialization; bounded diagnostics; malformed inserts; caller input mutation; observer failure and draining destroy. Filesystem tests use unique OS temporary directories, not operator runtime/media paths.

FOCUSED_TEST_RESULT: node --test test/server-schedule-core.test.js test/program-output-network.test.js — 128/128 PASS.
FULL_TEST_RESULT: node --test — 847/847 PASS, zero failed/skipped/cancelled.
SYNTAX_RESULT: node --check passed for all five new JavaScript files.
DIFF_CHECK_RESULT: git diff --check passed; new files separately checked for trailing whitespace/conflict markers.

FILES_CHANGED_FOR_THIS_FIX:
- server/scheduler/ScheduleContract.js
- server/scheduler/ScheduleStore.js
- server/scheduler/ScheduleAuthority.js
- server/scheduler/ScheduleDiagnostics.js
- test/server-schedule-core.test.js
- docs/BUILD-1003.4A1-SERVER-SCHEDULER-CORE-AUDIT.md

EXISTING_UNSTAGED_WORK_STATUS: Both earlier architecture documents preserved. Excluded demo2.mp4, demo3.mp4, imm.jpg, test-audio.mp3, logo-test.svg and var remain local/uncommitted. No cleanup or staging performed. Existing tests were executed as requested; A1 adds no runtime log/export writes.
PROTECTED_FILES_STATUS: No tracked production file changed. P0-C1B.2, AutoLive, handoff, media TAKE, output protocol, browser Scheduler, Public/OBS, Control Desk, auth and environment untouched.
GIT_STATUS: Expected branch/base unchanged, staging empty; only the six new A1 files are introduced by this task alongside the preexisting dirty/untracked files.
BLOCKERS: None for review of the internal A1 core. Production attachment, one durable owner/cross-process fencing, API/SSE and output composition are not implemented or claimed.
NEXT_STEP: REVIEW 1003.4A1 SERVER SCHEDULER CORE BEFORE API/SSE INTEGRATION

No stage. No commit. No push.

LIVEZONE BUILD 1003.4A1 SERVER SCHEDULER CORE AUDIT COMPLETE
