# Scheduled execution provenance — 2C6R0

Scope: future Scheduled execution locks/journals and an offline module contract.
No production recovery, service changes, runtime start, or migration of existing
files is performed by this change. The old maintenance PowerShell script is not
upgraded or approved by this step. 2C6R1 orchestration remains separate work.

## Architectural gap

The legacy lock records only `version:1` and a random `processSession`. The old
transaction envelope has no relationship to that session or to canonical
execution ownership. Age, UUID shape, nearby timestamps and the current epoch
cannot repair this gap. Legacy bytes are never upgraded in place.

## New lock

`ScheduledLiveExecutionRepository` creates an exclusive `.lock` with:

| Field | Recovery purpose |
| --- | --- |
| `schemaVersion:2` | Reject unknown provenance contracts |
| `repositoryId` | SHA-256 of canonical absolute repository file path; case-folded on Windows |
| `processSession` | New UUID for this repository acquisition |
| `processId` | Actual Node `process.pid`; supports absent-owner checks |
| `authorityId` | SHA-256 identity of the canonical execution authority path; prevents cross-authority adoption |
| `authorityEpoch` | Actual execution ownership epoch |
| `authorityProcessSession` | Actual execution ownership process session |
| `createdAt` | Diagnostic UTC timestamp; never a stale-owner proof |
| `initialJournalHash` | Exact SHA-256 of the validated journal loaded at acquisition, or `null` for proven absence |

Repository identity is stable at one private canonical path, and different for
different paths. It is not a portable UUID: moving a repository or restoring a
copy to another path requires separate migration review. A checksum is an
integrity binding, not a digital signature or protection against an administrator
rewriting every piece of evidence.

The server passes its existing `BrowserExecutionOwnership` object. Initialization
awaits its `ready` promise and requires available, open ownership with a positive
epoch. There is no production fallback authority or invented epoch/session.
An existing lock of any schema remains blocking; startup never deletes it.
An interrupted creation can leave an empty/partial lock; it requires review and
is not eligible for either ordinary reconciliation or legacy quarantine.

## Journal and restart

The persisted envelope has `schemaVersion:2`, `provenance`, `transaction`, and a
SHA-256 `checksum` over the canonical outer payload. `transaction` retains the
existing validated non-executing transaction schema, captured PROGRAM and inner
checksum. The in-memory repository `record` interface is unchanged.

`provenance` contains repositoryId, processSession, authorityId, authorityEpoch,
authorityProcessSession and transactionId. Transaction identity is a SHA-256 of
the immutable capture tuple (event, source, capturedAt, manual-intent revision,
captured PROGRAM); it remains stable across phase transitions. It identifies a
capture value, not an execution permission or an additional ledger consumption.
PID is kept only in the lock: processSession links journal writes to that lock;
PID reuse is never treated as authority proof.

Startup validates both checksums and identities before hydration. A journal from
another repository/authority, a future epoch, or a different session at the same
epoch fails closed. Legacy journals produce `LEGACY_JOURNAL_REVIEW_REQUIRED`;
unknown or corrupt journals remain untouched and unavailable.

A valid earlier-epoch journal from the same authority domain is accepted only as
historical diagnostic data. Its bytes and original provenance remain unchanged;
the new lock binds those exact bytes using initialJournalHash. Reopening the
repository within the same canonical authority session also supports diagnostic
hydration. Neither path clears restart reconciliation or authorizes execution.

Each queued write checks canonical authority on entry and immediately before
atomic replacement, after checking the current lock bytes. Changed epoch/session,
closed/unavailable authority or replaced lock refuses the write. A replacement
lock is not removed by the old repository's close operation. Existing atomic
write/durability-uncertain behavior remains in place.

## Offline module contract

`ReconcileScheduledExecutionLock.js` has no CLI and is not invoked by startup.
Its real defaults use `proveWindowsOffline`, the existing authority maintenance
gate, exclusive reservation of port 8080 and native PID liveness checks. There
are no PID/path exceptions for Codex. Proof/reservation/liveness injection is
provided only as a module testing seam, not a runtime command-line bypass.

The caller supplies absolute repository and authority paths, an operationId and
reviewed expected values for lockHash, repositoryId, processSession, journalHash,
authorityHash and authorityLockHash. Absence is explicit `null`, not a missing
expectation. Symlink evidence and aliased parent paths are rejected.

For a new-schema lock the module requires:

1. Canonical offline census (including LivezoneNode Stopped/Disabled), exclusive
   maintenance gate and free/reserved port 8080.
2. Exact expected hashes and session/repository identity; recorded PID absent.
3. Preserved authority epoch and authority lock matching the Scheduled lock's
   authority domain, epoch, session and PID. AutoLive evidence must be retained
   until this independent check completes; this module never modifies it.
4. Journal absent only if initialJournalHash is null; otherwise a valid current
   session journal or the exact historical journal bound at acquisition.
5. A second census, repeated owner check and unchanged evidence before PREPARED.
6. Exclusive, flushed PREPARED audit; another census and complete evidence
   recheck immediately before archival.
7. Rename to the operation-specific archive, preserve bytes, verify post-archive
   evidence and write exclusive, flushed completion with lock/audit hashes.

The archive suffix is `.lock.quarantine-<operationId>` for both contracts; the
audit reason distinguishes `VERIFIABLE` from `LEGACY_UNVERIFIABLE`. An archive is
never substituted for provenance. No lock is silently deleted.

## Legacy quarantine contract

A valid v1 lock with no journal is `LEGACY_UNVERIFIABLE`, never normal proven
reconciliation. The same fresh offline proof, gate, port reservation, expected
hashes, exact legacy session, absence checks, PREPARED/rechecks/archive/completion
are required. Additionally:

- The caller must pass `authorizeLegacyQuarantine:true` explicitly. Future
  orchestration must expose this as a distinct operator authorization.
- The AutoLive authority lock must already be absent through its separate
  canonical handling; epoch evidence must remain present and hashed.
- Journal absence must hold on every pre-mutation recheck.
- The archived lock retains only its actual fields. No PID, epoch or timestamp
  is inferred or fabricated.

Any legacy lock with a journal returns `LEGACY_JOURNAL_REVIEW_REQUIRED`, even with
quarantine authorization. It requires separate manual design/review.

## Crash and retry

operationId deterministically selects audit, archive and completion paths. Retry
must supply the same expected evidence and matching prepared contract. An intact
PREPARED plus original lock can resume archival. PREPARED plus the exact archive
and absent original can complete. Matching completion is idempotent. Competing
lock/archive presence, orphan archive, changed evidence, partial/tampered audit
or inconsistent completion fail closed. No artifacts are overwritten.

An actual process exit can leave the canonical `.maintenance` gate. Retry must
stop there; this module never breaks that gate. Separate audited offline gate
resolution is required before resuming the same operation. Tests simulate actual
process exits at both PREPARED and archived boundaries, verify refusal, then
resolve only the temporary fixture gate and complete the retry. Thrown-error
tests additionally exercise both new-schema and legacy recovery paths.

## Compatibility and next step

No changes to D8/D9/D10 ownership/manual/restart rules, ledger consumption,
Schedule migration, AutoLive configuration, retained PROGRAM or service handling
are introduced. Provenance cannot authorize a TAKE. External consumers that read
the on-disk journal must now read the nested `transaction`; in-memory consumers
continue using `repository.record`.

2C6R1 tooling development can resume using these two distinct contracts, after
review. Real recovery remains unperformed and requires the complete orchestration
gates (explicit disarm, maintenance adoption, controlled bootstrap, migration
verification, readiness, restoration and canonical process census). This document
is not a command sequence authorizing real quarantine or startup.

Validation commands (all mutation fixtures use OS temporary directories):

```powershell
node --test test/scheduled-execution-provenance.test.js test/scheduled-live-execution-repository.test.js
$tests = @(rg --files test | Where-Object { $_ -match '(scheduled|scheduler|schedule-|autolive|browser-execution|durable-program|restart-reconciliation|program-commit|startup)' })
node --test --test-concurrency=4 @tests
git diff --check
```

The broader selection covers Scheduled repository/ownership/execution/persistence/
recovery, ledger/runtime, startup, migration, canonical census, durable PROGRAM,
manual precedence and browser restart reconciliation. Production-entrypoint tests
launch only isolated fixture servers with temporary persistence and test ports.

Validated on branch `build/1003.9A1`, HEAD
`06a0962e481c2f35a8c00b53a674a445383acb22` with this uncommitted change:

- New provenance tests: 48 PASS / 0 FAIL.
- Existing repository tests: 7 PASS / 0 FAIL.
- Broader 64-file selection, including these tests: 1222 PASS / 0 FAIL,
  zero skipped/cancelled. The three server persistence/TAKE/BLACK integration
  tests verify schema 2 and actual server authority/session binding.
- `git diff --check`: PASS. New untracked source/test/document files also checked
  with `git diff --no-index --check` (no whitespace errors).
- No production persistence, services, MediaMTX or production runtime modified;
  no commit or push. Existing unrelated working-tree changes preserved.
