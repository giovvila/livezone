# NEW-ERA-17: deterministic empty Ledger install stage recovery

## Protocol and narrow contract

The WAL parser validates its checksum chain, BEGIN owner, repository, Ledger,
transaction identity, previous generation/hash and complete INTENT.next with
next generation/hash before stage inspection. A sole stage must have the exact
pending transaction filename. Evidence readers require canonical names, valid
UTF-8 and ordinary files and reject directories and symbolic/reparse objects.

Previously, stage inspection parsed the zero bytes left by install/opened as
JSON. It failed before recoverV2 could use the durable pending snapshot.
Installation also rejected those zero bytes as a mismatch.

Inspection now recognizes that empty canonical stage as a pending install,
without interpreting it as snapshot evidence. Only recoverV2 supplies the
private capability that lets install resume it. Install re-inspects the pending
transaction and checks it against the reviewed transaction and supplied next
snapshot, then opens the existing file without truncation. The opened file must
be regular, have exactly zero bytes and have exactly one hard link. The caller
must hold the writer lock or audited canonical offline exclusivity, as before.
The only production recoverV2 caller remains reconcileScheduledEntryLedgerV2,
after its offline census, port reservation, maintenance gate, owner-death and
byte-bound authority/Scheduled/Ledger provenance checks.

## Bytes, durability and refusal behavior

The existing install expression, JSON.stringify(envelope(path,next)) plus its
newline, supplies both original and resumed bytes. No second production
serializer, new transaction, new Ledger or fabricated WAL history is added.
The opened/written/flushed/staged/before-replace/replaced/durable hooks and file,
directory and native replacement barriers are reused. COMMIT follows installation;
recovered END and the final Ledger/WAL durability barriers precede lock archival.

Non-empty partial, truncated, malformed, wrong or foreign stages retain their
existing rejection behavior. A wrong filename, alias, conflicting stage,
directory, reparse object, missing pending INTENT or multiply linked empty file
does not qualify. Direct install callers cannot enable the empty-stage exception.

A second interruption at the resumed opened checkpoint leaves the same empty
stage and can retry. Complete written bytes resume through the existing path.
Unexpected non-empty partial writes still fail closed; this change does not
generalize empty-stage recovery to corrupt data.

## Operator path and matrix meaning

Use the existing runbook step 5: inspect from a fresh process, prove all owners
absent and explicitly approve the current reviewHash for recover-start. Retain
the completed-owner authorization where applicable. Never delete a stage or
lock, fabricate records, change the transition authorization or launch again to
work around an uncertain outcome. PROGRAM and configured AutoLive are unrelated
state and remain unchanged by this recovery.

ledger-reconciliation/opened keeps its observed interruption classification
RECONCILIATION_PREPARED and reviewRequired=true because canonical dead-owner
recovery still requires explicit authorization. Its recoveryAction becomes
RECONCILED_IDEMPOTENT rather than BLOCKED_EMPTY_STAGE_REVIEW_REQUIRED; the final
recovery classification is RECONCILED. Counts remain 510 total, 157 true and
353 false. No new named mutation hook or durability transition is introduced.

This document does not authorize real execution or resume NEW-ERA-08B-B2.
