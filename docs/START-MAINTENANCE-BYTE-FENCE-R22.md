# Start maintenance evidence fence

Start authorization requires both semantic maintenance validity and the exact
SHA-256 of the persisted bytes captured for that attempt. JSON equivalence never
substitutes for byte identity. No maintenance-specific hashing implementation is
introduced.

`paths(root).maintenance` is `var/authority-maintenance-service.json` under the
reviewed repository root. `capture` calls `artifact`, which calls the shared
`readEvidence` primitive. One captured Buffer supplies strict UTF-8 interpretation
and SHA-256; JSON parsing derives from that capture. Whitespace, key order and line
endings remain significant. BOM produces an invalid maintenance JSON record and
semantic rejection, rather than being normalized away.

The initial `startReview` stores `{hash,value}` as `h.evidence.maintenance` after
host, semantic maintenance, phase-lineage, disarm, authority, Schedule, PROGRAM,
Scheduled and ledger checks. This attempt-local snapshot is retained across the
host reservation and maintenance gate. A reservation retry additionally compares
the entire current evidence with its durable `start.before`.

| Boundary | Revalidation | Following operation |
| --- | --- | --- |
| Initial Start review | Semantic maintenance; captured raw hash | Host reservation |
| Inside reserved offline review | Full evidence, service, media and review equality | Exclusive maintenance gate acquisition |
| Every migration authorization callback | Fresh preflight semantics and host/media; phase-chain byte identity; maintenance hash vs initial snapshot; frozen lock/media identities; disarmed AutoLive hash; stable authority/Schedule/PROGRAM/marker/Scheduled hashes | Migration stage open, stage writes or native durable install |
| After migration, or non-migrating Start | Maintenance and frozen lock/media identities; phase chain; disarm; stable authority/Schedule/PROGRAM/ledger/WAL/marker/Scheduled; absent authority/Scheduled locks; semantic maintenance | Exclusive START_RESERVED creation |
| Reserved retry | Full evidence and review equality, including maintenance and all migration artifacts | Read-only return of original reservation |
| Controlled launch | Phase chain and complete evidence equality with `start.before`, checked again after `before-controlled-launch` | Synchronous launch invocation |

R21's missing check was the migration callback: fresh preflight was discarded,
while `assertStable` omitted maintenance. Its final semantic adoption likewise
allowed the changed artifact to become the new reservation baseline. R22 binds
both boundaries to the original attempt's captured maintenance hash. Changes
before intent creation reject with the original V1 ledger and no intent/WAL/
activation/completion/reservation. Changes after migration completion reject the
reservation while preserving completed migration; durable state is never rolled
back.

Other Start evidence: recovery audit, Prepared, Disarm and its completion use
`phaseChain` with captured audit/predecessor hashes and schemas. AutoLive uses the
disarm completion's exact `afterHash`. Schedule, PROGRAM, authority, Scheduled
and bootstrap marker use `assertStable` hashes as well as semantic validators.
Ledger and migration artifacts evolve intentionally: `CleanLedgerV1Migration`
guards original/target ledger identity, sealed intent, native capability and
coherent staged/base/activation/completion records before writes/installations.
R22 does not incorrectly freeze those evolving bytes. The audit found one
equivalent omission: a created intent could be reformatted after `after-intent`
while retaining its semantic checksum, before WAL creation. Start now retains
an adopted intent's captured hash; for a new intent it computes the expected hash
from the exact writer Buffer using `capturedEvidence`, and rejects a different
persisted intent before dependent writes. No existing bytes are normalized for
comparison. A permanent regression confirms rejection before WAL or V2 install.
Lock and media evidence is
now also held to the Start attempt's snapshot at dependent authorization points.
Complete reservation and launch comparisons include every captured artifact.

Prepare, Disarm, Restore and terminal reconciliation continue using shared raw
evidence. Prepare's reserved comparison covers the full capture; creation/adoption
of maintenance has its own semantic contract. Disarm compares maintenance evidence
including its hash in lineage rechecks. Restore compares complete captured evidence
and phase records before service configuration changes. Terminal reconciliation
binds expected/prepared journal and ledger hashes, including invalid-UTF8 rejection.
These phases are not redesigned by R22.

Permanent tests cover initial exclusive recheck, the real post-recheck
`migration-before-intent` boundary and the post-completion/pre-reservation boundary.
They exercise whitespace, formatting, CRLF, key order, BOM and semantic changes,
plus appearance of authority/Scheduled locks and media manifest/delete journal,
and a byte-only change to the newly created migration intent before WAL creation.
The original R21 TEMP probe and report remain review evidence only.

This change authorizes no operation on the real V1 orphan:
`LEGACY_LEDGER_LOCK_UNVERIFIABLE`. A new execution era remains separate work.
