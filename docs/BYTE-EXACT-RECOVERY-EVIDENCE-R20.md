# R20: exact persistent evidence

This uncommitted candidate changes evidence interpretation, not the semantic
Ledger-v2/WAL protocol. It does not authorize operating on the real installation.

## Identity and decoding contract

`PersistentEvidence.capturedEvidence(Buffer)` computes SHA-256 and length before
interpretation. `readEvidence` reads the pathname once into a Buffer; that same
Buffer supplies the digest, strict text, and optional JSON value. Ordinary-file,
symlink, size, and optional-absence checks remain fail closed. A fresh capture is
required at existing mutation fences. The abstraction does not claim an atomic
filesystem transaction against an uncooperative external writer after a fence.

Node v24.15.0 provides `node:buffer.isUtf8`. It rejects truncated sequences,
invalid continuation bytes, overlong sequences, UTF-8 surrogate encodings and
codepoints beyond U+10FFFF. Only after validation does `Buffer.toString('utf8')`
run. Unlike BOM-stripping decoder defaults, this preserves U+FEFF. JSON.parse
rejects a leading BOM; byte identity always distinguishes it. No line-ending,
Unicode, whitespace, key-order, or replacement normalization occurs.

RecoveryContract.artifact keeps its existing `{hash,value}` diagnostic API.
Invalid UTF-8 throws. Valid UTF-8 which is not a single JSON value returns the
existing `{invalidJSON:true}` diagnostic, required for WAL capture and inspection
of corrupt state. That sentinel is not validated protocol input. Authoritative
JSON readers separately parse and validate schema before admitting writes.

Byte identity binds captured files, phase predecessors, exact persisted
provenance, expected operator hashes and pre/post mutation rechecks. Semantic
identity binds deliberately canonical JSON structures: envelope checksums,
WAL checksums/previous links, snapshot generation/END hashes, immutable
transaction identity, entry identity and normalized repository pathname.
Semantic equality never substitutes for a file evidence fence.

Some protocol records deliberately embed original strict UTF-8 text: migration
original/authority/marker bytes, Ledger recovery lock/WAL text, READY WAL prefix.
The validated decoder is invertible: Buffer.from(text,'utf8') is the original
captured bytes, including BOM and whitespace. Existing serialized field types
and hashes therefore remain valid without a compatibility fallback. Comparisons
of such strict strings remain byte-exact. Digests newly captured from storage
are supplied directly by the shared Buffer capture. Hashing a generated JSON
serialization or a validated embedded string is not hashing lossy file input.

## Affected-call-site audit

The read and hash columns below describe the final candidate. “Before” identifies
the permissive decoding removed by R20. Consumers which already use shared
artifact/ordinary are included even when their source did not require edits.

| Module / function | Persistent artifact | Read representation / before | Hash representation | Semantic parsing | Consumer | Protected mutation |
|---|---|---|---|---|---|---|
| PersistentEvidence / capturedEvidence, readEvidence | All callers' artifacts | One Buffer; optional strict text/value | Exact captured Buffer | isUtf8, optional JSON.parse | Shared evidence boundary | Existing caller fences |
| RecoveryContract / artifact, capture | AutoLive, authority/lock/gate, Scheduled/lock, Schedule, Ledger/lock/WAL/bootstrap, PROGRAM, maintenance, media manifest/delete journal, migration metadata | Buffer; before JSON.parse(Buffer) could replace invalid UTF-8 | Exact Buffer already before R20 | Strict UTF-8, JSON or diagnostic sentinel | Workflow/Start/Restore/Disarm/lineage | All offline phase mutations, launch and configuration restore |
| RecoveryWorkflow / load, inspect, preflight, offline | Audit, phase records and capture keys | artifact | artifact.hash | Schema, head/run/root and evidence equality | Prepare/reserveStart/restoreReview/restore | Intent creation, reconciliation, service configuration restore |
| RecoveryLineage / lineageContext | Audit | artifact; load checked against same captured parsed value | auditHash from artifact bytes | Immutable audit context | phaseChain | Phase authorization |
| RecoveryLineage / phaseChain, validatePhase | Prepared, Disarm, Disarm.completed, Start, READY | artifact | predecessorHash from artifact bytes | Exact lineage and phase schema | Workflow, ControlledStart, OfflineDisarm | Disarm, launch, READY, Restore; legacy stays review-required |
| OfflineDisarm / offlineDisarm | AutoLive, authority lock, Disarm plan/completion | artifact; AutoLive store uses strict Buffer | Captured raw hash; planned output hash is generated JSON UTF-8 | normalizeConfig and lineage | Explicit offline Disarm | AutoLive replacement, completion |
| ControlledStart / controlledStart | Reservation, phase chain, readiness evidence | artifact/capture, strict runtime readers | Captured byte hashes in before/READY | Readiness/runtime schemas | Controlled launch/READY | Launch and readiness record |
| RestoreLedgerAuthority / ledgerAuthority | Ledger canonical, WAL, bootstrap, authority, migration records | readEvidence; old local round-trip check already rejected invalid encoding | canonicalHash/walHash/markerHash from captured Buffers | Ledger envelope/WAL/marker/migration validation | verifyRestoreAuthority | Configuration-only Restore |
| RestoreLedgerAuthority / verifyRestoreAuthority | READY anchor/WAL prefix | Strict captured text embedded in record; no reopen for digest | Embedded UTF-8 prefix hash, current raw capture hashes | Validated chain, lineage, successor and subset semantics | Workflow restoreReview | Restore cannot adopt a fork/rollback |
| ScheduledEntryLedgerV2Protocol / ordinary | Canonical, WAL, locks, staged files, audits | Buffer then strict text, or raw Buffer for partial stages; before readFile(utf8) | Shared capture SHA; existing strict string comparisons are invertible | Caller JSON.parse / parseWal | V2 runtime, reconciliation, shutdown | Startup, install, consumption, END, archival |
| ScheduledEntryLedgerV2Protocol / envelope, seal, parseWal | Envelope and WAL records | Strict ordinary text | Deliberate canonical payload SHA, previous checksum chain, snapshot SHA | Exact schemas, chain, generation, pending transaction | inspectV2/recoverV2 | Conservative crash recovery; protocol unchanged |
| ScheduledEntryLedgerV2Repository / initializeOnce, verifySnapshot, verifyTerminal | Canonical, WAL, original writer lock | ordinary strict text | Semantic snapshot/WAL seals; startup text fences exact | Envelope, original owner, terminal END | Runtime repository | Writer acquisition, intent/install/commit, shutdown |
| ScheduledEntryLedgerRepository / initializeOnce, readSnapshot | V1 canonical | Buffer; before readFile(utf8) | Shared capture SHA; legacy contract uses snapshot validation | Strict JSON, validateLedgerSnapshot | Legacy repository | Legacy consumption and downgrade prevention |
| ScheduledEntryRuntime / initializeEntryLedger | Canonical selector, migration metadata | Buffer; before readFile(utf8) | Capture SHA computed before selector interpretation | Strict JSON protocol selector; migration checks | Startup | Bootstrap must not normalize corrupt input |
| ReconcileScheduledEntryLedgerV2 / ledgerRecoveryEvidence | Ledger/lock/WAL/bootstrap, authority/lock, Scheduled/lock | readEvidence; before ordinary permissive strings | Exact Buffer SHA | Text from same captured Buffer parsed by reconciler | Expected evidence, verifyExternal, post-archive fence | Recovery, Ledger lock archive, completion |
| ReconcileScheduledEntryLedgerV2 / reconcileScheduledEntryLedgerV2 | Prior audit/archive/completion | ordinary strict text; final hash readEvidence | Raw audit/canonical/WAL SHA; original strict lock text hash invertible | Lock provenance, terminal proof, coherent history | Explicit offline reconciliation | Archive and COMPLETED |
| ReconcileScheduledExecutionLock / capture, ordinary, reconciliation | Scheduled journal/lock/archive, authority/lock, audit/completion | readEvidence; before local readFile(utf8) | Captured raw SHA for all expected fields and audit | Lock/journal/authority schemas; strict text rechecks exact | Workflow Prepare | Scheduled lock quarantine and completion |
| ReconcileAuthorityLock / reconcileAuthorityLock | Execution epoch and writer lock | readEvidence JSON; before readFile(utf8) | Raw SHA at capture and final fence | Epoch/session/owner validation from same Buffer | Canonical AutoLive reconciliation module | Authority lock archive and completion |
| ScheduledExecutionProvenance / journalMatchesLock, completedScheduledHistory | Scheduled journal | capturedEvidence on Buffer or already strict captured text; before JSON.parse(Buffer) permissive for Buffer callers | Captured raw SHA | Journal/provenance/inner transaction validation | Reconciliation and terminal shutdown | Archive/END cannot rely on replacement-decoded history |
| ScheduledExecutionProvenance / journalEnvelope, repositoryIdentity | Stored journal schema, repository identity | Validated values/path | Deliberate canonical journal/transaction SHA and normalized path SHA | Strict journal schemas | Runtime repositories | Semantic provenance unchanged |
| ScheduledLiveExecutionRepository / initializeOnce | Scheduled journal | Bounded handle-read Buffer, capturedEvidence; before toString then JSON.parse | initialJournalHash from same Buffer SHA (already raw previously) | Strict JSON and validateJournal | Scheduled hydration | Admission/lock installation |
| ScheduledLiveExecutionRepository / writeOnce, close | Scheduled writer lock | Buffer strict text; before readFile(utf8) | Exact strict text equality against generated lock bytes | Original session | Journal writer/shutdown | Replacement lock cannot be removed through decoding collision |
| BrowserExecutionOwnership / initialize | Execution epoch | Buffer strict JSON; before readFile(utf8) | Shared raw capture SHA | Safe positive epoch | Authority startup | Epoch increment/replacement |
| AtomicAutoLiveStore / hydrate | AutoLive configuration/recovery state | Buffer strict JSON; before readFile(utf8) | Shared raw capture SHA; recovery evidence separately artifact | normalizeConfig / normalizeRecoveryState | OfflineDisarm and runtime | No hydrated replacement document may authorize state writes |
| ScheduleStore / hydrate | Schedule | Buffer strict JSON; before readFile(utf8) | Shared raw capture SHA; artifact fences separately | normalizeSchedule, controlledSchedule, identity migration | Startup scheduler | Identity migration persistence and schedule admission |
| DurableProgramRepository / load | PROGRAM | Bounded handle-read Buffer strict JSON; before toString | Shared raw capture SHA; artifact/READY hashes raw | validateRecord (canonical checksum deliberate) | PROGRAM continuity/readiness | Corrupt PROGRAM cannot be adopted |
| CleanLedgerV1Migration / ordinary, migrationArtifacts | Intent/activation/completion, raw incomplete stages | readEvidence strict text; stages deliberately raw Buffer; old round-trip check already strict | Capture raw SHA; stage prefix/equality raw bytes | Completion/schema/checksum required before startup | Migration/startup/Restore | Resume/promotion cannot decode-repair incomplete stages |
| CleanLedgerV1Migration / view, validateMigrationIntent | V1 original, bootstrap, authority, target | Same captured Buffer gives strict text and captured hash | Original/marker/authority raw SHA; target SHA generated exact JSON UTF-8 | Strict JSON, snapshot, semantic signed intent and transaction seed | Migration guards | Base/canonical activation/completion |
| CleanLedgerV1Migration / decision, validateMigrationCompletion | Activation and completion records | Strict captured text | Deliberate canonical sealed intent SHA; exact generated record byte comparison | State/transaction linkage | assertMigrationStartup | Execution remains forbidden before full completion |
| MediaAssetRepository / initialize, recoverDeleteJournal | Media manifest and delete journal included in recovery evidence | Buffer strict JSON; before readFile(utf8) | Shared capture SHA; artifact evidence raw | Existing manifest/delete schemas | Runtime media readiness/deletion | Corrupt metadata cannot be replacement-decoded into deletion input |
| WindowsLedgerDurability / verifyHelper, verifyGate | Native EXE/DLL | Raw Buffer | Exact pinned Buffer SHA already | PE header/protocol checks | Native durability abstraction | Trust before native storage mutations |
| FFmpegHealthWorker / backend proof and output | Backend binary/media bytes | Raw Buffer | Exact raw SHA already | Binary/media validation | Health backend | Outside recovery fence; unchanged |

## Deliberate exclusions

The repository-wide read/decode/hash search is retained in
`tmp/r20/all-read-audit.txt`; the critical caller search is
`tmp/r20/critical-call-sites.txt`. HTTP request bodies, child-process stdout,
ordinary public config and .env reads are not captured persistent evidence.
Studio presentation state, logo/preview/reference-client registries and the
separate manual action journal do not supply R3–R18 recovery byte identities;
their unrelated reader APIs are unchanged. Media binary signature checks are
binary interpretation, not UTF-8 evidence decoding. Protected H1 files are
excluded from all edits and candidate overlays.

## Permanent regressions and verification

`r19-byte-evidence-regression.test.js` preserves the exact original PREPARED
injection, literal U+FFFD → single FF mutation, 1466→1464 byte lengths, and equal
replacement-decoded text. It requires rejection, unchanged Ledger/WAL/lock,
absent archive/completion, retained PREPARED and unchanged damaged journal.
Six additional protected-journal byte changes exercise the same mutation fence.
The test fails against the R18 TEMP baseline and succeeds on R20.

`byte-exact-recovery-evidence.test.js` covers exact digest/length/text, BOM policy,
line endings, whitespace, JSON key order, Unicode normalization distinctions,
one captured buffer across pathname replacement, malformed UTF-8 classes,
all recovery capture keys, malformed JSON diagnostics, phase predecessor
formatting changes and authoritative reader refusal without protocol replacement.

Final gate counts, preservation evidence and the 21-point report are recorded in
`tmp/r20/FINAL-REPORT.txt` and `tmp/r20/test-results.json`. Repeated focused runs
are not added to distinct totals. Native suites use OS TEMP and the already
approved pinned helper/DLL; injected directory ACK unit fixtures make no native
durability claim. Real v1 orphan status remains
`LEGACY_LEDGER_LOCK_UNVERIFIABLE`; this work grants no new execution era.
