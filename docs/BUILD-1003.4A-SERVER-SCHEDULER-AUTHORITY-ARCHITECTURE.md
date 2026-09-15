# Build 1003.4A — server scheduler authority architecture audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4_SERVER_SCHEDULER_AUTHORITY_ARCHITECTURE_READY

BASELINE: Branch `build/1003.4`, commit `e249fa040b3ff5a94f00dd7efdcc978cd656d8f3`. The accepted 1003.3 runtime remains protected. This is design only. The prior `BUILD-1003.4-PROGRAMMABLE-OVERLAYS-ARCHITECTURE.md` is preserved unchanged; this document supersedes its browser-owned overlay execution recommendation. No implementation, staging, commit or push.

## Current authority and persistence: evidence

CURRENT_SCHEDULER_AUTHORITY: `entries/control-room-app.js` constructs the browser SchedulerEngine. `entries/schedule-app.js` constructs the schedule editor and catalog but no execution engine. Closing Scheduler alone does not stop Control's scheduler; closing Control removes the executing browser authority. Closing Public/OBS has no bearing on schedule evaluation.

CURRENT_SCHEDULE_PERSISTENCE: `scheduler/ScheduleStore.js` saves `livezone.scheduler.schedule.v1` in localStorage and uses storage notifications between same-origin browser tabs. `SchedulerRuntimeState.js` persists only enabled state at `livezone.scheduler.runtime.v1`; interruption context, runtime shifts and attempted activations live in the browser engine. Local data survives browser restart in the same profile/origin, not storage clearing or movement to another machine. Server restart does not erase localStorage, but does not execute its contents either.

Important server finding: `server/studio/AuthoritativeStateContract.js` already models sources, scenes, scheduler, globalOverlays and dominantLive. `AuthoritativeStateRepository.js` persists them at the configured private studio-state path (default `var/studio-state/state.json`). `StudioStateCoordinator.js` serializes initializeState; `StudioStateRoutes.js` provides GET, initialize-once POST and authenticated state SSE. This is an initialization/persistence foundation, NOT a server SchedulerEngine. No client reference to `/api/studio/state` was found in current public/js. Whether a particular installation has initialized its state file is deployment data and was not inspected. Do not confuse this stored scheduler domain with active schedule execution or assume it contains the latest browser edits.

CURRENT_CLOCK_MODEL: Browser Date.now injected into SchedulerEngine; ABSOLUTE and AFTER_PREVIOUS starts, timezone parsing, half-open computed intervals, interruption/resume shifts in `scheduler/ScheduleClock.js`. `ui/ScheduleClock.js` is an aligned one-second display clock, not an external time source. The schedule is hybrid absolute/relative; overlay intervals should not inherit Program runtime shifts.

CURRENT_EXECUTION_MODEL: UI → ScheduleStore → Control subscription → SchedulerEngine.reconcile → active item and interruption selection → StudioProgramCommand.execute → StudioTransitionCoordinator → browser media preparation/renderer → StudioStateManager commit → ProgramOutputManager publication. Execution depends on DOM/media readiness. `ProgramPlaybackContinuity.js` reconstructs supported media/audio cues from a matching retained output snapshot within six hours; it is not unattended server playout and does not reconstruct arbitrary live ownership or interruptions.

CURRENT_SERVER_CAPABILITIES: `server/program-output-server.js` creates one Node HTTP process with static/media delivery, authenticated operator and Studio/Media Library routes, media-ingest status, Program Output POST and public retained SSE. Configuration is loaded from process environment and injected constructors; do not alter .env. Media and studio repositories initialize asynchronously. /healthz checks liveness; /readyz reports component checks. The server close hook unsubscribes and closes SSE clients; the entrypoint listens directly. No scheduler loop or dedicated SIGINT/SIGTERM drain workflow appears in this module. SSE keepalives run every 15 seconds and clean up on disconnect. They are not scheduling infrastructure.

ProgramOutputStore is in-memory: it validates and retains one envelope, rejects stale publisher revisions/retired sessions, then broadcasts it. Restart loses that retained output. Publisher POST uses bearer authorization and allowed-origin checks; operator writes elsewhere use session/CSRF guards. MediaMTX integration reports ingest presence/HLS availability, not a general scheduler or media renderer.

AUTHORITY_GAP: No browser-independent evaluator; no live schedule-write coordinator; no server compositor capable of publishing scheduled changes without a browser. A server timer that asks Control to publish would not solve the requirement.

## Target server authority and generic model

TARGET_SERVER_AUTHORITY: One process-owned ScheduleAuthority, one serialized durable mutation coordinator, and one BroadcastOutputCoordinator as the ONLY writer to effective ProgramOutputStore. Browsers edit/observe or send authorized operator input. The server must start these services even with zero SSE subscribers. No browser election, tab heartbeat or viewer presence is allowed to gate scheduled execution.

Pipeline:

```text
Authenticated editors → durable state coordinator → ScheduleAuthority
                                                    ↓ scheduled state
Control publisher → validated base/manual input → BroadcastOutputCoordinator
                                                    ↓ one effective snapshot
                                             ProgramOutputStore → existing public SSE
                                                                     ↓
                                                       Control / Public / OBS
```

GENERIC_EVENT_MODEL: Extend the existing authoritative state schema with an `automation` domain, retaining the existing `scheduler` domain as legacy Program schedule data. Recommended top-level schemaVersion 2, with automation version 1. Use the existing repository/coordinator rather than create two competing authoritative schedule files. Domain example:

```json
{
  "version": 1,
  "enabled": true,
  "timezone": "Europe/Rome",
  "events": [{
    "id": "event-sponsor-evening",
    "version": 1,
    "type": "overlay.sponsor",
    "enabled": true,
    "startAt": "2026-09-12T18:00:00.000Z",
    "endAt": "2026-09-12T18:15:00.000Z",
    "priority": 10,
    "name": "Evening sponsor",
    "payload": {"assetId": "managed-asset-id", "position": "top-right", "sizePercent": 15, "opacity": 1},
    "createdAt": "2026-09-12T17:55:00.000Z",
    "updatedAt": "2026-09-12T17:55:00.000Z"
  }]
}
```

Type namespaces: `overlay.crawl` and `overlay.sponsor` first. Reserve `program.scene`, `program.break`, `program.live` for future execution adapters. Do not accept these future types as runnable before the adapter exists. Unknown versions/types are never silently executed, downgraded or dropped on save. An unsupported newer document opens read-only/unavailable pending upgrade. Per-event version is payload schema version, not edit revision. Created/updated timestamps are server-authored; id is immutable; name supports editor display; priority is bounded integer. No cron, recurrence DSL, scripts or arbitrary action URLs.

Crawl retains the audited bounded plain-text payload, style presets, direction and cycle speed. Sponsor references a managed PNG/WebP image. Asset presence is runtime eligibility, not a reason to destructively rewrite events. Optional presentation policy defaults to suppress ENTRY/LOSS and show BREAK; no interruption/resume policy on overlay events. Duration is a UI alternative converted to endAt; do not persist contradictory duration/end fields. Proposed initial limits: 500 events, text 500 Unicode characters, name 120, priority -100..100, bounded API body/document size checked in bytes.

## Time, timers and reconciliation

TIME_MODEL: Server UTC wall time is authoritative; persisted timestamps require ISO-8601 with explicit offset, canonicalized to UTC. Editor timezone is display/input metadata, independent of server OS timezone. Reuse audited timezone parsing with explicit handling of nonexistent DST times (reject) and ambiguous times (require offset/fold choice). Active means enabled and `startAt <= now < endAt`; exact end is inactive.

TIMER_MODEL: Hybrid with ONE replaceable wake-up timer. Schedule the earlier of next relevant boundary and a one-second reconciliation ceiling. This combines near-deadline activation with bounded detection of wall-clock jumps, process stalls and sleep; not one timer per event. Inject wall clock, timer and clearTimer for tests. A monotonic measurement may detect jumps, but never defines persisted due time. With at most 500 events a bounded scan per reconcile is sufficient; optimize only with evidence. Replace timer after edits; clamp timer delay and invalidate old callbacks by generation.

RECONCILIATION_MODEL: Pure `deriveDesired(schedule, serverNow, presentation, assetAvailability, manualState)` computes candidates, suppression, winners and next boundary. No imperative 'start happened' flags. On initial load, accepted edit, clock wake, base presentation update and asset change, reconcile. Serialize state transitions, prevent overlapping async reconciliation; stale asset resolutions cannot apply after revision/generation changes. Publish only if the effective state fingerprint changes. Keep logical runtime revision separate from persisted document revision: time ticks do not rewrite schedule files.

Forward jump: evaluate current interval, skip fully elapsed overlays, do not replay historical starts. Backward jump: reevaluate literally; an event may become active again and crawl phase moves back with authoritative wall time. This is intentional interval semantics for overlays. Future side-effectful Program adapters require separate idempotency/activation rules; they must not inherit replay behavior accidentally. No real-time system can execute while the host is asleep or the process is stalled; it must converge on the first resumed evaluation, rather than claim retroactive playback.

RESTART_MODEL: Load/validate persisted state, initialize asset repository, derive active events at current server time, create an output session epoch and publish retained effective state before announcing scheduler readiness. Sponsor active at restart resumes immediately after initialization. Expired sponsor never returns. Crawl phase is derived from original startAt modulo the validated cycle duration, not restarted at boot or subscriber join. Server logical activation occurs with zero browsers; visual pixels exist when a renderer connects.

## Persistence and API

PERSISTENCE_MODEL: Reuse AuthoritativeStateRepository's private path, immutable validation and temp-file/rename convention, extending StudioStateCoordinator with revision-checked updates. Schema v1→v2 conversion adds an empty automation domain in memory without rewriting on boot; preserve sources/scenes/scheduler/globalOverlays/dominantLive byte-equivalent in meaning. Commit schema upgrade only on an explicit accepted mutation/import. Do not repurpose legacy scheduler fields.

Strengthen the new write path with exclusive temp creation in the same directory, file flush before rename and directory flush where supported. Existing write+rename is atomic-replacement convention, not proof of power-loss durability on every filesystem. Keep a validated last-good backup; define/test Windows rename failure and disk-full behavior. A failed write never advances visible revision or schedules. One process owns the repository; enforce an exclusive owner lock or fail startup for a second writer. Multi-host/shared-filesystem writers and database deployment are outside this single-server increment.

Corrupt primary: preserve it, report scheduler unavailable, do not boot-save an empty schedule or silently execute an older backup. An already-running process may continue its last validated in-memory schedule while blocking writes and reporting degraded persistence. Cold boot with corruption suppresses scheduled state; operator explicitly restores a validated backup with a fresh revision/state identity. Missing file is uninitialized with no runnable events until explicit initialization. Backup recovery must not replay superseded commercials unknowingly.

API_MODEL: Extend existing `/api/studio/state` conventions. Proposed authenticated `GET /api/studio/schedule`, `POST /api/studio/schedule/events`, `PATCH /api/studio/schedule/events/:id`, `DELETE .../:id`, plus `GET /api/studio/schedule/status`. enabled is a validated PATCH, not a second mutation mechanism. GET returns schedule revision/ETag and serverTime. Status includes active/future/expired/disabled/suppressed/missing-asset/conflict and global unavailable/invalid state. Malformed requests produce 422 and never enter the store. Unknown keys, invalid IDs, oversized bodies and unsupported types fail explicitly.

REVISION_CONCURRENCY_MODEL: Use existing global stateId + revision, not timestamp last-write-wins. Require If-Match on each mutation, checked INSIDE coordinator serialization. Missing precondition 428, stale 412, duplicate ID 409. Unrelated edits may conflict initially; that is preferable to silent data loss and avoids premature per-event revision complexity. Persist first, swap in-memory snapshot, reconcile, then notify; response includes committed revision. For retried creates, use a client-generated stable event ID and read-after-timeout: identical already-created content can be recognized, different content is a conflict. Never acknowledge a lost write. SSE notification failure cannot roll back a successful commit.

AUTH_SECURITY_MODEL: Use existing OperatorRequestGuard.authorize for private reads/status/SSE and authorizeMutation for ALL POST/PATCH/PUT/DELETE paths, including any immediate action. Preserve session, origin, mutation-header and CSRF validation. Publisher bearer permission is NOT schedule-edit permission. Public and OBS receive no private schedule data or write token. Existing development bypass must stay explicitly a development configuration, not become a production schedule bypass. Do not read/log secret values. No arbitrary CSS/HTML/path execution. Resolve managed image IDs server-side through MediaAssetRepository metadata/routes; the browser StudioAssetResolver is not directly reusable on Node.

## Distribution and the single output authority

SSE_MODEL: Reuse authenticated `/api/studio/state/events` for editor revision notifications and an authenticated schedule-runtime logical event carrying current computed status/serverTime. Reconnect sends a current snapshot/revision and clients refetch private data on mismatch, rather than assume a complete historical event log. Public/OBS continue using only `/api/program-output/events` and its retained `program` event. Separate private editor information from public broadcast snapshots, even if shared SSE utilities implement both. No frame-rate broadcasts or schedule polling. Add bounded backpressure/disconnect handling; current response.write usage is not a durable queue.

PROGRAM_OUTPUT_INTEGRATION: Do NOT let ScheduleAuthority forge a revision in Control's publisherSessionId. Introduce separate input and output revision namespaces. Browser ProgramOutputManager continues producing base source/playback/manual-graphics proposals with its current publisher sequence. Ingress validation retains stale/retry rules for that input. BroadcastOutputCoordinator merges those accepted inputs with server scheduled state, allocates a server-owned effective publisherSessionId and monotonically increasing output revision, then alone writes ProgramOutputStore. Browser attempts to inject the scheduled namespace are rejected or stripped at the explicit ingress contract boundary, never trusted.

Output retains base scene/source/committedAt/playback when only overlays change. Existing activation keys therefore remain stable within the effective server output session; overlay events do not rebuild media. An ingress ACK identifies accepted INPUT revision, not generated output revision. Control must never republish an effective merged snapshot as a new manual input, which would create a feedback loop. Retain distinct base/manual and effective stores in memory with explicit types. Program status or title cannot implicitly grant write ownership.

The current publisher-session retirement behavior is not a robust multi-Control lease. Before enabling composition, add an explicit fenced Control input owner: first eligible publisher claims an epoch, authorized takeover replaces it, delayed prior-epoch messages are rejected. Ownership takeover must be operator-explicit while a valid owner is active; browser absence must not halt the server overlay owner. Reconnecting Control bootstraps from effective/base state BEFORE claiming or publishing, not from default empty local state. This boundary needs integration tests; it is not a change to AutoLive timing or lifecycle.

Contract impact is explicit: the prior proposed snapshot v2 scheduled fields plus server output/input identity separation, private status notifications and bootstrap/claim metadata. Existing v1 output subscribers cannot be assumed compatible with scheduled v2; update validators/server/Control/Public/OBS together under an opt-in rollout, retaining legacy mode until the integration gates pass. Same public SSE endpoint, no competing output feed. No protocol change is made in this audit.

CONTROL_ABSENT_MODEL: Timer evaluation and output composition run in Node with zero connections. If a valid base snapshot exists, scheduled sponsor/crawl overlays are composed over it without Control publication. If no base has ever been accepted, publish an explicit empty Program with scheduled overlay state and make the shared renderer support that overlay-only composite; do not invent a Program scene or pretend a media source is playing. Late subscribers receive it immediately. This requires deliberate empty/waiting-layer integration because today's waiting rendering does not establish that capability.

Base continuity across restart also needs explicit persistence: introduce a separately versioned PRIVATE last-accepted base/manual checkpoint using the same atomic repository conventions, updated on accepted base changes, never on animation ticks. It is playback/output recovery data, not a second schedule authority. Maintain its sequence/order through the coordinator; failure is reported as degraded recovery, never hidden. Restore source/playback timing only if validated and within the accepted continuity rules; expired/unknown/unavailable base yields empty Program while scheduled events still execute. ENTRY/LOSS snapshots do not prove an AutoLive session survived a restart: preserve them only as unavailable presentation evidence, suppress commercial overlays until a valid new base classification, and never reconstitute AutoLive ownership from graphics. Schedule activation status must be distinct from visually suppressed output.

CONTROL_RECONNECT_MODEL: Obtain retained effective snapshot and input-owner metadata, load matching scene/source catalog and schedule status, reconstruct supported Program transport, then render the server scheduled layer. Do not import local empty schedule or local overlay defaults automatically. Existing media/audio cue continuity can be reused with its guards; LIVE readiness and transient slate recovery remain existing renderer concerns. Catalog mismatch produces a visible operator sync issue without overwriting server output. Observe effective overlays only; Preview and manual drafts remain local. Any takeover must be explicit and generation-fenced.

MANUAL_SCHEDULED_PRECEDENCE: Retain manual crawl and channel logo separately from schedule results. Eligible scheduled crawl wins its single slot; when none is eligible, saved manual crawl returns. Scheduled sponsor has its own slot, never deletes channel logo. Operator edits manual crawl while scheduled content owns the slot update the draft/manual state, not the schedule. Explicit SHOW/HIDE overrides can later be persisted with expiry and revision, not ad hoc local calls that race the server.

COLLISION_PRIORITY_MODEL: Eligible same-type events sort by descending priority, descending startAt, ascending ID. When B ends, A resumes if still in its interval. Channel-logo corner stays reserved; sponsor resolves to a deterministic free corner; crawl safe-area insets are computed once by server projection and rendered consistently. Suppression is evaluated before winner selection; no browser ordering.

ENTRY_POLICY: Suppress scheduled crawl/sponsor visually. LOSS_POLICY: same. BREAK_POLICY: show. Suppression never shifts endAt or animationEpoch. LOSS from 20:04–20:06 hides a 20:00–20:10 sponsor; it returns at 20:06 and stops at 20:10. If it expired during LOSS, it stays absent. Consume validated base presentation markers, not text labels. AUTOLIVE_ISOLATION: no scheduling write to AutoLive config, 30s entry, 2s debounce, 15s grace, HLS recovery or source routing; no synthetic normal BREAK command for suppression.

## Future Program scheduling and migration

PROGRAM_SCHEDULING_FUTURE_FIT: Generic interval selection can later produce a `program.scene` desired target through an execution-adapter interface. That is not sufficient for unattended playout today: StudioProgramCommand calls DOM-bound media preparation, transitions and source/cue state. Future work must define a headless/server media execution backend or authoritative declarative playout model, asset/catalog persistence, decode readiness, cue/seek/duration/ended evidence, CUT/DISSOLVE/audio mixing, LIVE readiness, interruption restoration, manual override fencing and failover. Browser ACK cannot be required to execute. No fake adapter should mark events successful merely because a due timestamp was found. Program event types remain unsupported/inert until that authority is implemented; the current browser Program scheduler remains clearly a legacy domain during phase 1.

MIGRATION_MODEL: Keep current localStorage keys and legacy server scheduler data intact. Add an explicit import preview comparing browser data, initialized server state and target revision. Match stable IDs and show conflicts/timezone conversions; operator approves once, using an import fingerprint and revision so retries do not duplicate records. Convert only absolute overlay records once that UI exists. Current Program schedules retain ABSOLUTE/AFTER_PREVIOUS, interruption and resume policy information as compatibility data, not silently flattened events. They are not enabled on the new engine without the future Program adapter. Browser editor data is never auto-uploaded on reconnect or deleted after import. Once a domain is server-managed its browser executor must be disabled for that domain; never two schedulers for the same event.

## Failure recovery and test architecture

FAILURE_RECOVERY_MODEL: Invalid events/duplicate IDs reject the mutation; unknown schemas preserve file and block execution. Missing assets suppress only that sponsor with operator diagnostics. Overlap is deterministic. API edits during activation linearize at durable commit; derive against current time after commit. Delete/disable removes an active event on that reconciliation. Disconnects do not affect execution. SSE reconnect gives latest retained state. Stale editor receives conflict. File corruption/restart and wall-clock jumps follow the explicit policies above. No public diagnostic text leaks into Program. Stop service by canceling timer, rejecting new mutations, draining accepted writes, detaching listeners and ending SSE before HTTP close; add bounded graceful signal handling to the existing entrypoint.

PERFORMANCE_MODEL: One bounded reconciliation timer, pure interval evaluation, event-driven asset updates, fingerprints to deduplicate output, immutable retained state, local client transform animation derived from server time. Provide serverTime in retained state/status and estimate client clock offset from a lightweight timestamped bootstrap exchange; late-join crawl phase derives from startAt using that offset. Reconcile phase on visibility/reconnect rather than continuous network updates. Clock synchronization is approximate; do not promise frame-accurate lock across browsers. No extra video/audio consumers for sponsor/crawl.

TEST_ARCHITECTURE: Inject wall clock, timer queue, file operations, asset lookup and output sink. Advance fake time, never sleep real minutes. Use ephemeral HTTP/SSE integration servers with deterministic clocks and temporary test directories (not operator var files).

| Cases | Required assertions |
|---|---|
| 1–5 future/start/middle/end/expiration | Half-open boundary behavior and one changed effective publication |
| 6–7 startup active/expired | Reconcile from persisted state without observing start callback |
| 8–9 jumps forward/backward | Skip elapsed intervals; literal backward reevaluation; deterministic phase |
| 10–11 overlap/winner expires | B wins, then still-valid A resumes with original end |
| 12 disabled | No activation, active disable removes immediately |
| 13–14 edit before/while active | Revision-linearized winner and payload; no stale async completion |
| 15 delete active | Immediate effective removal, no event resurrection |
| 16–17 Control/Scheduler absent | No browser objects; server sink changes at boundaries |
| 18–19 Public/OBS late join | Same retained source plus current overlays, no refresh |
| 20 SSE reconnect | Latest full state, stale revisions rejected, bounded backlog |
| 21 restart | Persisted schedule rehydrates; phase and base fallback policy respected |
| 22 corruption | No boot rewrite; unavailable status; explicit backup recovery |
| 23 concurrent edits | Exactly one matching revision wins, other receives 412 |
| 24–26 ENTRY/LOSS/BREAK | Suppression/show without time mutation or Program command |
| 27–28 AutoLive/TAKE | Schedule bytes unchanged, media activation unaffected by overlay revisions |
| 29 manual coexistence | Scheduled crawl precedence and restoration; channel logo retained |
| 30 Program/Preview isolation | No scene selection, cue, media preparation or Preview mutation |

Additional gates: repository atomic-write failures/disk full, power-loss recovery expectations, duplicate process lock, unsupported event version, oversized request, DST gap/fold, CSRF and anonymous mutation rejection, public SSE privacy, session expiry, fenced publisher takeover/stale retries, Control bootstrap feedback prevention, empty-base scheduled display, input/output revision independence, server restart with transient slate, graceful shutdown, fake timer stale callbacks, asset deletion race, and 803-test baseline plus new tests and real Control/Public/OBS retest before rollout.

## Implementation phases, scope and remaining gates

IMPLEMENTATION_PHASES:
- 1003.4A1: versioned state extension, serialized optimistic writes, persistence/failure policy, pure reconciliation and single timer. Test effective logical state with no browsers; no overlay UI enabled.
- 1003.4A2: authenticated CRUD/status, private SSE, explicit import and editor synchronization. Preserve legacy Program execution; domain-specific server ownership is explicit.
- 1003.4A3: server BroadcastOutputCoordinator, separate ingress/output revisions, fenced publisher bootstrap, base recovery, snapshot contract and retained Control/Public/OBS integration. This is mandatory before claiming unattended broadcast overlays; it cannot be postponed behind UI delivery.
- 1003.4B/C: end-to-end crawl then managed sponsor, each including renderer timing/retention, collision/suppression and no-browser tests. Final hardening/manual regression; rotation and Program execution adapter remain later work.

FILES_EXPECTED_TO_CHANGE (future only): existing `server/studio/AuthoritativeStateContract.js`, `AuthoritativeStateRepository.js`, `StudioStateCoordinator.js`, `StudioStateRoutes.js`; new `server/scheduler/ScheduleAuthority.js`, schedule contract/projection and route module; new `server/program-output/BroadcastOutputCoordinator.js` and base checkpoint repository; `server/program-output-server.js`, `server/program-output/ProgramOutputStore.js`, readiness/status integration; shared ProgramOutputContract/Envelope, NetworkProgramOutputTransport and ProgramOutputManager ingress/bootstrap adapters; Control/Scheduler entry wiring, schedule API client/editor adapter, shared overlay renderer and PublicProgramController; deterministic unit/API/SSE/migration tests. Do not edit AutoLive/media engine internals, runtime secrets, MediaMTX or operator files as part of the authority foundation.

RISKS: Input/output ownership migration is the main regression risk; server-state initialization exists but is not proven populated/current; transient AutoLive state cannot be resurrected from snapshots; hardware power-loss durability needs platform verification; future Program playout is not solved by moving timers. Stage rollout and keep legacy mode until tests/manual acceptance establish the new boundary.

BLOCKERS: None to this architecture deliverable. Implementation requires accepting the explicit state/output contract and publisher ownership changes; unattended Program automation remains a future backend problem, not a phase-1 promise. No source files changed or tests rerun for this documentation-only audit. Prior architecture document and local media/runtime artifacts are preserved.

NEXT_STEP: REVIEW SERVER SCHEDULER AUTHORITY ARCHITECTURE BEFORE IMPLEMENTATION

LIVEZONE BUILD 1003.4 SERVER SCHEDULER AUTHORITY ARCHITECTURE AUDIT COMPLETE
