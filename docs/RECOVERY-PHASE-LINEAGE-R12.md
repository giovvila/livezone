# Recovery phase lineage

The recovery audit remains version 1. Its SHA-256 byte digest is the immutable
lineage root: it binds the captured RunId, approved full HEAD, branch, canonical
repository root, maintenance evidence and authoritative before-state. Phase
records carry `lineage = {version:1, auditHash, runId, head, root, phase,
predecessorHash}`. Validation requires exact equality with the current context.
This is integrity linkage, not a signature or protection against an actor who
can rewrite every artifact coherently.

| Artifact | Producer / consumer | Required linkage and current checks |
| --- | --- | --- |
| Recovery audit | Begin / every phase | Existing root, branch, HEAD and RunId checks; bytes hashed for descendants |
| Prepared | Prepared / Disarm | Audit digest; expected state and HEAD; no bare presence authorization |
| Disarm plan | OfflineDisarm / completion | Prepared digest; exact path, authority, before revision/hash and deterministic after-state |
| Disarm completion | OfflineDisarm / Start | Plan digest; before/after hashes equal the plan; current AutoLive disarmed |
| Start | reserveStart / ControlledStart, Restore | Completion digest; expected HEAD, state, before-state; migration transaction and current evidence |
| READY | ControlledStart / Restore | Start digest; root, RunId, HEAD; R10 ledger identity, retained WAL prefix, marker and storage checks |
| Restore prepared | Restore / service mutation, retry | Last present validated phase, or audit for configuration-only cancellation; original service configuration |
| Restore completion | Restore / retry | Restore-prepared digest; identity, original service and current authoritative ledger revalidated |
| Migration completion | Migration / Start, Restore | Existing sealed intent digest and deterministic transaction ID, activation and completion; repository, original history and target ledger |
| Scheduled reconciliation | Reconciler / Prepared | Existing audit digest, lock digest, operation RunId, repository, authority epoch/session, archive and absent current lock |
| AutoLive reconciliation | Reconciler / Prepared | Existing captured owner, epoch, path, archive digest and matching completion |
| Maintenance | Begin / all offline checks, Restore | Exact captured/adopted maintenance identity and original service configuration |

Disarm validates lineage before acquiring exclusivity, again under the
maintenance gate and port reservation, after the prepared hook, immediately
before AutoLive rename, and before completion. The plan's own bytes cannot
change between validation and rename. Maintenance and authoritative evidence
are rechecked as well. Start validates its predecessor before migration and
inside the offline mutation section. Recovery-driven migration invokes the same
authorization callback under its reservation, before stage writes and native
installations; standalone migration retains its existing guards. ControlledStart verifies the persisted
Start record before launch and again before READY. Restore validates historical
lineage together with R10 current-state checks and repeats the review immediately
before SCM; completed retries remain read-only and revalidate current state.

Missing or inconsistent predecessors fail closed. A phase record without
lineage is `LEGACY_PHASE_RECORD_REVIEW_REQUIRED`; malformed, unsupported or
foreign lineage is rejected. No real artifacts are converted. Identical
legitimate Prepared/Disarm and migrated Start retries retain their existing
idempotency rules. Non-migrated Start reservations remain single-use.

R12 does not authorize real runtime/service actions or a new execution era.
The real orphan v1 remains `LEGACY_LEDGER_LOCK_UNVERIFIABLE`.
