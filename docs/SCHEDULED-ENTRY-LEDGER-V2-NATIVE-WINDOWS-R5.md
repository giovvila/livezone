# Ledger v2 native Windows durability review

Development and isolated tests only, 2026-10-01 (Europe/Rome).
Branch `build/1003.9A1`; HEAD `1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b`.
Step 8C-2C6R5 establishes the native namespace barrier on this local NTFS storage
and integrates it into writer and recovery ordering. It is ready for review;
production activation and physical power-loss testing were not performed.
R3/R4 files and changes were retained; this report supersedes the R4 capability
decision without rewriting its historical evidence. No runtime configuration was
changed and no real ledger was migrated or reconciled.

## Toolchain and reproducible build

`vswhere.exe` reported complete Visual Studio Build Tools 2026, display version
18.10.3, installation version 18.10.12224.181, instance 708747c9, installed at
`C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`.

The supported `VC\Auxiliary\Build\vcvars64.bat` established x64, with
`VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64\cl.exe` and `link.exe`.
Compiler: 19.51.36260; linker: 14.51.36260.0. SDK Include/Lib: 10.0.26100.0.
No installation or download was performed. Node was v24.15.0, libuv 1.51.0,
win32 x64; Windows reported 10.0.26300.

Source: `tools/native/windows-ledger-durability/main.cpp`.
Build: `tools/native/windows-ledger-durability/build-x64.cmd` discovers installed
Build Tools using vswhere, requests MSVC 14.51 and SDK 10.0.26100.0 through
vcvars64, and checks `VSCMD_ARG_TGT_ARCH`. The source also refuses non-x64 builds.

Run from PowerShell:

```powershell
& ./tools/native/windows-ledger-durability/build-x64.cmd
Get-FileHash ./tools/native/windows-ledger-durability/generated/windows-ledger-durability.exe -Algorithm SHA256
```

The exact compiler/linker invocation is below; `%OUT%` resolves to the absolute
`tools\native\windows-ledger-durability\generated` directory and `%~dp0` is the
absolute script directory. cl invokes the supported linker with `/link` arguments.

```bat
cl /nologo /Bv /std:c++17 /EHsc /W4 /WX /O2 /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo"%OUT%\main.obj" /Fe"%OUT%\windows-ledger-durability.exe" "%~dp0main.cpp" /link /MACHINE:X64 /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /Brepro
```

Final executable: **190,976 bytes**, PE machine **0x8664 (AMD64/x64)**.
`dumpbin /dependents` reports **KERNEL32.dll only**. `/MT` statically links the C/C++
runtime: no separate MSVC runtime redistributable is required for this build.
Two consecutive completed builds produced the identical SHA-256:

`18e6f512134b371a38e2afe4aaf1b24778f4eb38e7656a186b3557ac0c1a8d0b`.

One attempted rebuild during active helper tests failed with LNK1104 because the
running executable was locked. After those tests finished, both builds succeeded.
Build/deployment must be offline with respect to users of this generated helper.

The executable and object are generated outputs, ignored by `.gitignore`. They
have not been selected for Git inclusion. Source, build script, adapter, tests and
this report are reviewable development files. Build logs, fixture preservation
copies and test logs under `tmp/r5-baseline/` are also ignored local evidence.

## Helper contract and API basis

The executable implements `capability <directory>`, `sync-directory <directory>`,
`durable-replace <source> <destination>`, `durable-archive <source> <destination>`
and `durable-remove <file>`. Capability intentionally requires an existing
directory and performs the actual barrier; it does not guess the parent of a
nonexistent path. The Node adapter supplies the artifact's existing parent.
There is no scheduler, event identity, recovery policy, network client, shell,
privilege escalation or volume-handle flushing code.

Success is one JSON object, helper `livezone-windows-ledger-durability`, helper
version `1.0.0`, protocol `1`, architecture `x64`, command and canonical directory,
canonical volume GUID, volume serial, filesystem, locality and barrier. Ordinary
errors are JSON with numeric exit/Win32 code and a fixed operation phase, without
echoing supplied paths or credentials. Exit codes: 0 acknowledged success; 2 bad
arguments; 3 invalid path/object; 4 unsupported/unverifiable capability; 5 Win32
operation failure; 6 unexpected internal failure; 7 standalone deadline.
Win32 API failures retain their error number and normally return 5, even when
encountered during capability detection. Every nonzero status is unproven.

The standalone watchdog requests process termination after five seconds. It emits
no acknowledgement, avoiding a blocked stdout write. The adapter has an earlier
three-second subprocess timeout and a 64 KiB output bound. These are process-level
deadlines under normal OS scheduling/termination, not a guarantee against a hung
kernel/storage driver. A timeout or death cannot prove the mutation did not occur.

Paths use Unicode Win32 calls and UTF-8 JSON. The intentionally narrow scope is
absolute DOS paths, local fixed volumes, NTFS, same-directory mutations, ordinary
files with one hard link, and no reparse component. UNC, device paths, ADS,
relative paths, dot aliases, trailing dot/space aliases, cross-directory moves,
directory/file misuse and archive destination collisions fail closed.

`CreateFileW` opens each ancestor with zero desired access, BACKUP_SEMANTICS and
OPEN_REPARSE_POINT; the target directory requests GENERIC_READ | GENERIC_WRITE.
Directory sharing allows read/write but excludes delete, pinning every ancestor
against rename/delete for the command. Handle information rejects reparse and
wrong-type objects. `GetFinalPathNameByHandleW` binds canonical DOS and volume-GUID
identity to that same opened directory. `GetVolumePathNameW` and
`GetVolumeNameForVolumeMountPointW` must agree with its GUID. `GetDriveTypeW` must
report DRIVE_FIXED for that volume. `GetVolumeInformationByHandleW` must report
NTFS and a writable volume on that same handle; no drive-letter inference occurs.

The directory barrier is **FlushFileBuffers on the verified write-capable NTFS
directory handle**, using FILE_FLAG_BACKUP_SEMANTICS. The Win32-to-filesystem
mapping is supported by Microsoft's [DispatchFlushBuffers contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/dispatchflushbuffers-routines):
FlushFileBuffers issues IRP_MJ_FLUSH_BUFFERS. The filesystem semantics come from
[MS-FSA 2.1.5.7](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/0de7dc40-9627-437e-a4df-c4696cdc3d02),
which includes directory structure/metadata persistence and an underlying storage
flush. [Product behavior footnote 80](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63)
limits that behavior to NTFS. Applying that filesystem contract to this verified
local NTFS Win32 handle is the explicit contract mapping; it is not inferred from
a successful generic directory fsync or from a drive letter.

[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
documents directory opens with BACKUP_SEMANTICS; [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
requires write access. The required access is tested rather than bypassed with
administrative volume flushing. File content barriers remain checked Node
FileHandle.sync/fsync calls, mapped by this Node/libuv build to FlushFileBuffers;
native mutations additionally flush the opened source and installed file.

Replace/archive use [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
with MOVEFILE_WRITE_THROUGH, adding REPLACE_EXISTING only for installation, never
COPY_ALLOWED. WRITE_THROUGH is not treated as the namespace proof by itself:
both mutations finish with the verified directory flush. Archive has native
no-overwrite semantics. Remove uses DeleteFileW, closes its own source handle,
then flushes the parent. Other outstanding handles can delay deletion; the writer
closes its lock handle first, and recovery/runtime exclusivity remains required.
[ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)
was evaluated and excluded: its write-through flag is unsupported and its failure
outcomes do not establish non-operation. There is no rollback or evidence cleanup.

## Integration and ordering

`WindowsLedgerDurability.js` is the only new child_process boundary. It uses the
absolute repository-relative executable path, shell:false and windowsHide:true.
Before each operation it validates an ordinary, unaliased helper, bounded file
size, PE signature/architecture and the SHA-256 pinned above. It then validates
exit, signal, timeout, stderr, single-response framing, exact response fields,
helper/version/protocol/x64 identity, target directory, NTFS, locality, volume GUID
and barrier acknowledgement. Missing files, malformed binaries, a different build,
malformed output, nonzero exit or timeout throw
`LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN`. There is no Windows Node fallback.

This is a trusted deployment model, not a security boundary against a party who
can rewrite the repository or helper between validation and execution. Deployment
ACLs must protect those files and ledger directories. Exclusive writers and audited
offline maintenance remain necessary; source/destination checks are not a defense
against arbitrary concurrent hostile filesystem mutations. Every helper operation
revalidates the filesystem; there is no cached success that authorizes later calls.

`LedgerV2Durability.js` is shared by the v2 repository and v2 reconciliation.
Existing syncDirectory injection remains isolated-test capability injection, never
an operator flag. Non-Windows operations retain checked directory fsync; archival
uses link/unlink for no-overwrite semantics. It is outside this Windows validation.

| Namespace mutation | Required barrier now enforced |
| --- | --- |
| Missing parent chain | Check existing ancestor first; mkdir one level at a time; flush its parent and new child before proceeding. Existing ancestors are deployment-provided; newly created ancestors are never assumed durable. |
| Writer lock | Write and file.sync, then checked shared namespace barrier before ownership/READY. Failure retains reservation. |
| New WAL / BASE and every append | Write and file.sync, then checked shared directory barrier before record publication. |
| New stage | Exact bytes and file.sync, then namespace barrier before installation. |
| Bootstrap and transaction install | Native source flush, same-directory replace, installed-file flush, directory flush, followed by existing final file and directory barriers. |
| Runtime bootstrap marker | Ensure parent chain, write/file.sync, checked shared directory barrier before repository initialization. |
| Prepared recovery audit | Write/file.sync and shared namespace barrier before recovery. Existing retry audit is explicitly reflushed before reuse. |
| Orphan lock archive | Native non-replacing rename and shared native directory barrier; existing bytes verified afterward. |
| Recovery completion | Created and file/namespace flushed only after recovery, END and archive; exact retry completion is explicitly reflushed. |
| Clean writer lock removal | Durable END, close writer handle, native delete/close and directory barrier before CLOSED. |
| Authority maintenance gate | Optional durability used by v2 only: creation is file/namespace flushed; ambiguous acquisition retains the gate; release uses native remove/barrier. Legacy behavior is preserved for other callers. |

WAL ordering remains durable INTENT → durable staging → durable installation →
COMMIT → publication. All barrier failures are checked, including previously
ignored lock creation/removal callbacks. READY and CLOSED cannot be inferred from
weak return values. INTENT remains irrevocable and recovery never replays a
maybe-consumed identity. Legacy v1 lock classification precedes native capability
checks and remains `LEGACY_LEDGER_LOCK_UNVERIFIABLE`.

## Verification

Real functional tests create only uniquely named, cleanup-validated OS TEMP
fixtures. Capability inspects the repository directory only, without creating
ledger artifacts there. Repository and TEMP both proved NTFS, DRIVE_FIXED, volume
`\\?\Volume{002b730b-7110-a9e1-5934-df0116e65600}\`, serial 2849514048, with an
actual successful directory flush. The ordinary agent execution sandbox denied
an ancestor handle under C:\Users; authorized unsandboxed TEMP verification passed.
This was a sandbox restriction, not a runtime filesystem fallback or ACL change.

Functional coverage includes actual directory flush, Unicode replace, archive,
remove, non-overwrite collision, access denied on read-only TEMP evidence,
nonexistent paths, file/directory misuse, malformed CLI arguments, relative/UNC/
ADS/alias rejection, junction and hard-link rejection, cross-directory refusal,
all adapter failure fields, actual missing/malformed/wrong-hash deployment binaries
in isolated TEMP module trees, malformed child output, and a real timed-out child.
No non-NTFS local volume was available/tested; simulated response rejection is
separate from the real path/volume tests. Neither a physical power cut nor an OS
crash, hostile filter-driver test, or deliberate mid-syscall helper kill was done.

The R3 crash child accepts a test-only `native` argument. With
`LZ_TEST_NATIVE_DURABILITY=1`, the entire 69-test v2 suite uses the real adapter,
including writer processes, recovery, all 20 abrupt child-loss boundaries, 13
recovery interruptions, corruption/races, and identity suppression. Recovery hooks
throw exceptions; they are not abrupt recovery-process kills. The native
`replaced` hook runs after the helper's whole mutation/barrier command; it does not
inject a crash inside MoveFileExW or between helper-internal calls.

Final verification: **42 helper/adapter/capability tests passed**; **69 real-native
v2 tests passed**, including all 20 abrupt child-loss boundaries; **764 regression
tests passed across 36 files**. Each run had zero failures, cancellations and skips.
The 42 and 69 tests are included/repeated in the broader suite and are not added
to 764 as distinct coverage. The last GUID-format validation tightening was also
checked by the final 42-test focused run. Tests use injected service/offline proofs
and TEMP state, never real recovery or services. The production executable startup test
was excluded because it launches the application with partially specified paths;
startup/restart behavior is covered by isolated runtime/server-object fixtures.

Reproduction:

```powershell
node --test test/windows-ledger-durability.test.js test/windows-ledger-namespace-capability.test.js
$env:LZ_TEST_NATIVE_DURABILITY='1'
node --test test/scheduled-entry-ledger-v2.test.js
Remove-Item Env:LZ_TEST_NATIVE_DURABILITY
```

The broader run selects `scheduled-entry-*`, `scheduled-event-identity-migration`,
`scheduled-execution-provenance`, all `scheduled-live-*`, `restart-reconciliation`,
`recovery-tooling`, `program-identity-continuity`, `program-playback-continuity`,
all `durable-program*`, `scheduler.test.js`, and both `windows-ledger-*` files.
The exact 36-file list is in `tmp/r5-baseline/regression-files.txt`. Final logs:
`native-functional-final.log`, `native-crash-final.log`, `regression-final.log`,
`build.log`, and `build-repeat.log`, all under that ignored evidence directory.

Full `git diff --check` passed (exit 0). All 15 new/untracked source, test and
documentation files in the scoped server/test/test-support/docs/tools paths were
also checked individually with `git diff --no-index --check -- NUL <file>`;
there were no whitespace errors. Exit 1 indicates the new-file difference;
the only diagnostics were normal Git LF/CRLF conversion warnings.

## Deployment and preservation

On the tested local NTFS storage, the namespace capability is proven to the
documented API contract and ready for code/build review. This does not authorize
production activation now. Deployment requires this reviewed x64 executable at
the explicit path, matching pinned SHA-256, protected installation/ledger ACLs,
write-capable directory/file access for the actual runtime account, local NTFS,
ordinary unreparsed paths, honored storage flushes, and separately reviewed v2
rollout/migration. A rebuild that changes identity stays blocked until its hash
and toolchain are reviewed. No binary may be replaced during active operations.

Documented guarantees assume a compliant filesystem, filter/driver/controller
stack and hardware honoring flush requests. Process-crash tests establish protocol
suppression under application loss; they do not establish physical power-loss
survival, rule out lying caches, or rule out coherent rollback of all evidence.

All five protected 2C6H1 SHA-256 values matched task-start values:

| File | SHA-256 |
| --- | --- |
| server/autolive/AutoLiveSafeHttp.js | E08489051C477DC8073DA95EEE77DF293CC75AA452F8FF1CF9F25A53E537D614 |
| server/autolive/ManagedIngestTransport.js | 6A375DCC1A574334212EF2B78B9EA6698E52591E6EC0EFB72472BD7133BC83BF |
| test/managed-ingest-transport-health.test.js | 9F4DF81AB2124C8EF92C0BC44BF97BC726BC2459620C8896FB482BCF63909CA1 |
| test/scheduled-live-managed-health-gap.test.js | 4084481E4646196A5B1AF2A46FDA2561F96B33A878369BD80406E9FE3071B283 |
| test-support/MediaMtxCookieFixture.js | 10990DA07B5D56EDE3F273974D13CB14B3C2D16F154337E63A76E34C31BEFB72 |

RecoveryContract.js, RecoveryWorkflow.js, ScheduledEntryLedgerRepository.js and
both existing R3/R4 reports were additionally compared byte-for-byte to task-start
copies and remained unchanged. Existing modified R3 runtime/protocol/repository
and test files received additive native integration changes; none was reset to
HEAD or overwritten with an earlier revision. The task-start versions are retained
in ignored `tmp/r5-baseline/preservation.json` for reviewing the R5-only delta.

Production changes: WindowsLedgerDurability.js, LedgerV2Durability.js,
ScheduledEntryLedgerV2Protocol.js, ScheduledEntryLedgerV2Repository.js,
ReconcileScheduledEntryLedgerV2.js, ScheduledEntryRuntime.js and optional v2
durability in AuthorityMaintenanceGate.js. Native/build changes: main.cpp and
build-x64.cmd. Test changes: windows-ledger-durability.test.js,
windows-ledger-namespace-capability.test.js, scheduled-entry-ledger-v2.test.js and
LedgerV2CrashChild.mjs. Also changed: generated-output ignore rules and this report.

There was no read/write operation targeting real var/ or real locks, no lock
removal/archival there, no LIVEZONE executable launch, no real recovery, no service
operation, no commit and no push. Real-state preservation is supported by this
operation scope, not by claiming a nonexistent before/after filesystem snapshot.
The supplied current real v1 status remains unchanged and was not reclassified:
`LEGACY_LEDGER_LOCK_UNVERIFIABLE`.

Conclusion: LEDGER V2 NATIVE WINDOWS DURABILITY READY FOR REVIEW
