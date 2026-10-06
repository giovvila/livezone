# Native helper execution integrity — R7

Review date: 2026-10-01, Europe/Rome. Branch `build/1003.9A1`, baseline
`1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b`. Development/TEMP verification only.

## 1. R6 gap and current trust flow

The R6 flow hashed an ordinary canonical PE x64 executable, then launched its
pathname in a separate operation. A pathname replacement between those steps
could run a counterfeit that returned the expected version/protocol/barrier JSON.
Output validation alone did not bind that acknowledgement to reviewed code.

The task-start workspace already contained the R7 adapter, managed execution
gate, build script, and attack fixtures. This review preserved those changes,
verified their actual Windows behavior, and strengthened regression evidence.

Final flow:

1. Node resolves the fixed repository-relative helper path, rejects aliases and
   non-files, checks bounded PE/x64 format and the compiled-in SHA-256.
2. Node reads the gate DLL into a buffer and verifies its separately pinned hash.
3. The fixed Windows PowerShell host loads that same gate buffer with
   `Assembly.Load(byte[])`, never the DLL pathname. The request is base64 UTF-8 on
   stdin; shell execution is disabled, profiles are disabled, and output/time are bounded.
4. The gate requires a fixed local NTFS drive and a canonical, non-reparse path.
   It opens ancestors root-down with `OPEN_REPARSE_POINT | BACKUP_SEMANTICS`,
   read/write sharing but **no delete sharing**. It opens the executable for
   `GENERIC_READ`, with **read sharing only**. Failure to acquire any pin is unproven.
5. On the held executable handle it reads and hashes all 190,976 bytes, checks
   PE/x64, and requires exactly one hard link. It validates handle identity,
   normalized path, attributes, owner/DACL snapshot, and metadata on all pins.
6. From the held image handle it obtains the normalized volume-GUID pathname
   (`VOLUME_NAME_GUID`), and launches that path with shell execution disabled.
   This avoids resolving a mutable DOS drive-letter mapping a second time.
   While every pin remains held it waits for termination and validates child exit/output, then
   revalidates all pins and rehashes the same held image before emitting stdout.
7. Node validates exact response fields, helper `livezone-windows-ledger-durability`,
   version `1.0.0`, protocol `1`, x64, command, directory, volume, local NTFS and
   `NTFS_DIRECTORY_FLUSH`. Only then does the adapter accept durability.

Every unavailable/uncertain stage throws
`LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN`; there is no weak fallback or success cache.
Process death or a rejected post-operation result can leave a mutation performed:
the ledger must retain ambiguity rather than infer non-operation or replay identity.

## 2. Selected architecture and alternatives

Use a verified byte-loaded gate plus held Win32 file/namespace handles, rather
than permanent helper-deployment ACL immutability. The gate closes the exact
validation-to-launch gap by redoing authoritative identity validation on the
handle it keeps open through child completion. The preliminary Node check is
an early rejection, not the continuity proof.

ACL-only deployment would require an expected-owner policy and effective rights
analysis for every ancestor, delete-child rights, inheritance, privileged accounts,
and any existing writers. Merely comparing file IDs before/after launch permits
replacement/restoration during execution. A private execution copy would still
need a protected namespace, identity validation and lifetime protection. The
selected architecture directly acquires those lifetime protections per command.

## 3. Microsoft guarantees and explicit composition

[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
documents sharing compatibility, lifetime until handle close, exclusion of
write access/writable file mappings without write sharing, and deletion/rename
access without delete sharing. It also documents opening reparse objects and directories.

[MS-FSA FSCTL_SET_REPARSE_POINT](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165)
requires rejection of setting a reparse point on a nonempty directory. Each pinned
ancestor remains nonempty because its next child is held against deletion/rename.
This is the specific reason an in-place ancestor junction cannot redirect launch.

An experimental no-write-sharing directory pin did **not** prevent a direct
Win32 GENERIC_WRITE directory open on this machine. That assumption was discarded.
The final gate retains its original directory sharing policy and relies on the
documented nonempty-directory rule, verified with an actual FSCTL attack.

[GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle)
supports volume/file-index identity comparison; [GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
returns the normalized path of the held object. [Assembly.Load(byte[])](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.assembly.load?view=netframework-4.8.1)
loads the supplied assembly bytes.

Binding the pathname launch to the reviewed image is a composition of these
guarantees: a volume-GUID path from the held image, held ancestor chain, immutable
unnamed executable data during the pin, and launch while all handles remain open.
It is not a claim that Process.Start accepts a file handle or launches by file ID.
The trusted OS/.NET/PowerShell installation, process environment, adapter/hash
configuration, Windows volume namespace, and compliant local filesystem/driver stack are
the trust root. This is not protection against kernel/admin compromise, rewriting
the running adapter, malicious runtime instrumentation, or hostile filesystem filters.

## 4. Permissions and deployment identity

Helper execution continuity does **not** require an expected owner or permanently
protected helper-parent ACL. Owner, DACL and inheritance state are snapshotted and
compared; they are not an allowlist or proof of effective permissions. ACL and
hard-link changes observed at a validation boundary suppress acknowledgement.
Runtime read access must actually succeed on the pinned helper; execute access
must actually permit the child launch. Ancestor inspection must succeed. No real
installation ACL was changed, and no account was granted privileges.

A production code installation must protect the adapter and its expected hashes
as it protects all application code. Its owner/deployer and inheritance policy
belong to application deployment, not an unimplemented helper immutability claim.
This step does not establish or activate such a production installation. If a
future deployment instead relies on helper ACL immutability, expected owner,
effective write/delete/replace rights, parent delete-child protection and inheritance
must be explicitly verified; the snapshot check is insufficient for that design.

Obtain a release through review of the native and gate source/build recipes and
reproducible build evidence. Ship the reviewed adapter and both exact artifacts
together; install at the fixed repository-relative paths. Do not generate an
expected hash from an arbitrary binary at startup. A differing build requires
review and a deliberate adapter pin update. Missing artifacts or mismatches fail closed.

| Artifact | Expected SHA-256 |
| --- | --- |
| windows-ledger-durability.exe | `18e6f512134b371a38e2afe4aaf1b24778f4eb38e7656a186b3557ac0c1a8d0b` |
| LedgerExecutionGate.dll | `9b726c3ef2c16ff31478b4d2d5735a325d1418f0358d533faf594363485c5cc3` |

Native x64 build: MSVC 14.51/SDK 10.0.26100.0, `/MT`, `/Brepro`, PE machine 0x8664,
KERNEL32.dll dependency only, as recorded in the R5 report. Gate build: fixed .NET
SDK 8.0.319 Roslyn, Framework64 v4.0.30319 references, x64, deterministic compilation,
no debug information, path mapping. The integrity suite builds the native image
twice in a clean TEMP source tree and checks both approved hashes; it also rebuilds
the gate in TEMP and checks its approved hash. Generated-binary Git inclusion is
undecided. No native durability algorithm or build recipe was changed in this review.
The new gate source produces a new pinned digest; the native helper digest is unchanged.

## 5. Regression evidence and changes

The R6 counterfeit is independently compiled from TEMP source with mutation and
directory-flush execution removed, and padded with a valid PE overlay to the
approved file size. Its control run returns valid version/protocol/barrier JSON
while leaving the old ledger and stage untouched. The adapter attack replaces the
approved helper **after real Node validation and before gate entry**: the gate
rejects the digest, no durability result is accepted, and original ledger bytes remain.

Before launch and after child exit, TEMP scheduling-only instrumented gate copies
exercise overwrite, rename/substitute, parent rename, junction replacement,
direct in-place junction FSCTL, deletion, hard-link addition and ACL inheritance
change. Overwrite/rename/delete are blocked; the in-place FSCTL returns
`ERROR_DIR_NOT_EMPTY` (145). Link/ACL changes that succeed are detected and suppress
acknowledgement. Gate pathname overwrite/deletion after buffer verification cannot
substitute the already byte-loaded gate. Missing/corrupt bytes fail before launch.
A separate TEMP instrumented gate redirects the original executable pathname
variable to the lying counterfeit after verification. The held-image volume path
still launches the approved helper: the actual mutation completes, whereas the
counterfeit control would falsely acknowledge it without performing it. This is
a deterministic launch-selection regression, not a claim of testing actual DOS
device remapping; no real drive namespace was modified.

Review delta: gate volume-GUID launch and explanatory comment; adapter gate hash;
deterministic counterfeit padding and
control; clean repeated native builds; direct in-place junction attack child and
test cases; TEMP-only capability fixtures in the functional test; this report.
Existing R3/R4/R5/R6 integration is preserved.

## 6. Verification and preservation

Final integrity suite: **27 passed**, no failures/cancellations/skips, including
the counterfeit control, R6 replacement, held-image volume-path selection, both
reparse boundaries, and clean reproducible builds. Final functional/adapter/
namespace coverage: **42 passed** through the volume-GUID launch gate. Broader
regressions excluding the separately run native v2 suite: **728 passed**, no
failures/cancellations/skips across 36 files. The 42 are included in 728 and must
not be counted again. Final native Ledger-v2 suite: **69 passed**, including all
**20 abrupt child-loss boundaries** and **13 recovery interruptions**, with no
failures/cancellations/skips. Durable intent precedes ambiguity, recovery remains
conservative, ambiguous identities are not replayed, startup never captures before
READY, and unproven namespace durability never falls back. Total distinct tests
across final selections: **824 = 728 + 69 + 27**.

Logs: `final-trust-path.log` (68 tests before the final extra launch-selection
case), `integrity-volume-final.log` (27 final integrity tests),
`regression-volume-final.log` (728), and `native-crash-volume-final.log`.
Exact broad selection: `final-regression-files.txt`. All are under ignored
`tmp/r7-review/`, alongside task-start hashes in `baseline.json`, preservation
comparisons in `changed-from-start.json` and `protected-final.json`.
Startup/restart coverage uses isolated runtime/server-object and reconciliation
fixtures. `scheduler-production-startup.test.js` was excluded: it launches
`server/program-output-server.js` with only some persistence paths specified,
which conflicts with the prohibition on real application/runtime actions.

All pre-existing hashed files outside real var remain byte-identical to task start
except the deliberate R7 changes in `WindowsLedgerDurability.js`,
`ExecutionGate.cs`, `windows-ledger-helper-trust.test.js`,
`windows-ledger-durability.test.js` and `LedgerHelperAttackChild.mjs`. This report
is new. The five protected 2C6H1 files
match their task-start hashes:

| File | SHA-256 |
| --- | --- |
| server/autolive/AutoLiveSafeHttp.js | `E08489051C477DC8073DA95EEE77DF293CC75AA452F8FF1CF9F25A53E537D614` |
| server/autolive/ManagedIngestTransport.js | `6A375DCC1A574334212EF2B78B9EA6698E52591E6EC0EFB72472BD7133BC83BF` |
| test/managed-ingest-transport-health.test.js | `9F4DF81AB2124C8EF92C0BC44BF97BC726BC2459620C8896FB482BCF63909CA1` |
| test/scheduled-live-managed-health-gap.test.js | `4084481E4646196A5B1AF2A46FDA2561F96B33A878369BD80406E9FE3071B283` |
| test-support/MediaMtxCookieFixture.js | `10990DA07B5D56EDE3F273974D13CB14B3C2D16F154337E63A76E34C31BEFB72` |

Full `git diff --check` passed; the six changed/new R7 text files were additionally
checked with `git diff --no-index --check -- NUL <file>`, with no whitespace
diagnostics. Git reports only normal LF/CRLF conversion warnings. The index
remains empty (`git diff --cached --name-only` returns no paths).

The sandbox initially denied required ancestor access; native TEMP runs were
repeated outside that restriction with authorized test execution. Intermediate
runs during the discarded sharing-policy experiment are not final evidence.
The inherited capability test initially queried/flushed the repository directory
(no file mutation or real-var access); it was narrowed to two TEMP directories.
Final functional/regression evidence uses that TEMP-only fixture.

No operation targeted real `var/`, real locks, services or the running application.
Real-state preservation is supported by operation scope; no before/after snapshot
of real runtime state is claimed. No staging, commit, push, production deployment,
or v1-to-v2 migration was performed. Migration remains the separate R8 item.

Physical power-loss/OS-crash and hostile-driver tests are outside this execution
integrity review; abrupt child-loss tests establish ledger ordering and conservative
recovery, not hardware persistence guarantees. Recovery interruption hooks are
exceptions rather than abrupt recovery process kills. Helper-internal syscall
boundaries are not new crash-injection points.

## 7. Remaining blockers and review conclusion

No execution-integrity blocker was found for the tested supported Windows x64
local-volume contract. This is code/build readiness for review, not production
activation. Production must obtain and approve the reviewed release pair,
protect application code/hash configuration, and pass the final adapter under
its actual runtime account. No production deployment protection was installed
or asserted to exist. Unsupported/unverifiable execution remains fail closed.
R8 migration is untouched. Physical power-loss validation remains unperformed.

LEDGER V2 HELPER TRUST READY FOR REVIEW
