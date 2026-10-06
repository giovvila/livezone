# R27 Windows migration namespace validation

R27 changes production classification. R25-A2 remains independent review evidence.
The branch is `build/1003.9A1`, baseline HEAD
`1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b`; this work is uncommitted.

## Root cause and contract

Directory enumeration previously used case-sensitive `startsWith` and suffix
membership, while canonical Win32 opens on supported local NTFS resolve ASCII
case aliases. Consequently `.migration.review.stage` blocked but the same file
renamed `.MIGRATION.review.STAGE` escaped enumeration. Ledger v2's staging
prefix and suffix filter had the same comparison problem.

`RecoveryNamespace.js` owns filename comparison. Windows folds ASCII A–Z for
namespace membership and collision detection; POSIX retains exact names. The
deployed protocol basenames, fixed tokens, UUIDs and generated operation IDs
are ASCII. Directory paths may contain Unicode. This does not establish full
Unicode NTFS collation, normalization, short-name, reparse-point or filesystem
equivalence. Canonical evidence access additionally requires the exact
directory-entry spelling whenever a Windows canonical path resolves, including
an alias outside the ASCII key. Such aliases are rejected, never adopted.

The migration reservation is `<ledger>.migration` (including unexpected
extensions or missing separators). Known suffixes are `intent.stage`, `intent`,
`base.stage`, `snapshot.stage`, `activation.stage`, `activated`,
`completion.stage`, `completed`. Canonical known entries remain usable.
Equivalent known spellings fail with `LEDGER_MIGRATION_NONCANONICAL_ARTIFACT`;
multiple equivalent known entries fail with its `_AMBIGUOUS` variant before
reading any member. Unknown reserved entries fail with
`LEDGER_MIGRATION_UNKNOWN_ARTIFACT`. Other `<ledger>.*.tmp` / `*.stage` entries
fail with `LEDGER_MIGRATION_FOREIGN_STAGE`, including Windows suffix variants.
Entries outside these reservations remain unrelated. No arbitrary member is
chosen and no case rename is repaired automatically.

## Complete discovery and canonical-access audit

These are all production `readdir` sites in `server/`, plus their artifact
construction and fixed-path consumers. Unless specified otherwise, the
directory is `dirname(path)` and the Windows/POSIX distinction is supplied by
the shared helper's default `process.platform`.

| Module / function | Directory | Names / patterns | Comparison and platform | Decision / canonical access |
|---|---|---|---|---|
| CleanLedgerV1Migration.assertMigrationNamespace / migrationArtifacts | Ledger parent | Eight known suffixes; reserved `.migration`; ledger, WAL, bootstrap; `.tmp` / `.stage` | Shared ASCII key on Windows, exact on POSIX; known spelling remains exact | Reject aliases, collisions, unknown and foreign staging before canonical reads |
| CleanLedgerV1Migration.migrationIntentStageEvidence | Ledger parent | Canonical `.migration.intent.stage` | Same namespace assertion, then exact expected path | Opaque hash/length capture only; no decoding or ownership inference |
| CleanLedgerV1Migration.migrationPath / durable / view / guard | Ledger and authority parents | Canonical stage/destination, ledger, lock, WAL, bootstrap, authority and Scheduled lock | Fixed construction; reads through PersistentEvidence guard; repeated owner/authorization checks | Preserve legacy-lock refusal and exact prefix/order/durability checks; no alias adoption |
| CleanLedgerV1Migration.assertMigrationStartup | Ledger parent | Same known migration set, complete intent/activation/completion | Delegates migrationArtifacts; exact bytes and identity | Runtime writers refuse unresolved or ambiguous migration before acquiring writer lock |
| RecoveryNamespace.assertCanonicalPath | Parent of any evidence path | One expected basename and any equivalent entries | ASCII collision key; Windows resolving path also requires actual exact entry spelling | Reject noncanonical/multiple known entries before reading; absent parent remains optional |
| PersistentEvidence.readEvidence | Parent of evidence path | Expected basename supplied by caller | Uses assertCanonicalPath before lstat/readFile; POSIX exact | Shared read boundary for recovery, Ledger v2 and reconciliation; bytes untouched |
| RecoveryWorkflow.autoEvidence | Authority parent | `<authority>.reconciliation-<id>.json` | Windows namespace prefix/suffix; canonical fixed tokens required; duplicate equivalent candidates rejected | Read actual canonical candidate, then expected `.completed` and stored archive through guarded artifact; retain provenance and multiplicity checks |
| ScheduledExecutionProvenance.assertScheduledTerminalNamespace | Scheduled journal parent | `.lock`, `.lock.quarantine-<id>`, `.reconciliation-<id>.json[.completed]` | Shared key for membership/duplicates; original fixed tokens required; ID grammar permits ASCII upper/lower | Reject unknown, altered fixed spelling and duplicates; canonical journal/lock checked |
| ScheduledEntryLedgerV2Protocol.inspectV2 | Ledger parent | Ledger/WAL; `<ledger>.*.tmp` / `*.stage`; pending transaction's exact stage | Shared Windows membership; exact expected pending filename, all stages checked before decoding | Reject canonical aliases, extra/noncanonical/multiple stages; never decode an arbitrary member |
| RecoveryContract.paths / artifact / capture | Studio, scheduler, media-library and maintenance parents | Fixed evidence names and migration paths | capture validates migration namespace before parallel reads; artifact delegates guarded evidence | Prepare and Start receive the same deterministic namespace decision, rather than competing encoding/alias errors |
| RecoveryLineage / ControlledStart / OfflineDisarm | Recovery audit / configuration parents | `.prepared`, `.disarm`, `.disarm.completed`, `.start`, `.ready`, `.restore-prepared`, `.restore-completed` | Fixed canonical paths via artifact/writeOnce; evidence guard before existing-path access | Reject aliases before accepting phases; exclusive creation cannot silently adopt an existing alias |
| RestoreLedgerAuthority.ledgerAuthority | Ledger / authority parents | Snapshot, WAL, bootstrap, migration decisions, authority | migrationArtifacts and inspectV2, then guarded readEvidence | Discovery and complete/current authority access agree; exact READY WAL prefix preserved |
| ScheduledEntryRuntime.initializeEntryLedger | Ledger parent | Snapshot, migration artifacts, WAL/bootstrap existence | migrationArtifacts supplies namespace error; selector retains it and fails closed | Never turn a migration namespace error into legacy fallback or bootstrap permission |
| ScheduledEntryLedgerRepository / ScheduledEntryLedgerV2Repository startup | Ledger parent | Lock, bootstrap, snapshot/WAL and migration completion | Shared assertMigrationStartup before writer acquisition; v2 ordinary reads use guarded evidence | No execution from ambiguous migration state; canonical writes remain fixed |
| ReconcileScheduledEntryLedgerV2 / ledgerRecoveryEvidence | Ledger, authority, Scheduled parents | Fixed originals; `.recovery-<id>.json[.completed]`, `.lock.reconciled-<id>` | Expected canonical paths via guarded readEvidence / v2 ordinary; staging via inspectV2; Scheduled namespace assertion | Reject aliased expected evidence/archive/audit; immutable exclusive creation, exact provenance and fresh checks remain |
| ReconcileAuthorityLock / ReconcileScheduledExecutionLock | Authority / Scheduled parents | Original lock/journal; generated `.lock.reconciled-<uuid>` or `.lock.quarantine-<id>` and `.reconciliation-<id>.json[.completed]` | No enumeration; fixed paths, guarded readEvidence and exclusive audit creation; Workflow later discovers/validates audit | No alias evidence adoption; immutable operation identity and fresh lock/byte checks remain |

Path strings embedded in sealed evidence, repository identity, schema fields,
operation IDs and hashes are not case-normalized by this helper. Their existing
protocol validations remain separate from directory-name membership.

## Permanent regressions and byte preservation

`test/windows-migration-namespace.test.js` includes the exact paired sequence:
clean v1, malformed lower-case unknown stage, blocked Prepare, case-only rename,
same NTFS file ID and bytes, blocked Prepare again. It asserts unchanged v1,
absent intent/Prepared/WAL/Start/READY, zero host reservations and service changes.
Prepare cannot reach a runtime launcher through this rejected preflight.

The same test on the unchanged R26 candidate is RED: the second Prepare does
not reject. `tmp/r27-review/red.log` records the missing expected rejection.
The final result is recorded separately in the permanent-test log.

All eight known suffix aliases are tested against Prepare and migration Start,
with malformed bytes rejected by namespace before interpretation. A separate
foreign-identity intent alias remains unchanged and cannot be adopted. Prefix,
suffix, temporary, missing-separator and unrelated cases are covered.
Canonical snapshot/WAL/bootstrap case aliases and a resolving Unicode evidence
alias are rejected. Scheduled terminal reserved tokens are covered too.

Canonical + variant and reversed enumeration order are tested with synthetic
directory entries: ordinary case-insensitive NTFS cannot store both names.
The classifier accepts enumerated entry arrays, so these are direct production
collision checks without changing directory case-sensitivity or storage policy.
The POSIX test deliberately preserves distinct case-sensitive entries.

R26's permanent partial-staging suite remains unchanged and exercises canonical
ASCII and torn two/three/four-byte intent prefixes, random/wrong/foreign prefixes,
strict complete artifacts, authorization fences and shared Start resumption.
R27 does not decode staging or normalize content. SHA-256, strict UTF-8 and JSON,
raw byte-prefix checks and R20/R22/R24 final authorization remain authoritative.

## Validation and preservation evidence

Final per-file gate results, logs, the isolated-candidate manifest, syntax and
whitespace checks, and before/after preservation evidence are in
`tmp/r27-review/`. Focused and broader file manifests are disjoint; each final
test is counted once. Obsolete development executions and the intentional RED
run are excluded. The final report supplies the completed totals.

Completed results: **369 focused + 1,074 broader = 1,443 distinct tests passed**
across 62 files, with no skips. The new namespace suite is 20/20 and the unchanged
R26 suite is 13/13. The first tooling run had one child-process liveness failure
(83/84). Its unchanged isolated test passed, and the unchanged complete suite
then passed 84/84. The cause of the first failure is not established; both logs
are retained. The final tooling result replaces the original result in the
distinct count, rather than adding another 84 tests.

Candidate testing overlays R3–R27 into fresh TEMP copies of HEAD. The five H1
changes are excluded; their tracked baseline versions are used and the H1-only
support file is absent. Verified native helper bytes are copied, host/services
are fixtures, and neither real `.env` nor real `var/` is copied. Existing
R25-A2 review artifacts are untouched.

REAL V1 ORPHAN = LEGACY_LEDGER_LOCK_UNVERIFIABLE.
The real lock is not deleted, archived, migrated or reinterpreted. R27 does not
authorize a real recovery run, service change, runtime start, staging, commit
or push. R25-A must be restarted as an independent review of the resulting
candidate; it has not been completed by implementation testing.
