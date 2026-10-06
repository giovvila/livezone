# Controlled clean ledger migration — R8

2026-10-02 (Europe/Rome). Repository `C:\Projects\livezone-broadcast-engine-x`,
branch `build/1003.9A1`, HEAD `1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b`.
Development and isolated TEMP verification only. No real installation operation.

## Preconditions and scope

`CleanLedgerV1Migration` requires an approved repository branch/HEAD, canonical
repository and private storage paths, administrator host proof, canonical absence
of LIVEZONE authority processes, LivezoneNode Stopped/Disabled, verified MediaMtx
identity, no persistent bootstrap permission, and initially free port 8080.
Maintenance holds the existing exclusive IPv4/IPv6 8080 reservation throughout
migration; its own PID's listeners are allowed only while that reservation is held.
Foreign listeners or a changed census stop mutation. A crash releases the OS
reservation; migration never creates a persistent writer/maintenance lock.

The existing authority and Scheduled locks must first be reconciled by their
existing audited workflows. A ledger lock with `version:1` always returns
`LEGACY_LEDGER_LOCK_UNVERIFIABLE`, before reservation or migration mutation.
`--authorize-legacy`, bootstrap permission, and `migrateV1:true` cannot bypass it.
An orphan v2 lock requires the existing v2 offline reconciliation, not migration.

The canonical v1 file must be ordinary and checksum/schema valid. Its bootstrap
marker must have exactly version 1 and a positive authority epoch no greater than
the current authority epoch. Missing/mismatched markers, v1 checksum errors,
foreign stage files, unrecognized migration artifacts or v2 WAL without a
recognized intent fail closed. Native capability must succeed through the exact
R7 trusted adapter on the canonical target directory (fixed local NTFS, volume
GUID/serial, directory barrier). Helper version 1.0.0/protocol 1, helper hash
`18e6f512134b371a38e2afe4aaf1b24778f4eb38e7656a186b3557ac0c1a8d0b`
and gate hash `9b726c3ef2c16ff31478b4d2d5735a325d1418f0358d533faf594363485c5cc3`
are unchanged. Capability/helper trust is re-established around each mutation;
unproven durability returns `LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN` with evidence
retained. There is no production simulation, operator barrier override or weak fallback.

## State machine and history contract

`V1_STABLE → INTENT_STAGING → INTENT_DURABLE → BASE_DURABLE → V2_INSTALLED → ACTIVATED → COMPLETED`.

An immutable sealed intent records original exact UTF-8 bytes/hash/generation,
original checksum/ledger ID and all consumption records (inside the original
bytes), canonical repository/root identities, authority path/bytes/hash/epoch,
bootstrap marker exact bytes/hash, target v2 envelope/hash, native identity and
storage capability. Transaction identity is the SHA-256 of that deterministic
plan. The recovery audit additionally binds the approved Git branch/HEAD and run ID.
The v2 envelope contains the exact validated original snapshot: same ledger ID,
generation N, N entries, executable identities, consumption IDs/times, authority
sessions/epochs and `ENTRY_CONSUMED` states. No history entry or ledger identity
is regenerated. Mapping failure blocks migration.

For each artifact: create an exclusive deterministic stage; append only a verified
prefix's missing bytes; file-sync; native namespace-sync; recheck host/capability,
source hashes and provenance; native durable replace; file/namespace re-sync.
Intent publication precedes any WAL or canonical mutation. A torn stage is resumed
only when its exact bytes are a prefix of the one authorized deterministic artifact.
Other corruption is never truncated, discarded, overwritten or guessed away.
This prefix rule concerns migration staging only: corrupt canonical WAL is refused.

The BASE WAL is a single sealed BASE record with the unchanged original snapshot.
Canonical replacement installs its v2 envelope only after BASE is durable.
Activation and completion are separate sealed, natively durable decision records
bound to the intent/transaction, final target hash, ledger ID and generation.
No normal writer BEGIN session is created until completion. Original v1 exact
bytes remain in the permanent intent; there is no rollback operation or cleanup
that erases conservative consumption knowledge.

## Crash matrix

Suffixes are relative to the canonical ledger: `.migration.intent.stage`,
`.migration.intent`, `.migration.base.stage`, `.wal`, `.migration.snapshot.stage`,
`.migration.activation.stage`, `.migration.activated`, `.migration.completion.stage`,
`.migration.completed`. Stages become their destinations by native durable replace.

| Requested boundary | Surviving state/artifacts | Next invocation/action | Authoritative history | Scheduled permission |
| --- | --- | --- | --- | --- |
| Before intent | Original v1/marker only | V1_STABLE; explicit controlled migration | v1 | No controlled v2 execution |
| During intent | Empty/verified-prefix intent stage | INTENT_STAGING; finish identical intent offline | v1, startup blocked | None |
| After intent fsync | Full intent stage or published intent | Publish/reflush; INTENT_DURABLE | Intent-bound original history | None |
| During BASE/WAL creation | Intent plus empty/prefix BASE stage | Resume identical BASE | Intent-bound history | None |
| After WAL fsync | Full BASE stage or installed BASE WAL | Reflush/install BASE | Intent-bound history | None |
| During canonical snapshot creation | BASE plus empty/prefix snapshot stage | Resume identical v2 envelope | Intent-bound history | None |
| After snapshot fsync | Full snapshot stage, original canonical | Reflush and install | Intent-bound history | None |
| Namespace install entry | Full stage and original canonical | Install, or validate installed target | Intent-bound history | None |
| After namespace barrier | v2 canonical + BASE + intent | V2_INSTALLED; complete activation | v2 history, unavailable writer | None |
| Before activation marker | Same installed target | Write activation | v2, blocked | None |
| During activation marker | Empty/prefix activation stage or activated record | Finish/reflush activation | v2, blocked | None |
| After activation/before completion | Activation + target + BASE | Write completion | v2, blocked | None |
| During completion | Empty/prefix completion stage | Finish identical completion | v2, blocked | None |
| After completion/before startup | Complete sealed records + coherent v2 | Reopen v2; never migrate/replay again | v2 only | Only after runtime v2 READY and existing authority fences |

The suite exercises 26 individual hooks covering these 14 groups, including open,
partial-write, fsync, stage/install entry, native install/barrier completion, and
completion before startup. Child termination uses immediate `process.exit(77)`
without migration cleanup. Native replacement is the actual R7 helper command;
the install-entry hook is before that call and the installed hook is after its
whole mutation/barrier acknowledgement. No hook claims to interrupt an internal
Win32 syscall or to prove physical power-loss behavior. For a lost acknowledgement,
resume accepts only the exact original or exact target plus matching BASE and
re-establishes all required barriers before completion.

## Startup precedence

1. Clean v1 with no migration artifacts: ordinary v1 behavior remains available
   outside rollout; controlled v2 startup requires the audited offline migration.
2. Any migration stage/intent: choose v2/blocked, never fall back to v1. Recognized
   states are resumed only offline, through the maintenance workflow.
3. Complete coherent v2: choose the v2 writer even without an explicit protocol flag.
   Completed migration records remain permanent, and original consumed entries
   must remain exact members of the current history after future transactions.
4. v2 envelope without WAL, partial/corrupt WAL, mismatching canonical/BASE,
   foreign stages, unknown or corrupt intent/activation/completion: fail closed.
5. Canonical v1 plus v2 artifacts: resumable only with the recognized original-hash
   migration contract; otherwise ambiguous/refused. Both cannot be executable.
6. Orphan v1 lock: immutable `LEGACY_LEDGER_LOCK_UNVERIFIABLE`. Orphan v2 lock:
   `LEDGER_V2_OFFLINE_RECONCILIATION_REQUIRED`.

The legacy writer checks migration artifacts/WAL/v2 envelopes before creating its
lock. The v2 writer refuses migration-in-progress before acquiring its writer
lock. Direct `migrateV1:true` is no longer a rollout authorization; it returns
`LEDGER_V2_CONTROLLED_MIGRATION_REQUIRED`. Runtime selects v2 for migration artifacts,
WAL or a v2 canonical envelope. Scheduled's existing gate rejects any ledger not READY.

Retained migration evidence also forbids fresh bootstrap when canonical, WAL and
marker are missing, even with `bootstrap:true`. Completed startup validates the
exact intent-bound marker. Artifact reads reject invalid UTF-8; torn staging
resumes using exact byte prefixes, including Unicode paths. A stage is checked
again at native installation entry; changed bytes are never installed. Artifacts
larger than 64 MiB are refused.

## Operator recovery/startup and idempotency

The existing CLI/PowerShell tools retain their explicit expected-HEAD/run-ID,
offline reconciliation, deliberate disarm and Start authorization steps. No new
HTTP/API route or persistent bootstrap switch was added. Do not run these tools
against the real installation as part of this review.

`DryRun` reports `ledgerMode`, `migrationState`, `nativeCapability`,
`migrationRequired`, `migrationResumable`, `blockingReason`, and transaction ID.
It creates no file/reservation; capability performs its actual non-mutating
directory barrier. File hashes/timestamps remain unchanged in TEMP inventory tests.

`Prepare` (`begin`, then the existing reconciliation/`Prepared` sequence as needed)
records the original recovery evidence and durably prepares migration intent once
authority/Scheduled locks are absent. It grants no Scheduled execution. Native
barriers also protect migration-controlling recovery/maintenance/prepared audits.

`Start` verifies audited disarm and fresh stable evidence, forbids bootstrap
authorization for existing migration history, natively reflushes controlling
audits, completes/resumes migration under offline exclusivity, then reserves
startup and passes protocolVersion 2 to the one server instance. It checks actual
runtime v2 READY, retained history/marker/PROGRAM, current unique authority and
restart reconciliation. A completed migration Start reservation may be reused
only before launch while its exact evidence/head/transaction/flags still match.
Bootstrap reservations retain the previous no-reuse-after-crash rule.

Repeated Prepare after canonical installation recognizes the exact intent-bound
target/BASE rather than treating the deliberate format change as unexplained
history loss. Audited disarm is accepted without duplicating the revision change.
Repeated DryRun/Prepare/Start never regenerate the ledger or consumption records.
Completion reopens as normal v2; a new recovery run for later clean restart does
not replay migration. Restore refuses incomplete migration and validates completion
before configuration restoration. Start and readiness evidence receive native
barriers when migration is involved. Restart reconciliation remains required;
migration completion itself grants no capture authority.

## Changed files and evidence

Production: new `server/recovery/CleanLedgerV1Migration.js`; deliberate changes to
`RecoveryWorkflow.js`, `RecoveryContract.js`, `ControlledStart.js`,
`ScheduledEntryLedgerRepository.js`, `ScheduledEntryLedgerV2Repository.js`, and
`ScheduledEntryRuntime.js`, plus `ScheduledEntryLedgerV2Protocol.js` (optional raw
byte reads for staging). Existing CLI entrypoints consume these integrations
unchanged. R7 adapter, native/gate sources, build recipes and pinned binary hashes
are unchanged.

Tests/support: three migration test files; `CleanLedgerMigrationFixture.mjs`,
`LedgerMigrationCrashChild.mjs`; deliberate updates to `recovery-tooling.test.js`,
`scheduled-entry-ledger-v2.test.js`, and `post-bootstrap-prepare-child.mjs` for
controlled migration rather than implicit writer conversion. This report is new.

Task-start hashes and logs are in `tmp/r8-review/`.

The real v1 lock is not a candidate. Its structural shape is reproduced only in
TEMP, where both migration and Prepare with legacy authorization refuse before
mutation. No read/mutation of real `var/` or locks, LIVEZONE executable launch,
real recovery, real service change, staging, commit or push occurred. Injected
host/service proofs and isolated server objects are test fixtures, not evidence
that the real installation is ready or quiescent.

## Final review evidence

1. Clean-v1 preconditions: private valid v1, matching marker/authority, no locks,
   approved quiescent host, exclusive port reservation and real R7 native capability.
2. State machine: durable intent, BASE, canonical v2, activation, completion;
   recognized partial stages resume offline; ambiguous/corrupt evidence is retained
   and refused. No rollback or v1 fallback after intent.
3. History proof: empty and three-consumption fixtures preserve ledger ID,
   generation and every original record exactly; consumed identities cannot replay.
4. Crash matrix: all 26 abrupt process-exit hooks listed above passed, with
   restart state inspection and exact-history resume at each boundary.
5. Startup precedence: v2 artifacts force v2/blocked; pending intent prevents
   Scheduled evaluation/capture; completed evidence prevents empty re-bootstrap.
6. Tool integration: DryRun reports migration status; Prepare records intent;
   authorized Start completes migration before runtime v2 readiness verification.
7. Audit/idempotency: original evidence and disarm remain bound to the transaction;
   native audit barriers precede migration; repeated operations do not regenerate
   history. Completed migration reopens as ordinary v2.
8. Production files: the new migrator and seven existing files listed above.
9. Tests/support/docs: three new suites, two new fixtures, three deliberate existing
   test/support updates and this report, as listed above.
10. Migration results: 48/48 main tests, including 26 crash hooks; 14/14 final
    policy/real-helper-trust tests. Logs: `migration-byte-final.log` and
    `policy-trust-startup-final.log`.
11. Native/trust/crash results: 69/69 helper/adapter tests (27 integrity plus 42
    functional); 69/69 native ledger tests, including all 20 writer-loss and 13
    recovery-interruption cases. Logs: `native-trust-final.log`,
    `native-ledger-final.log`. Affected startup cases were rerun after the final
    retained-history guard; byte/UTF-8 and marker-loss tests cover that final guard.
12. Regression totals: 731/731 across the final 36-file selection, zero failures,
    cancellations or skips (`regression-startup-final.log`). Together with 69 native
    ledger, 27 helper-integrity, 48 migration and 14 policy/trust tests, this is 889
    distinct passing tests; the 42 helper-functional tests are already in the 731.
    The final affected native startup subset also passed 8/8
    (`native-startup-affected-final.log`), without adding to that distinct total.
    The real executable
    startup suite is intentionally excluded because it starts the server entrypoint;
    isolated runtime, startup, restart and recovery fixtures cover these contracts.
13. `git diff --check`: passed; existing LF-to-CRLF notices are conversion warnings.
14. H1 unchanged: every SHA-256 equals the task-start value:

| File | SHA-256 |
| --- | --- |
| `server/autolive/AutoLiveSafeHttp.js` | `E08489051C477DC8073DA95EEE77DF293CC75AA452F8FF1CF9F25A53E537D614` |
| `server/autolive/ManagedIngestTransport.js` | `6A375DCC1A574334212EF2B78B9EA6698E52591E6EC0EFB72472BD7133BC83BF` |
| `test/managed-ingest-transport-health.test.js` | `9F4DF81AB2124C8EF92C0BC44BF97BC726BC2459620C8896FB482BCF63909CA1` |
| `test/scheduled-live-managed-health-gap.test.js` | `4084481E4646196A5B1AF2A46FDA2561F96B33A878369BD80406E9FE3071B283` |
| `test-support/MediaMtxCookieFixture.js` | `10990DA07B5D56EDE3F273974D13CB14B3C2D16F154337E63A76E34C31BEFB72` |

15. R6 migration blocker: closed for implementation review by explicit controlled
    clean-v1 migration and the TEMP native/crash evidence; production authorization
    is not granted by this report.
16. Before final R6 re-audit: independent review of R8 and retained R7 integrity,
    actual deployment/runtime-account capability and approved real-host evidence
    remain required. Physical power loss and internal native-syscall interruption
    are outside the observed process-exit matrix. All task-start files outside the
    ten deliberate existing-file edits are hash-identical, preserving R3/R4/R5/R7.
    Branch/HEAD are unchanged; the Git index is empty; nothing was staged/committed/pushed.
17. Real v1 status remains `LEGACY_LEDGER_LOCK_UNVERIFIABLE`. It was neither
    inspected nor mutated. Its TEMP structural fixture is refused before mutation.

LEDGER V2 CLEAN MIGRATION READY FOR REVIEW
