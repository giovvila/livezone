# Schedule readiness contract — R14

Repository `build/1003.9A1`, baseline `1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b`. Existing uncommitted R3–R13 work is retained. This report concerns TEMP fixtures only.

## Decision and semantics

Contract B, generalized to the already supported v1 input: v3 is required exactly when a hydrated runtime schedule contains any `source.live`. Valid v1/v2 without LIVE can remain indefinitely at its original version. Existing v3 is never downgraded. Presence is decisive; disabled, expired and future LIVE all migrate. There is no identity to invent for overlays or an empty program plan.

Outer Schedule v1 contains revision/events. Outer v2 adds the required programPlan (whose independent schema is version 1). Outer v3 adds liveIdentityMigration and requires server-owned incarnationId, positive entryRevision and entryMigration on every LIVE; programPlan remains optional for migrated v1. The nested event schema remains version 1. Supported event types are exactly overlay.crawl, overlay.sponsor and source.live; there are no other supported non-live event types. Program items are separately validated through the program schedule contract.

ScheduledEntryIdentity hashes identitySchema, eventId, incarnationId, entryRevision, type, sourceId, startAt and endAt. Editorial Schedule revision is not executable identity. A new incarnation prevents reuse after deletion/recreation; executable edits increment entryRevision. Legacy migration records the immutable original window and cutoff disposition EXCLUDED/FUTURE. EXCLUDED cannot become newly executable after an edit. Native creations have entryMigration:null and revision 1. Ledger v2 stores these identities and preserves consumption history; its protocol version does not impose an outer Schedule version without LIVE. Late-entry eligibility consumes identity and migration disposition, rather than imposing a blanket outer version.

## Complete production version audit

Search scope: server and public/js/scheduler; all outer Schedule version branches are below. Lock, ledger, retained summary, event, bootstrap marker and program-plan versions are independent schemas.

| Module/function | Accepted outer versions | Reason / LIVE relevance | Mutation | Consumer |
| --- | --- | --- | --- | --- |
| ScheduleContract.normalizeSchedule | 1,2,3 | Exact envelope; v2 requires programPlan; v3 validates all LIVE identities and cutoff consistency; older versions reject identity fields | None | Store, resolveSchedule, recovery |
| ScheduleContract.controlledSchedule | 1,2,3 before hydration; READY: 3 or legacy without LIVE | Shared presence-based migration requirement; no enabled/time dependency | None | Store hydration, Prepare, Start, readiness, Restore |
| ScheduleContract.resolveSchedule | 1,2,3 via normalization | Timing/type selection, no extra version branch | None | ScheduleAuthority, entry runtime |
| ScheduledEventIdentity.requiresLiveIdentityMigration / migrateLiveIdentities | 1,2,3 | v3 and zero-LIVE are no-ops; any legacy LIVE requires migration | v3, revision+1, cutoff, UUID, entryRevision=1, EXCLUDED/FUTURE | Store hydration |
| ScheduleStore.hydrate | 1,2,3; absent file defaults v1/0 empty | Migrate then validate ready contract; never expose migrated state before persistence | Only legacy with LIVE; atomic temp/write/sync/rename and v3 canonical sync | SchedulerServer, startup ledger |
| ScheduleStore.mutate | 1,2,3 | First LIVE insertion or type conversion promotes; existing v3 retained; plan action sets v2 only absent identities | Revision+1; new metadata for native LIVE; executable edits increment entryRevision | API, runtime observers |
| ScheduleStore.persist | 1,2,3 | v3 requires extra canonical sync; failure after replacement makes store unavailable | Durable replacement; v3 failure fences memory | Store hydration/mutation |
| RecoveryContract.bootstrapPlan | Evidence already validated by workflow | v3 native LIVE without legacy disposition cannot bootstrap an absent ledger; not a blanket v3 requirement | None | Prepare, Start, Restore |
| RecoveryContract.verifyMigration | 1,2,3 input; ready contract on output | No migration required: exact normalized equality. Legacy LIVE: strict revision/event/cutoff/classification/programPlan preservation | None | verifyReadiness |
| RecoveryContract.verifyReadiness | Same ready contract via verifyMigration | In-memory/on-disk equality, original migration contract, independent ledger/authority/PROGRAM checks | None | ControlledStart READY record |
| RecoveryContract.assertRestore | Valid 1,2,3 input | Shared validation even when restoring before launch; ownership/history checks unchanged | None | RecoveryWorkflow Restore |
| RecoveryWorkflow.preflight / prepareReview / startReview / reserveStart | Valid 1,2,3 before hydration | Shared predicate in every preflight; existing evidence fences recheck before mutation and final launch | Existing audit/ledger operations only; no Schedule writes | ControlledStart |
| RecoveryWorkflow.restoreReview | Before READY valid 1,2,3; after READY same ready predicate | Prevents accepting legacy LIVE as completed runtime evidence; allows configuration restore before startup | Existing phase/service operations only | Restore |
| ControlledStart | Delegates preflight and readiness | No independent version branch; startup hydration precedes READY | READY phase record | Recovery/Restore |
| SchedulerServer.start / ScheduleAuthority.start | Store-validated hydrated snapshot | No independent version branch | Delegates store migration | Runtime evaluation |
| ScheduledEntryRuntime.initializeEntryLedger | Hydrated snapshot | No outer version branch; validates every LIVE through identityForScheduledEvent; safe bootstrap requires legacy disposition | Existing ledger/marker operations | Entry consumption/late-start |
| public scheduler ScheduleContract / ProgramScheduleAdapter / ScheduleStore | Program-plan version 1, not outer versions | Browser program schema is independent | Existing browser plan mutations/import | Server programPlan |
| ServerScheduleStore / ScheduleApiClient | Server snapshots; marker version 1 independent | No outer version admission branch | Local import marker only | Browser UI |

## Deterministic transitions

Empty/overlay-only v2: Prepare → Start → store hydration no-op → READY; no Schedule byte mutation or revision increase. Exact R11-BIS regression additionally migrates an existing clean Ledger v1 to v2, proves READY persisted, closes the TEMP server, and verifies configuration Restore while retaining Schedule bytes.

First LIVE after empty-live v2: ScheduleStore.insert or update of an overlay to LIVE allocates metadata, promotes to v3 and increments Schedule revision once within the queued atomic persistence transaction. No published in-memory state precedes persistence. Migration marker is null because this is a new native event, not legacy classification. Restart preserves entryKey. Existing tests cover identity edit/recreation, persistence failures and conservative migration retry.

Legacy disabled/future LIVE becomes FUTURE when original start is after cutoff; expired LIVE becomes EXCLUDED. Disabled status never exempts an event from identity provisioning. Re-enabling or editing cannot erase legacy exclusion. Matrix regressions cover both v1 and v2.

## Preflight, readiness and Restore

One shared controlledSchedule predicate validates admissible legacy input and hydrated readiness. Store migration realizes the legacy-input obligation before runtime exposure. verifyMigration verifies the exact allowed transformation, including no-op equality, and accepts migration from both v1 and v2 as ScheduleStore already supports. A state admitted by Start cannot fail READY solely for being legacy without LIVE. Changing mutable evidence still fails closed.

Restore uses the predicate and, when READY exists, requires hydrated identity state. R10 authoritative ledger/WAL/marker validation and R12 phase lineage remain intact. Pre-start Restore can still accept legacy LIVE because it restores configuration without launching runtime. R13 reservation ordering is unchanged.

## Validation and preservation

Results and preservation evidence are recorded below after the final runs. No staging, commit, push, real runtime or real service operation is part of this increment. Test launch functions override all state paths into guarded OS TEMP roots. R11-BIS review artifacts are not used as production inputs.

### R14 files

Production changes only:
- server/scheduler/ScheduledEventIdentity.js: shared requiresLiveIdentityMigration predicate; existing cutoff/UUID allocation unchanged.
- server/scheduler/ScheduleContract.js: controlledSchedule normalizes and enforces that shared predicate for READY.
- server/scheduler/ScheduleStore.js: validate hydrated state before publishing it.
- server/recovery/RecoveryContract.js: verify exact no-op for no-LIVE legacy schedules; retain strict LIVE migration checks and support v1 input; validate Restore input.
- server/recovery/RecoveryWorkflow.js: shared validation in preflight/Prepare and hydrated validation for Restore after READY.

Tests: new test/schedule-readiness-contract.test.js; additions to test/scheduled-event-identity-migration.test.js, test/recovery-tooling.test.js and test/recovery-integrity.test.js. No permanent support file changes. Documentation: this report. tmp/r14 contains execution logs and isolated RED copies, solely review evidence; production has no import from that directory.

### Preservation evidence

HEAD remains 1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b; branch remains build/1003.9A1; git diff --cached --name-only is empty. No stage/commit/push command was issued. Native helper binaries were neither rebuilt nor changed.

The first streaming candidate hash inventory was captured after the initial four-file R14 patch (the first whole-file hashing attempt failed on the pre-existing >2 GiB media file). It proves byte preservation of all inventoried candidate files outside deliberate R14 targets, including the restored ScheduledEntryRuntime candidate. Changes preceding that inventory are the explicit R14 hunks in ScheduleContract, ScheduleStore, RecoveryContract and RecoveryWorkflow, as described above. It is not represented as a pre-edit hash baseline for those four files. Candidate inventory and delta are in tmp/r14/preservation.json and preservation-delta.json. Final verification (preservation-final.json) confirms 51 inventoried files remain byte-identical, with only four deliberate post-inventory R14 targets differing, and all five protected baseline hashes matching. Existing R3–R13 protections and code outside these deliberate hunks were retained.

All five protected 2C6H1 hashes match the previously documented task-start baseline:

| File | SHA-256 |
| --- | --- |
| server/autolive/AutoLiveSafeHttp.js | E08489051C477DC8073DA95EEE77DF293CC75AA452F8FF1CF9F25A53E537D614 |
| server/autolive/ManagedIngestTransport.js | 6A375DCC1A574334212EF2B78B9EA6698E52591E6EC0EFB72472BD7133BC83BF |
| test/managed-ingest-transport-health.test.js | 9F4DF81AB2124C8EF92C0BC44BF97BC726BC2459620C8896FB482BCF63909CA1 |
| test/scheduled-live-managed-health-gap.test.js | 4084481E4646196A5B1AF2A46FDA2561F96B33A878369BD80406E9FE3071B283 |
| test-support/MediaMtxCookieFixture.js | 10990DA07B5D56EDE3F273974D13CB14B3C2D16F154337E63A76E34C31BEFB72 |

No command wrote to repository var/, real locks or real services. All recovery launches were injected createProgramOutputServer fixtures with explicit TEMP state paths, fixture hosts and mocked service restoration; no production launch default was invoked. Real var/ was deliberately excluded from inventory and cleanup. Existing R11-BIS artifacts outside the new tmp/r14 evidence directory were not edited or promoted into production. Real v1 status remains unchanged: an unverifiable legacy orphan lock still fails closed; no real disarm, reconciliation, migration or readiness claim was made.

The isolated RED copy restores the old unconditional v3 check: exact R11-BIS condition launches the TEMP runtime then fails SCHEDULE_V3_REQUIRED, with manualServerMayBeRunning:true. Final R14 regression reaches durable READY and configuration Restore, retaining original Schedule bytes. Initial sandbox refusal of the native helper was overcome by approved unsandboxed TEMP-only test execution, without changing production trust checks.

### Focused final results

260 distinct tests passed, zero unresolved failures/skips: the original focused set contains 259 cases across eight files; the added post-READY Restore regression adds one. The final 102 Schedule/store/identity cases and five R14 controlled/Restore cases passed on final code. R13's three ordering/resumption cases passed; R12 phase-lineage cases and R10 Prepare/Restore authoritative checks passed.

The first focused run reported 258/259: the new sponsor fixture omitted canonical layout:CORNER, causing SCHEDULE_NOT_READY (not a version failure). Its corrected final run passed. The first broader run loaded a temporary redundant runtime check that rejected reduced internal {events:[]} test inputs. That check was removed; ScheduledEntryRuntime is byte-identical to its candidate inventory. The 132 affected runtime/policy/Ledger cases and two completed-migration crash boundaries passed on final code. These reruns replace earlier outcomes and do not add to distinct totals. Existing migration classifications and production runtime identity checks remain unchanged.

Exact final RED: tmp/r14/red-native-final.log shows SCHEDULE_V3_REQUIRED with assertions confirming runtime launch and absence of READY. Exact final GREEN: tmp/r14/green-native-final.log is 1/1 and verifies READY, clean Ledger v2 migration, Restore and unchanged Schedule bytes. Expected RED is excluded from passing test totals.

The final no-op matrix additionally rejects both revision-only alteration and gratuitous v3 promotion of a no-LIVE legacy schedule (8/8, already included in the focused total).

### Broader results and distinct total

728 distinct broader tests across 39 additional test files, with zero unresolved failures/skips. Coverage includes Ledger v2, clean migration including all 26 native abrupt-loss boundaries, recovery tooling, startup/restart, Scheduled entry runtime, late-start, temporal boundary, terminal contract, Scheduled provenance/recovery, PROGRAM continuity and broader scheduler suites. Focused and broader file sets are disjoint. Final distinct total: **260 + 728 = 988 passed**, zero unresolved failures, zero skipped. Repeated runs and expected RED are excluded.

The first broader raw summary was 719/728 with nine failures from the temporary redundant runtime check. Every one of those nine names has a passing final replacement in corrected-runtime-consumers.log or final-migration-completion.log; the matching proof is tmp/r14/corrected-failures.json. No initial failure is hidden or counted as a pass without a final rerun. Focused raw summary was 258/259 plus the new Restore test and corrected sponsor replacement as explained above.

Relevant logs: focused.log, broader.log, final-contract.log, final-r14.log, corrected-runtime-consumers.log, final-migration-completion.log, final-noop.log, red-native-final.log and green-native-final.log under tmp/r14. git diff --check returned 0; expected CRLF conversion warnings do not indicate whitespace errors. Index remains empty.

### Remaining blockers before R11-BIS

No remaining Schedule-version blocker was found in the exercised controlled fixture flows. R14 is ready for independent review and a repeat of R11-BIS. This is not authorization for real runtime restart: the existing real orphan Ledger v1 lock remains unverifiable and unchanged, and its disposition still requires the separate recovery review. R10/R12/R13 protections remain enforced. No actual production readiness observation or real-v1 migration is claimed.

SCHEDULE READINESS CONTRACT READY FOR REVIEW
