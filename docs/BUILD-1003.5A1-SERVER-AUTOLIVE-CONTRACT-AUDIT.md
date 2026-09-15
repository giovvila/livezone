# BUILD 1003.5A1 — Server AutoLive foundation audit

## Final checkpoint re-run after scoping correction (2026-09-15)

Final review passed without new production/test changes: original reproducers
3/3, focused 1165/1165, full node --test 1558/1558, syntax 22/22 and diff check PASS.
The accepted checkpoint is exactly 24 files: 18 production + 4 tests + 2 docs.
These A/B/C files are authorized for staging; no commit or push is authorized.
The exact staged set and Git-filtered blobs are checked against a pre-stage
reviewed snapshot, including this audit and the JSON inventory.

Global UNKNOWN, scoped recovery, migration/CAS, bridge and private shared SSE
regressions passed. No server executor/health producer or Scheduler Program
execution is introduced. Protected .env/media hashes match the initial capture;
342 runtime/generated and 5 media exclusions remain outside the checkpoint.
No new regression or scoping blocker was found. Existing bootstrap/lifecycle
notes below are unchanged scope limits, not claims of fixes in this re-run.

Final logs: livezone-a1-checkpoint-focused.log and livezone-a1-checkpoint-full.log
in the user temporary directory. The final index SHA-256 is reported externally
after staging: embedding that hash in a file inside the index is self-referential.

## Historical Safe Delete scoping correction (2026-09-15)

The three original failing review reproducers are retained and now pass. This
section superseded the previous BLOCKED scoping review. At that step the checkpoint
remained unstaged; the final checkpoint re-run above records the subsequent review.

### Root cause and corrected model

AutoLive used global completeness for missing source identity and invalid recovery
storage. AssetReferenceInventory propagated that flag to every queried asset.
Configuration validity, execution capability and asset reachability are now separate.

AutoLive emits finite inventory rows: definite canonical references, explicit
recovery assets, unresolved source/scene metadata, and a scoped uncertainty flag.
A missing source creates unresolved metadata, never invented asset IDs. Valid
recovery assets remain definite holds even when source/scene resolution fails.
When canonical data has a malformed managed mapping, known extracted IDs are
conservatively UNKNOWN; unmappable identity is retained as diagnostic metadata.
No basename matching, DOM/player lookup or wildcard media hold is introduced.

AssetReferenceInventory.collect retains global completeness separately from
scopedUncertainty. inspect(asset) returns UNKNOWN if global authority is incomplete
or that asset is inside an unresolved finite scope; otherwise a definite reference
is USED, and no reference is UNUSED. The existing serialized deletion recheck is
unchanged. Explicit complete:false rows, Program identity checks, Preview/client
completeness and deletion-recovery checks still block globally. Only AutoLive opts
into the finite model. globalCompleteness describes global authorities, not whether
all individual assets are deletable; per-asset audit remains required.

### Corruption classification and evidence preservation

Strict recovery normalization still fails closed. On invalid startup the store
captures only a sanitized diagnostic projection of parsed asset IDs and canonical
source/scene IDs. It does not adopt invalid config, restore an executive record,
rewrite/delete the file, or expose raw file contents in API state.

- CORRUPT_BUT_SCOPABLE: invalid recovery with recoverable canonical IDs. Protect
  explicit IDs and assets resolved through surviving source/scene/candidate IDs as
  UNKNOWN. Unrelated assets remain independently evaluable.
- CORRUPT_UNSCOPABLE: unreadable JSON or read failure with no trusted projection.
  In A1 this is unavailable storage, not an active recovery executor. Runtime stays
  ERROR; storage mutations remain unavailable; no global asset hold is inferred.
- INVALID_NONAUTHORITATIVE: parsed invalid data with no usable reference identity.
  It cannot become an active recovery authority; preserve bytes and report status
  without global poisoning. Valid stored records, including RETURNED records,
  retain their finite holds until explicit revision/key-guarded clear.

This policy depends on the actual A1 boundary: no production executor writes or
reads recovery to TAKE/return. There is no historical server-executive recovery
journal to resume. A future executive phase must establish trusted active-session
provenance and a durable reference scope before reusing this policy; an actually
active unscopable writer would require global UNKNOWN.

One AutoLive condition still blocks globally: another live process-local owner
already owns either persistence path. The rejected instance cannot inspect or
serialize that writer's current scope, so it cannot certify any asset UNUSED.
The ownership guard is retained and tested, not inferred from a corrupt file.
Other genuinely unresolved authorities keep their original global behavior.

### Validation and safety

The original three gate tests pass unchanged. Eleven added cases cover missing
source with enabled/armed false and true, durable A with removed source, corrupt
scopable data without byte changes, both unscopable classifications, multiple A/C
holds, valid and invalid managed mappings, unchanged global authority rules and
conflicting live writer ownership. Two earlier tests were updated to distinguish
empty inactive storage and unresolved source metadata from global UNKNOWN.

Focused regression: 1164/1164 PASS. Final store run including writer-ownership
regression: 62/62 PASS (overlaps focused coverage; counts are not additive).
Syntax: 22/22 PASS. git diff --check: PASS. Full node --test: **1558/1558 PASS**,
zero skipped/cancelled tests. Current inventory: 24 files (18 production, 4 tests,
2 documentation), staged count zero. Logs: livezone-a1-scope-focused.log,
livezone-a1-scope-store-final.log and livezone-a1-scope-full.log in the user temp directory.

No browser/health/executive code changed in this correction. Technical Monitor,
ENTRY 30s healthy-playback, external LOSS 15s, managed LOSS 5s, shared Control SSE,
Program/Preview behavior and Scheduler SUSPENDED remain unchanged. No service
restart, real media deletion, runtime write, staging, commit or push was performed.
.env and the five named protected media files retain their initial SHA-256 values.

The prior review found three failures (1544/1547 full); they are resolved by this
correction rather than removed/skipped assertions. Bootstrap timeout and standalone
Scheduler pending-start lifecycle notes remain outside this scoping-only change
and must not be treated as fixed here.

## Scope and baseline

Local branch `build/1003.5A1` was created from `build/1003.4`, commit
`509722ee252d610fcd25911052abe27f7835c79c`, with an empty index. This is an
uncommitted implementation for review. No service restart or operator browser
action forms part of this implementation.

**AUTOLIVE EXECUTION WITH CONTROL CLOSED IS NOT YET ENABLED IN 1003.5A1.**

The server owns configuration, revisions, migration status and recovery storage.
`AutoLiveEntryController` remains the sole production AutoLive executor. The new
`AutoLiveAuthority` does not import or command Program Output, Preview, Scheduler,
players or health probes. There is no server TAKE, return, ENTRY timer, HLS
worker, decoder or polling loop. Scheduler Program execution stays
`programExecution:false` / `SUSPENDED`; Crawl and Sponsor execution is unchanged.

## Configuration and persistence

`server/autolive/AutoLiveContract.js` defines strict version 1 contracts. Config:

```json
{"version":1,"revision":0,"enabled":false,"armed":false,"sourceId":null,"updatedAt":null,"migration":null}
```

- `enabled` is the operational AUTOLIVE ALLOWED/BLOCKED consent.
- `armed` is the separate explicit authorization consumed by the existing controller.
- `sourceId` identifies an enabled HLS source in the canonical Studio catalog.
  Missing, disabled, wrong-kind or unresolved sources are rejected. Existing
  canonical URL/configRef resolution is used for validation; neither URL nor
  configRef is accepted as an independently editable AutoLive field or returned
  in AutoLive snapshots.
- Policy metadata preserves 30,000 ms healthy-playback ENTRY, 15,000 ms external
  confirmed loss and the existing 5,000 ms managed loss grace. No timing is
  editable here, and no elapsed health is inferred from wall time or downtime.

`AutoLiveStore` hydrates without writing on first boot. Mutation validates an
expected revision and canonical references, writes a private temporary file,
flushes and closes it, then atomically renames it. Only successful persistence
replaces the accepted immutable snapshot. Failed writes preserve memory and
the previous file. Corrupt state remains unavailable and is never overwritten
with safe defaults. Revisions are monotonic and exhaust safely.

Default paths follow the existing private Studio state layout:
`studioStatePath + '.autolive.json'` and
`studioStatePath + '.autolive-recovery.json'`. Public paths and overlapping
Studio/Scheduler/AutoLive paths are rejected. A process-local ownership registry
rejects duplicate owners of either AutoLive file; this is not a cross-process
database lock. Deployment continues to require one server writer.

## Explicit migration and legacy bridge

Migration accepts exactly `{version:1,enabled,armed,sourceId}` from an
authenticated operator at revision zero. It records a durable versioned marker.
A second migration, stale revision or any prior normal configuration mutation
closes the migration path. There is no automatic import or automatic arm.

Control and Scheduler show a compact status and an explicit
`IMPORTA CONFIG AUTOLIVE` button while the server is pristine. Before adoption,
existing legacy configuration can continue to drive the existing browser
executor; UI changes require explicit migration. This compatibility interval
does not change the server's safe initial values.

After adoption, UI changes write the server first. Accepted snapshots mirror
`armed` and `sourceId` into `DominantLiveConfig` without rewriting legacy storage,
and `enabled` into the existing Scheduler runtime consent gate. Config revisions,
runtime generations and retired server sessions reject stale responses/replay.
Repeated snapshots do not re-notify unchanged legacy configuration; the existing
engine's start/stop operations are idempotent. Storage events cannot overwrite
server-aware config. Legacy keys are retained, not deleted.

Unavailable mutations report failure without local fallback. Startup failure
with no accepted snapshot applies safe in-memory consents. A later disconnect
retains the last accepted config and reports unavailable; it does not invent a
second executive policy. Closed bridges cannot apply a delayed bootstrap reply.
Older, already open documents running pre-A1 code still require normal operator
adoption/reload later; A1 does not remotely replace their JavaScript.

## Runtime representation

Snapshots explicitly report `executionAuthority:"browser-legacy"` and
`phaseScope:"configuration-only"`. A1 emits DISABLED, ARMED, UNCERTAIN or ERROR
based on configuration, canonical source validity and store availability.
Future phase enum values do not imply execution. Health authority, observations,
sequence, validity, fingerprint, deadline, last action and expected Program
activation are null; healthy ENTRY accumulation is zero. Session UUID and
generation describe this server process's state events, not a running AutoLive
session. Catalog invalidation reports uncertainty without rewriting intent.

## Durable recovery foundation

`AutoLiveRecoveryStore` holds a separately versioned/revisioned record with:
session ID, stage, captured Program activation, Program revision, scene/source
identity and kind, source version reference, retained cue and playback state,
asset references, timestamps, expected current activation and action key.
It can represent playing/paused/ended media and an explicitly empty Program.
Activation identity is publisher session + committed timestamp + scene/source,
never a DOM or renderer instance. Strict field validation excludes callbacks,
timers, player objects and arbitrary additional fields.

Save uses revision CAS; updates retain session/action/creation identity. Clear
requires both revision and action key. The internal store is a foundation
capability, not an operator recovery-write API or an executive journal consumer.
Reload validates persisted data and never resumes TAKE, return or an expired
timer. Future execution must additionally define and enforce the Program CAS,
source-version reconciliation and permitted action-stage transitions.

## Safe Delete

The authoritative inventory now includes selected-source references, captured
source/scene, expected-current candidate source/scene, and explicit pinned assets.
Recovery writes validate canonical media and require all resolved asset IDs to
be included in the durable record. This preserves explicit holds across catalog
changes. Recovery mutations and reference checks use the existing shared asset
mutation coordinator, serializing them against deletion and catalog mutation.

A healthy empty recovery adds no wildcard hold. Clearing releases only these
AutoLive references; other catalog, Preview, Program or client references still
apply. Missing source identity remains scoped metadata. Corrupt but scopable recovery
produces UNKNOWN only for its finite references; see the correction policy above. USED remains blocked; UNUSED still requires the existing
authoritative deletion recheck. No delete policy is weakened.

## API and security

| Route | Contract |
| --- | --- |
| `GET /api/studio/autolive` | Config, inert runtime, policy, migration, recovery summary, server time; ETag |
| `PATCH /api/studio/autolive` | Only enabled/armed/sourceId |
| `POST /api/studio/autolive/migrate` | Explicit one-time legacy offer |

Existing OperatorRequestGuard session authentication applies to reads and
mutations. Mutations require origin, operator-request marker and CSRF checks;
the Program Output bearer alone is insufficient. Expected revision uses
`If-Match: "autolive-N"`. Missing revision returns 428, stale revision 412,
closed migration 409, invalid payload/source 422, invalid JSON 400, excessive
body 413 (8 KiB limit), wrong content type 415, unavailable storage 503.
There is no TAKE route and no public recovery record write route.
Responses contain no endpoint credentials, session cookie or CSRF secret.

## Events and browser transport

`ControlEventFeed` adds retained `autolive-state` alongside `program` and
`schedule-state` on the existing authenticated reference-presence transport.
The browser `ControlEventStream` recognizes the event and distributes leases
from that same connection. The AutoLive client creates no EventSource. Control
still has one physical persistent shared SSE. Mutation broadcasts state;
reconnect/replay is read-only and does not issue actions.

Public Program Output SSE never receives AutoLive state. Public and OBS remain
independent consumers. The standalone Scheduler AutoLive client uses initial
GET, mutation responses and focus refresh, with revision conflicts enforcing
freshness; it adds no SSE. Live cross-document AutoLive updates in Scheduler
without focus are not claimed by this foundation.

## Validation

Tests use temporary directories and ephemeral local test servers, not production
state or services. The focused regression covers AutoLive/Dominant Live, shared
health/Technical retry, Program continuity/output, Scheduler, Crawl/Sponsor,
Media Library/Safe Delete/reference authority, Public startup and socket budgets.

Historical implementation results before final review and the scoping correction:

| Gate | Result |
| --- | --- |
| New AutoLive cases | 60 passing, plus retained-state assertion in existing socket HTTP regression |
| Focused regression | 1063/1063 PASS |
| Full `node --test` | 1527/1527 PASS; no skipped/cancelled tests |
| `node --check` on changed/new JavaScript | 21/21 PASS |
| `git diff --check` | PASS |
| Staged files | 0; no staging operations |
| Branch/HEAD | build/1003.5A1 / 509722ee252d610fcd25911052abe27f7835c79c |
| Protected files | .env and all five named media files SHA-256 identical to initial capture |
| Remaining excluded entries | 342 runtime/generated + 5 media, matching the initial 347 entries |
| Operational actions | No service restart, browser operation, production TAKE or media deletion |
| Commit/push | none / none |

Test logs are outside the repository in the user's temporary directory:
`livezone-a1-focused-final.log` and `livezone-a1-full-final.log`.
Runtime/generated files were not edited by this implementation. Existing live
service activity is not claimed to be frozen or byte-audited by Git status.

### Original implementation files (22; current exact inventory is in CHECKPOINT-FILES.json)

- Server contracts/stores/API: `server/autolive/AutoLiveContract.js`,
  `AutoLiveStore.js`, `AutoLiveRecoveryStore.js`, `AutoLiveAuthority.js`,
  `AutoLiveRoutes.js`.
- Server integration: `server/program-output-server.js`,
  `server/program-output/ControlEventFeed.js`.
- Browser state: `public/js/studio/AutoLiveAuthorityClient.js`,
  `AutoLiveLegacyBridge.js`, `DominantLiveConfig.js`,
  `public/js/scheduler/SchedulerRuntimeState.js`,
  `public/js/core/ControlEventStream.js`.
- Bootstrap: `public/js/entries/control-room-app.js`, `schedule-app.js`.
- Existing controls: `public/js/ui/DominantLiveUI.js`, `StudioLiveSourcesUI.js`,
  `StudioScheduleSummaryUI.js`.
- Tests: `test/autolive-server-store.test.js`, `autolive-server-api.test.js`,
  `autolive-authority-client.test.js`, `control-socket-pool-http.test.js`.
- Documentation: this audit.

An initial regression run found a bootstrap-order static assertion and a Windows
EPERM on a temporary media manifest. Bootstrap order was restored without
changing the assertion. The manifest test passed on isolated rerun; no production
media persistence change was made for this transient failure.

## Known non-blocking limitations and next phase

- Control-closed AutoLive execution, server health authority, external HLS
  decoding, automatic ENTRY/TAKE/return and executive recovery remain future work.
- Technical Monitor and existing shared health remain independent and unchanged.
  Disabling the AutoLive consent does not disable Technical Monitor.
- MP4 seek/preload/Range, Preview selection, manual TAKE override, retained-cue
  return and reacquisition suppression are outside the change.
- BUILD 1003.4 accepted boundary is retained: audio-12 + MOTION ARTWORK works in
  Control, Public and OBS software; an additional OBS web page in the same Edge
  browser can fail. OBS software is the intended consumer. This observation
  does not weaken or reopen the validated shared-stream architecture.
- No live manual retest or service restart is performed in this task. Automated
  validation does not claim that the running backend has loaded this worktree.

Review A1 before starting A2 health authority. A2 must define authoritative
observations, expiry/uncertainty and source fingerprints while preserving the
healthy-playback timing distinction. Transfer of executive ownership and actual
recovery actions require separate reviewed phases with one decision owner.
