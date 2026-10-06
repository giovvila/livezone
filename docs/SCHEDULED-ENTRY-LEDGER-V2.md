# Scheduled Entry Ledger protocol v2

Design recorded before implementation (8C-2C6R3). The real orphan v1 lock is
LEGACY_LEDGER_LOCK_UNVERIFIABLE and is outside this protocol.

## State machine and artifacts

The canonical file is a checksummed v2 envelope around the unchanged executable
identity/consumption snapshot. A retained append-only `.wal` contains checksummed,
hash-linked BASE, BEGIN, INTENT, COMMIT and END records. BASE retains the initial
snapshot; BEGIN binds a writer's v2 lock to the current snapshot. INTENT includes
transactionId, entryKey, full next snapshot, previous/next generation and hash,
ledger/repository identity and the writer lock (PID, random processSession,
authority epoch/session and initial snapshot hash). Timestamps are diagnostic.
No compaction, rollback, or automatic deletion of WAL records is permitted.

STABLE -> INTENT_DURABLE -> INSTALLING -> COMMITTED -> in-memory publication.
An intent is written and file-synced BEFORE snapshot staging. A complete valid
intent is conservatively consumed even when its caller never received success.
Recovery never executes/captures the event. It installs the exact intent snapshot
or keeps that snapshot, then syncs and records COMMIT. Partial/corrupt evidence
blocks rather than truncating the WAL or treating the event as unconsumed.

## Crash matrix

| Boundary | Interpretation and recovery | Execution |
| --- | --- | --- |
| Before intent | Stable snapshot; orphan owner requires offline reconciliation | Blocked until reconciliation |
| During intent write | Partial record blocks; complete valid record is conservative consumption | Never replay |
| After intent fsync | Install next from intent | Suppress interrupted event |
| During staging | Partial staging blocks for review; intact staging must equal intent | Blocked or suppress |
| After staging fsync / before rename | Install next from intent | Suppress |
| During/after rename / before canonical fsync | Canonical must be exact previous or next; install/sync next | Suppress |
| After canonical fsync / before completion | Keep next, sync and append COMMIT | Suppress |
| During completion | Partial WAL blocks; complete COMMIT retains consumption | Never replay |
| After completion / before memory publication | Keep committed next | Already consumed |
| After publication | Keep committed next | Already consumed |
| During shutdown | END must be complete before lock removal; orphan lock still requires offline proof | Blocked until safe |

Missing/corrupt canonical ledger, unknown staging, broken chains, wrong repository,
ledger, authority or writer binding always fail closed. A missing canonical file
is not silently recreated by recovery. Bootstrap/migration interruption can block;
it cannot create an execution-permissive empty history.

## Durability and Windows limits

WAL append -> file fsync -> snapshot staging write -> staging fsync -> rename ->
destination fsync -> COMMIT append -> WAL fsync -> publish. Directory fsync is
attempted on platforms supporting it. Node on Windows does not expose a portable
directory-fsync guarantee; this is explicitly recorded as FILE_SYNC_ONLY.
The established WAL is appended in place, never replaced per transaction.
No claim is made for storage that loses acknowledged file fsync, coherent rollback
of every artifact, malicious edits, or arbitrary power-loss namespace rollback.
Detectable missing/partial/mismatched evidence remains unavailable. In particular,
v2 initialization/migration and offline recovery on Windows require a separately
established namespace durability barrier before READY or orphan-lock archival;
absent that primitive they fail closed with LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN.
The injected DIRECTORY_SYNCED capability in tests is a storage fixture, never an
operator approval or a production bypass. The native Windows adapter is not
implemented in this increment: Windows architecture readiness remains BLOCKED.
Process-loss tests are not proof of physical power-loss durability.

## Startup, reconciliation, compatibility

Startup validates the complete retained chain before READY. An existing lock is
never broken on startup. Offline reconciliation requires canonical offline census,
Stopped/Disabled service, exclusive port/gate, fresh evidence, valid bootstrap and
authority/Scheduled provenance. It recovers pending consumption before archiving
the lock, with durable prepared audit and completion and idempotent retries.

Clean v1 remains readable through the legacy repository. Explicit protocol-v2
migration requires no lock and retains every consumption. New v2 state cannot
downgrade when WAL is missing. No legacy lock authorization bypass is provided.
Activation uses scheduledEntryLedgerOptions.protocolVersion = 2 (and migrateV1 =
true for clean v1). Default installations remain v1 until the Windows durability
blocker is resolved; an existing WAL selects v2 regardless of that option.

An eventual new execution era for real v1 would require a separate operator-approved
retirement of all old executable identities and preserved forensic history, with
fresh identities only for deliberately authorized future work. Merely resetting a
ledger, changing epoch, or deleting its lock is not such a procedure.

## Implementation and verification

Production modules: ScheduledEntryLedgerV2Protocol (envelope/WAL/validation),
ScheduledEntryLedgerV2Repository (single writer), ReconcileScheduledEntryLedgerV2
(offline-only module). ScheduledEntryRuntime selects v2 explicitly or when a WAL
exists. The legacy writer refuses WAL-backed history. RecoveryContract understands
the envelope and records WAL hashes; RecoveryWorkflow includes WAL in stability
checks. There is deliberately no v2 recovery CLI or automatic Prepare lock release.
The v2 lock must be handled before the existing Scheduled/authority reconcilers,
because those original locks are part of its provenance proof.

Full snapshots in retained intents trade disk space and scan time for a simple
recovery proof. There is no WAL compaction or automatic retention deletion. The
protocol reader refuses artifacts over 64 MiB; the existing recovery inventory
has its stricter 16 MiB limit. Reaching either limit blocks the corresponding
operation, never discards consumption. These limits need operational sizing before
production rollout. Snapshot linkage hashes use canonical semantic JSON; reviewed
offline evidence hashes cover exact file bytes.

Isolated verification: 256 focused tests passed (v2, legacy ledger, entry runtime,
entry validation, recovery tooling); 550 broader regression tests passed across
29 files (late start, temporal and terminal contracts, execution/provenance,
startup/restart, identity/continuity and scheduler). No failures/skips. Child tests
call process.exit at 20 boundaries without graceful repository cleanup. Recovery
fault tests exercise partial writes, retry, archive and completion, plus
namespace-capability refusal. The real runtime was not used.

The five pre-existing 2C6H1 files are outside this increment. Task-start SHA-256:

| File | SHA-256 |
| --- | --- |
| server/autolive/AutoLiveSafeHttp.js | E08489051C477DC8073DA95EEE77DF293CC75AA452F8FF1CF9F25A53E537D614 |
| server/autolive/ManagedIngestTransport.js | 6A375DCC1A574334212EF2B78B9EA6698E52591E6EC0EFB72472BD7133BC83BF |
| test/managed-ingest-transport-health.test.js | 9F4DF81AB2124C8EF92C0BC44BF97BC726BC2459620C8896FB482BCF63909CA1 |
| test/scheduled-live-managed-health-gap.test.js | 4084481E4646196A5B1AF2A46FDA2561F96B33A878369BD80406E9FE3071B283 |
| test-support/MediaMtxCookieFixture.js | 10990DA07B5D56EDE3F273974D13CB14B3C2D16F154337E63A76E34C31BEFB72 |

References for the durability boundary:
- https://nodejs.org/api/fs.html#fsfsyncsyncfd
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw

Status: protocol implementation is testable, but Windows production readiness is
BLOCKED pending a verified native namespace durability adapter and its crash tests.
No current real v1 orphan is reclassified or made recoverable by these changes.
