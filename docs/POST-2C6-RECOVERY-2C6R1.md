# Post-2C6 recovery tooling — 2C6R1

This is a proposed future operator runbook, not authorization or a record of a
real recovery. All validation in this step uses temporary fixtures. No real
DryRun, recovery, disarm, migration, bootstrap, service change or startup was run.
The uncommitted 2C6R0 changes remain in place.

## Architecture and entry points

`tools/livezone-authority-maintenance.ps1` is the visible PowerShell entry point.
It has separate Prepare, Disarm, Start and RestoreService modes, plus read-only
DryRun. `tools/recovery-maintenance.mjs` runs one bounded phase per Node process.
There is no automatic service start and no combined implicit disarm/start action.

The wrapper waits for AutoPlan's Node process to exit, then invokes the existing
`tools/reconcile-autolive-authority.mjs` directly. A parent Node orchestrator
would itself block the canonical subprocess census. No census exceptions, Codex
PID allowances or path whitelists were added. The existing canonical census now
also refuses zero or multiple LivezoneNode service rows (previously an empty
array could satisfy `every`).

Core modules in `server/recovery/`:

- RecoveryContract: paths, read-only inventory, maintenance classification,
  bootstrap planning, migration verification, runtime status and readiness.
- WindowsRecoveryHost: OS/git/service/port/environment observations, canonical
  census, dual-stack port reservation and configuration-only service restoration.
- RecoveryWorkflow: immutable run audit and independently gated phases.
- OfflineDisarm: explicit audited AutoLiveStore operation.
- ControlledStart: one foreground server instance and full readiness verification.

The only ledger repository change exposes its actual immutable `lockOwner` in
memory; the ledger lock schema, consumption and bootstrap semantics are unchanged.
Readiness uses a read-only **in-process** status surface over the actual owner
objects. No new HTTP endpoint, authentication exception, UI or disk status cache
is introduced. Healthz and a listening port do not prove readiness.

## Preconditions and paths

Mutating phases require Administrator, repository root, branch `build/1003.9A1`,
an explicit full `-ExpectedHead` copied from the reviewed recovery commit, clean canonical offline census,
LivezoneNode Stopped/Disabled, identified MediaMTX, port 8080 free/reservable,
ordinary evidence files and a nonconflicting maintenance record. Directory aliases
are refused. A remaining canonical maintenance gate requires separate review.

Paths use this repository's standard private locations: studio state under
`var/studio-state`, Schedule under `var/scheduler`, media under `var/media-library`.
Conflicting `.env`/process path overrides refuse controlled startup. Startup reads
`.env` only in the foreground process; it never writes it. Any configured bootstrap
environment key in `.env`, inherited process, user or machine environment is a
blocker; bootstrap permission is passed as a constructor argument instead.

Run audit: `var/recovery-<RunId>.json`. Exclusive sidecars record prepared locks,
disarm, start reservation, readiness and restoration. An existing run audit is
never blindly overwritten. RunId is restricted to letters, digits, underscore
and hyphen. This is a single-host workflow; local administrative modification of
all evidence is outside the checksum trust boundary.

## Maintenance adoption

Classifications are NEW_MAINTENANCE, ADOPTED_MAINTENANCE and CONFLICT. Adoption
requires an absolute matching repository, version 1 record, valid recorded HEAD
and timestamp, LivezoneNode identity, exact current PathName/StartName, recorded
Stopped state, valid original startup mode and valid delayed-start presence/value.
The current service must be Stopped/Disabled. An older recorded HEAD is allowed.

Adoption preserves the original record bytes, including Automatic/delayed
configuration. The new audit records the current HEAD separately. It grants no
trust to either old runtime lock. If no record exists, the tool records only the
observed configuration (currently Disabled); it never invents prior Automatic
settings. Original configuration uncertainty or identity conflicts require review.

## Lock orchestration

2C6R0's Scheduled reconciler is imported unchanged, with no PowerShell copy of
its logic. For a new-schema lock, Scheduled reconciliation occurs **before**
AutoLive archival, while canonical authority evidence is still present. For a
legacy v1 lock, canonical AutoLive handling occurs first, then the explicit
LEGACY_UNVERIFIABLE quarantine with no journal.

Expected lock hash/session, repository identity, journal hash/absence, epoch and
authority-lock hash/absence come from the preserved run evidence. The reconcilers
perform fresh census and immediate evidence rechecks. Both archives, PREPARED
audits and completions are independently verified. AutoLive's CLI and audit
format remain unchanged. The legacy Scheduled archive retains original bytes;
no PID/epoch provenance is reconstructed. Legacy plus journal always stops with
LEGACY_JOURNAL_REVIEW_REQUIRED.

## Disarm and bootstrap

Disarm is a separate explicitly authorized operation requiring the reviewed
AutoLive revision/hash. It uses `AutoLiveStore.patch({armed:false}, revision)`;
enabled and source remain unchanged, and an armed config advances exactly one
revision. It uses offline proof, canonical maintenance gate, port reservation,
before/after audit and a final hash/proof check before the store's atomic rename.
It does not require source rebinding because it changes no source reference.
An already-disarmed config is explicitly audited without an unnecessary revision.

Startup requires separate start authorization and, when the ledger is absent,
bootstrap authorization. Marker-only, ledger-lock, journal-conflict or incomplete
existing migration metadata states refuse startup. A valid existing ledger is
opened without bootstrap permission even if the bootstrap switch was supplied.

The permission is a boolean constructor argument for exactly one server instance,
not an environment change. An exclusive `.start` reservation prevents reusing the
same attempt. The service remains Disabled. The Node process runs in the current
visible terminal with logs and graceful Ctrl+C handling. MediaMTX is untouched.
Native authority locking still arbitrates startup after the final offline proof.

## Migration and readiness

Only ScheduleStore performs migration. Verification compares the actual before
snapshot to the persisted after snapshot: v2 revision N must become v3 revision
N+1, with unchanged original event payloads and Program plan, valid incarnationId,
entryRevision 1, consistent cutoff within this startup, exact original windows,
and EXCLUDED/FUTURE classifications according to each original start time. The
known historical event needs no hardcoded eventId. With the known baseline this
means v2/50 -> v3/51 and EXCLUDED for the already-past LIVE event.

Full readiness requires:

- Current unique process/authority: fresh process census, all 8080 listeners
  owned by this PID, matching lock/session and epoch advanced exactly once.
- Scheduled repository READY with its actual new lock owner and no journal.
- Schedule READY, v3, identical in memory/on disk, migration verified.
- Ledger READY, checksum-valid file matching memory, actual lock PID/session
  matching this instance and consistent bootstrap marker. First bootstrap must
  contain zero consumption records; reopening preserves ledger/marker hashes.
- AutoLive still disarmed, with unchanged post-disarm bytes and matching memory.
- Retained PROGRAM bytes, durable identity and in-memory envelope preserved.
- Restart reconciliation still required and surfaced, plus operational Scheduled
  diagnostics. No TAKE or automatic reconciliation is performed.

The status surface is evaluated from the live controlled process. A failed check
does not emit readiness, kill the server or roll back durable state. Readiness is
a point-in-time proof, not permission to ignore later operator changes.

## Failure and retry matrix

| Interruption | Behavior |
| --- | --- |
| After adoption | Same RunId can resume; original record/audit remain intact |
| AutoLive PREPARED, original lock remains | STOP AUTOLIVE_PREPARED_REVIEW_REQUIRED; canonical CLI has no audited resume contract |
| AutoLive archived, completion missing | STOP AUTOLIVE_ARCHIVAL_REVIEW_REQUIRED; never fabricate completion |
| Scheduled PREPARED | Same RunId can resume through the 2C6R0 contract after fresh proof |
| Legacy archive, completion missing | Same RunId can validate the archive and finish its completion |
| Disarm persisted, completion missing | Exact planned after-state can complete audit without another revision |
| Start reserved, before actual launch | No automatic second attempt with this RunId; inspect actual state |
| Process started, before migration | No automatic restart; preserve authority evidence/epoch |
| Migration persisted, before ledger | Preserve v3/revision and exclusion metadata; review startup state |
| Marker-only | Fail closed; no marker deletion or bootstrap retry |
| Ledger created, before readiness | Preserve ledger and marker; no success declaration or recreation |
| Service restore partially applied | Stop for review against original record/restore PREPARED audit; no rollback/start |

A real process exit may leave `.maintenance`. Neither this workflow nor its
retries delete that gate. Resolve it through a separate audited offline review
before attempting a supported retry. Use DryRun to inspect actual evidence.
Do not change RunId to bypass an interrupted start; a new attempt requires review
of the actual locks, epoch, migration, ledger and marker first. Never roll back
epochs, migration or durable consumption records.

## Proposed REAL runbook — not executed

After code review, use a visible **Administrator PowerShell outside Codex**. End
any runtime/tool entrypoints that the canonical census reports as ambiguous.
Do not change classification rules or whitelist a PID to get past that refusal.
Keep all real services in their currently known state; the tool requires
LivezoneNode Stopped/Disabled and never stops MediaMTX.

```powershell
Set-Location -LiteralPath 'C:\Projects\livezone-broadcast-engine-x'
$runId = 'post2c6-20260930-01' # new reviewed operation identifier; reuse only for supported phase retries
$expectedHead = '<FULL_40_HEX_SHA_OF_REVIEWED_FIX_COMMIT>' # literal from review; never auto-approve git rev-parse HEAD
$review = .\tools\livezone-authority-maintenance.ps1 -DryRun -ExpectedHead $expectedHead -RunId $runId | ConvertFrom-Json
$review | ConvertTo-Json -Depth 40
```

Stop if branch/HEAD, service identity/configuration, canonical census, ports,
maintenance classification or evidence differ from the reviewed baseline. Confirm
legacy v1 Scheduled lock, absent journal/ledger/marker, epoch 20, Schedule v2/50,
AutoLive enabled/armed with the intended source. DryRun never resolves blockers.

After reviewing those exact observations, explicitly authorize only the required
legacy quarantine and lock preparation:

```powershell
.\tools\livezone-authority-maintenance.ps1 -Mode Prepare -ExpectedHead $expectedHead -RunId $runId -AuthorizeLegacyQuarantine
```

This does not disarm or start. Then explicitly authorize the armed-state change
using the reviewed revision/hash; any intervening AutoLive change must fail:

```powershell
.\tools\livezone-authority-maintenance.ps1 -Mode Disarm -ExpectedHead $expectedHead -RunId $runId -AuthorizeDisarm `
  -ExpectedAutoLiveRevision $review.evidence.auto.value.revision `
  -ExpectedAutoLiveHash $review.evidence.auto.hash
```

Then authorize exactly one foreground startup and its first ledger bootstrap:

```powershell
.\tools\livezone-authority-maintenance.ps1 -Mode Start -ExpectedHead $expectedHead -RunId $runId -AuthorizeStart -AuthorizeBootstrap
```

Keep this terminal open. Success requires `CONTROLLED START VERIFIED` and the
full ready evidence, not healthz. Expect epoch 21, v3/51, disarmed AutoLive,
retained PROGRAM and RESTART_RECONCILIATION_REQUIRED. Do not clear that requirement
as part of this workflow. On failure, preserve the terminal logs and all evidence.
The manual server may remain running; Ctrl+C drains it. Do not start a second one.

For later service configuration restoration: Ctrl+C in that terminal, wait for
the Node process to exit and locks to drain, then run:

```powershell
.\tools\livezone-authority-maintenance.ps1 -DryRun -ExpectedHead $expectedHead
.\tools\livezone-authority-maintenance.ps1 -RestoreService -ExpectedHead $expectedHead -RunId $runId
```

Restoration requires canonical absence, port 8080 free, no authority/Scheduled/
ledger/maintenance locks, no bootstrap permission, valid ledger/marker state and
matching maintenance record. It restores the saved startup mode and delayed
presence/value, verifies MediaMTX unchanged, and leaves LivezoneNode **Stopped**.
Starting the service is a separate operation outside this runbook.

## Exact expected mutations for the known baseline

1. Preserve the existing maintenance record unchanged; create run audit and
   phase sidecars. If a record were absent, create it exclusively from observation.
2. Create/release transient canonical maintenance gates. AutoLive: PREPARED audit,
   rename original lock to its canonical archive, completion; epoch unchanged.
3. Scheduled: PREPARED audit, rename legacy lock to `.lock.quarantine-<RunId>`,
   completion with LEGACY_UNVERIFIABLE reason; journal remains absent.
4. AutoLiveStore atomic config replacement: armed false, revision +1, updatedAt;
   enabled/source/migration preserved. Separate disarm audit/completion.
5. Start reservation, then canonical server startup: authority epoch 20 -> 21,
   new authority lock and Scheduled schema-2 lock, Schedule v3/revision 51,
   exclusive bootstrap marker epoch 21, empty valid ledger and its process lock.
6. Readiness audit. PROGRAM file remains byte-identical; no scheduled consumption
   or execution is authorized. Standard Media Library initialization may create
   missing `.tmp`, `files/video`, `files/audio`, `files/image`, and `assets.json`.
   A pending media deletion journal blocks controlled startup rather than allowing
   unrelated canonical deletion recovery to run during this operation.
7. Graceful shutdown removes owned runtime locks; it preserves epoch, migration,
   ledger, bootstrap marker and all recovery evidence.
8. Separate RestoreService changes only LivezoneNode startup configuration and
   DelayedAutoStart presence/value and writes restore audit/completion. It does
   not start the service. No `.env`, persistent bootstrap setting or MediaMTX
   service setting is changed.

## Validation and limits

Tests use OS temporary directories, explicit fixture hosts/proof providers, and
canonical stores/reconcilers. Integration starts are fixture server instances,
not the real runtime. DryRun checks verify identical file contents, filenames and
modification times and zero port reservations. Windows service mutations are
tested through the fixture host; real SCM changes are intentionally unexecuted.
The PowerShell entry point is parsed without running it against real var/.

Reproduce:

```powershell
node --test test/recovery-tooling.test.js
$tests = @(rg --files test | Where-Object { $_ -match '(recovery-tooling|scheduled|scheduler|schedule-|autolive|browser-execution|durable-program|restart-reconciliation|program-commit|startup)' })
node --test --test-concurrency=4 @tests
git diff --check
```

The broader selection covers 2C6R0 provenance, Scheduled repository/ownership/
execution/persistence/recovery, D8/D9/D10-related ownership/manual/restart paths,
ledger/runtime, migration, startup, and canonical AutoLive reconciliation.
No commit or push is part of this step.

Final gates on the stated baseline with the uncommitted R0/R1 changes:

- Focused recovery tooling: **67 PASS / 0 FAIL**.
- Broader selection: **1289 PASS / 0 FAIL**, 65 test files, no skipped/cancelled
  tests. This includes the focused tests; totals are not additive.
- PowerShell AST parsing and JavaScript syntax checks: **PASS**.
- `git diff --check`: **PASS**; new untracked R1 files separately checked with
  `git diff --no-index --check`, with no whitespace errors.

R1 file inventory: five new modules under `server/recovery/` listed above;
new `tools/recovery-maintenance.mjs`; replaced existing untracked
`tools/livezone-authority-maintenance.ps1`; updated
`server/autolive/WindowsAuthorityProcessProof.js` and
`server/scheduler/ScheduledEntryLedgerRepository.js`; new
`test/recovery-tooling.test.js` and this document. All other R0 modifications
are retained. Preexisting unrelated media/assets/playlist changes are untouched.


## 2C6R1 repository gate defect review — 2026-09-30

Confirmed on branch `build/1003.9A1`, HEAD
`b63c03d94a7f932d6c4052e9f1bed407819ae12b`. No real recovery command was run
in this investigation. Runtime files were read only; services were not changed.

### Exact root cause and paths

Before this fix, RecoveryContract exported the hardcoded expected HEAD
`06a0962e481c2f35a8c00b53a674a445383acb22` and branch `build/1003.9A1`.
Neither the wrapper nor CLI accepted an expected recovery version.

DryRun: wrapper -> CLI DryRun -> RecoveryWorkflow.inspect ->
WindowsRecoveryHost.inspect + capture. Git branch/head/stdout were trimmed and
returned as observations. No assertHost or repository comparison ran. Thus the
successful inventory was not a successful repository validation.

Prepare: wrapper -> CLI Prepare -> begin -> offline -> preflight -> host.inspect
-> assertHost. Exact branch/HEAD comparisons rejected the observed b63c03d...
against 06a0962..., before canonical proof refresh, maintenance adoption, port
reservation, gate acquisition or any file write. Root comparison normalized
backslashes to slashes and lowercased; branch/head comparisons were case-sensitive.
The maintenance Head 44816ca... was never the expected current HEAD. Audit load
also used the stale constant, but was never reached by the failed Prepare.

The fix requires -ExpectedHead / --expected-head for every phase. RecoveryContract
builds one immutable expected identity: fixed branch plus explicitly supplied
full 40-hex HEAD (hex case normalized to lowercase; whitespace and abbreviations
refused). Observed Git output is still trimmed. Both DryRun and Prepare call the
same assertRepository; root uses canonical repositoryIdentity path normalization.
DryRun additionally refuses conflicting maintenance identity while remaining an
inventory of the other blockers; proof.absent must still be checked. All mutating
host gates, audit loads, prepared/start sidecars and online readiness use that same
expected identity. There is no default to observed Git, historical HEAD or audit.
Existing audits remain bound to their original approved version. The operator
must pin the reviewed fix commit after committing; embedding that commit's own
hash in its source would recreate the self-reference defect.

### Real mutation boundary and read-only evidence

**PREPARE FAILED BEFORE FIRST MUTATION.** The first persistent mutation would be
acquireMaintenanceGate, after preflight, port reservation and fresh proof/evidence.
The reported exception occurs at preflight's first host gate. The wrapper throws
on that CLI exit before AutoPlan, Scheduled or canonical AutoLive reconciliation.

Observed evidence matches the supplied pre-Prepare values:

| Artifact | Read-only observation |
| --- | --- |
| recovery-post2c6-20260930-01.json and phase sidecars | absent; no recovery run audits found |
| AutoLive maintenance gate | absent |
| AutoLive | revision 26, enabled true, armed true; mtime 2026-09-28T22:06:06.459Z |
| Authority | epoch 20; original lock remains for PID 50780, process absent |
| AutoLive reconciliation | only historical PREPARED + COMPLETED pairs for epoch 13/PID 14284 and epoch 19/PID 30808; no epoch 20/PID 50780 audit |
| Scheduled | journal absent; original version 1 lock present; no reconciliation/quarantine artifacts |
| Schedule | version 2, revision 50; mtime 2026-09-28T22:05:21.095Z |
| Ledger / ledger lock / bootstrap marker | all absent |
| PROGRAM | generation 47; mtime 2026-09-28T22:16:42.166Z |
| Maintenance record | original Head 44816ca167b1042c8670c169f401ae7e961727ae; mtime 2026-09-28T20:01:47.551Z |

Observed SHA-256 values (pre-Prepare hashes were not provided; byte equality to
that earlier snapshot cannot independently be claimed):

- AutoLive: 64f68091f7db1f3346df3a6cf6d33d28581450d8c6709dd5bc20621d07c4754b
- Authority: 039b74c57f2fbd105c65fe3c88af57871ec2e8fb469f7b6f975cb73dccd8334a
- Authority lock: 0cac0ae826efb27c225f2571bb1d8f5886613ad1eb901916311f4202be0bd906
- Scheduled lock: c3b791f5a249c2dab68ccc6178aa897cb562fb3d8415fba7a4a2c231fc35d110
- Schedule: f06518291c5af07eb023712a6c713f4cdef148a3e4463cd3c342e4cd376761be
- PROGRAM: dab83c76a69304a1a361f8e16e3f02d4d77a1d2a40e85814cde256913db7b2e5
- Maintenance: 52fecb8d7c325dddea620cd1fd8128141178b6b379db739c56114c749d6b182e

### Regression and retry

The fixture uses historical maintenance HEAD 44816ca... and approved recovery
HEAD b63c03d.... DryRun passes and Prepare reaches a throwing fixture port-reserve
stub before any gate/write. The entire fixture tree, hashes and mtimes remain
identical. Additional tests cover wrong branch/HEAD/root on both paths, maintenance
repository mismatch, missing/malformed expected HEAD, hex normalization and audit
version binding. The existing adoption test verifies byte-preserved maintenance
and separately recorded recovery HEAD. No new regression performs reconciliation.

The failed RunId `post2c6-20260930-01` is reusable: it has no audit, phase sidecar,
reservation or reconciliation from the failed attempt. After review/commit and
closing Codex, run the updated DryRun with that RunId and the literal approved fix
commit SHA, verify proof.absent=true plus the full baseline, then Prepare with the
same RunId and exact same ExpectedHead. The b63c03d... SHA is the investigation
baseline, not the future fix commit. Never derive approval automatically from the
current Git HEAD. No commit, push or real Prepare retry was performed here.

Validation of this fix: focused recovery tooling **74 PASS / 0 FAIL**; broader
provenance/reconciliation selection **91 PASS / 0 FAIL** (scheduled-execution-provenance,
browser-execution-lifecycle including canonical AutoLive reconciliation,
restart-reconciliation, durable-program-reconciliation). PowerShell AST and CLI
JavaScript syntax: PASS. git diff --check: PASS. No full 1289-test rerun required.

Changed files: RecoveryContract.js, RecoveryWorkflow.js, WindowsRecoveryHost.js,
ControlledStart.js, tools/recovery-maintenance.mjs,
tools/livezone-authority-maintenance.ps1, test/recovery-tooling.test.js and this
runbook. Preexisting media/assets/playlist changes are untouched.

**PREPARE GATE FIX READY FOR REVIEW**
