# Prepare final authorization fence

Prepare authorizes both the semantic contract and the exact persisted identities
reviewed for that attempt. Shared `readEvidence`/`capturedEvidence` supplies the
SHA-256 and interpretation of one Buffer. No Prepare-specific hash primitive or
normalization is introduced.

The R23 gap was `prepareIntent` calling `prepareHeld()` without its existing
`authorize` callback. The previous review before that call could not fence changes
at `migration-before-intent` or during stage creation/writing/installing. It also
re-read maintenance to construct its expected snapshot, silently rebinding that
one artifact instead of retaining its earlier authorized identity.

| Operation | Class | Identity/authorization |
| --- | --- | --- |
| Host/repository/HEAD, offline proof, schemas, full evidence and migration/native review | A: read-only | Captured hashes, semantic validators and native capability |
| Host port reservation, exclusive recheck, authority maintenance gate | B: temporary/exclusive reservation | Complete evidence/review, service and media equality |
| Recovery audit creation and optional new maintenance creation | C: durable recovery metadata | Known approved values; `exclusive` returns evidence from the exact Buffer written |
| Final Prepare review after audit barriers | A | Original captured maintenance, or the exact authorized writer Buffer for newly created maintenance; immutable audit/phase/reconciliation identity |
| Migration guard and before-intent hook | A | Existing clean/resumable migration protocol and current trusted native abstraction |
| Authorization callback immediately before stage open | A | Fresh host proof and exact approved evidence, audit, phases and reconciliation proofs |
| Intent stage open/write/flush/install | D: durable migration mutation | Callback before open, after opened/partial hooks and before native installation; existing guard and byte-prefix/install validation |
| Final callback after prepareHeld and before Prepared metadata | A | Same retained snapshot and exact installed intent identity |
| Prepared phase write | C | Current audit lineage plus final authorization; no rollback of prior audit metadata |
| Runtime authority/AutoLive/Schedule/PROGRAM/ledger evolution | E: authoritative runtime/state mutation | Not performed by Prepare |

The first migration mutation is opening `ledger.migration.intent.stage` for
creation or resumption. The canonical durable intent appears only after native
installation. A mismatch before opening leaves both absent. A mismatch after
stage writes but before installation can retain a valid partial stage; no intent,
WAL/base, V2 installation or Prepared authorization is produced. Earlier audit
and authorized maintenance creation remain durable. The temporary gate and host
reservation are released normally; rejected attempts never roll back evidence.

`prepareIntent` supplies `authorize` to the existing `prepareHeld({authorize})`
contract and invokes it before and after that operation. Prepared invokes the
returned callback again after constructing its lineage context and before its
phase write. Host/HEAD/repository/service/media are freshly validated. All captured
non-migrating files remain identical: maintenance, AutoLive, Schedule, PROGRAM,
authority/Scheduled states and locks, ledger/WAL/marker, media manifest/delete
journal and non-evolving migration artifacts. Immutable recovery audit, Prepared,
Disarm completion and later phase records keep their captured hashes.

Only intent and intent stage may evolve during migration preparation. Existing
guards bind stages to exact expected byte prefixes and validate the installed
bytes before rename. An adopted intent retains its captured hash; a new intent
has a shared-primitive digest of the known writer Buffer. Installed intent byte
changes reject before Prepared. Native helper/capability/trust and migration
semantics remain enforced by the existing shared migration/durability abstraction;
the authorization callback does not duplicate those native operations.

AutoLive reconciliation audit/completion/archive evidence is returned from the
same captures used to validate it. Scheduled reconciliation likewise can return
the captured proof through an internal option, preserving its default boolean
API. Prepare snapshots these proofs and compares them at final authorization;
semantic equivalence of a reformatted proof does not suffice. No new reconciliation
protocol is introduced.

A rejected attempt can retry after a fresh canonical review. The tests explicitly
retain the audit, reject a still-conflicting repository, restore the authorized
maintenance bytes and complete Prepare/Prepared without rewriting the audit.
Legitimate partial intent stages resume through existing prefix rules rather than
being treated as fresh unreviewed history. Existing durable intent is preserved.

Prepare and Start share the same conceptual contract: validate semantics, capture
exact identity, revalidate at dependent mutation boundaries, and permit only
specified writer transitions. R22 Start maintenance/intent fences remain intact.
Disarm, Restore and terminal reconciliation continue using the R20 primitive.

Tests cover R23 RED-to-GREEN, six maintenance byte variants across Begin/Prepared
and pre-open/pre-install boundaries, other captured state, AutoLive proof bytes,
canonical retry, partial intent resume and post-install intent changes. BOM is
asserted invalid JSON and rejected, rather than considered semantic equivalence.

This change authorizes no real runtime/service/recovery action. The real V1 orphan
remains `LEGACY_LEDGER_LOCK_UNVERIFIABLE`; a new execution era remains separate work.
