# Permanent proof installation and complete snapshot evidence

This is implementation for separate review and authorization, not an installation
authorization. Run the explicit CLI only in an Administrator Windows context;
its OS/security subprocesses use Windows PowerShell 5.1 Desktop. Independently
approve the final deployment HEAD. No service, runtime, Git, Ledger or authority
mutation is part of installation. No LocalSystem probe or native helper executes.

`tools/install-permanent-capability.mjs` verifies Git/host/offline identity and
requires `--authorize-install YES`, an explicit approved HEAD, source and proofHash.
The source is verified by `verifyLocalSystemCapabilityProof` before any mutation:
manifest approval, SYSTEM/service identity, machine, volume, native pins, all twelve
producer inputs and exact twelve-file bundle. Source bytes are captured and checked
against manifest digests. No proof-bound producer is changed by this implementation.

The production target is fixed at
`C:\ProgramData\Livezone\capability-evidence\488c7b53-71e4-46d4-a95a-cbb8d218c249`.

The NEW-ERA-58 proof was independently verified for immutable producer B HEAD
`187bc4faa5a91b70401906ce3925e3d08c79cb07`, probeId
`488c7b53-71e4-46d4-a95a-cbb8d218c249`, with manifest SHA256
`0aec39f8e61d44b06bf78bfbed0c42e528da08901c082d2806c557ed2b639b8a`.
The current operator source is
`C:\Users\user\AppData\Local\LiveZonePackagingTemp\lz-era05-probe-NEW-ERA-58-bundle-488c7b53-71e4-46d4-a95a-cbb8d218c249`.
The old ERA20 proof is retained as historical evidence for its old certified lineage;
it is stale under B. The new destination above is reserved for the NEW-ERA-58 proof;
this candidate does not install it. A later reviewed integration/deployment HEAD may
differ from B while all twelve certified producer inputs remain byte-identical.
Parent directories, if absent, are created individually with the protected descriptor.
Existing parents must have Administrators/SYSTEM ownership and no other principal's
allow write/delete/change-permissions/take-ownership ACE. Unsafe existing parents
are not repaired automatically; STOP for a separately reviewed parent security action.
Every existing ancestor is checked for aliases/reparse paths. The source and target
must be on the same drive; canonical source proof verifies the local fixed NTFS volume.

The deterministic sibling stage is `.install-<probeId>-<proofHash>.stage`.
Staging is created with a protected directory ACL: owner Administrators SID
S-1-5-32-544; Administrators FullControl and SYSTEM SID S-1-5-18 ReadAndExecute,
with object/container inheritance for the directory. Each artifact receives a
protected file ACL with the same principals/rights and no inheritance flags.
No additional or inherited ACE is accepted. All files are created exclusively and
flushed before staged proof and ACL verification. Source verification is repeated.
Windows `Directory.Move` publishes the same-parent directory and refuses an existing
target. This is atomic namespace publication, not a claimed NTFS directory durability
barrier. A successful receipt requires full proof and ACL verification at the final
path. On restart the installed bundle must be verified again before use.

An existing matching final is read/verified only: never merged, overwritten or
resecured. Any conflicting/partial final or staging residue means STOP. Failures
retain evidence; no automatic rollback/delete. Pre-publication failures retain
staging and leave final absent. A post-publication failure retains final for review
and does not return success. Retry recognizes only a complete verified final with
exact ACL and no staging residue. Interrupted staging requires an independently
authorized inspection and remediation; neither a new probe nor cleanup is implicit.
Power loss may leave an incomplete stage/absent or unverifiable final: never accepted.

`tools/test-runtime-snapshot.ps1` remains pure observation. The two WinSW operational
logs `log\livezone\LivezoneMediaMtx.err.log` and
`log\livezone\LivezoneMediaMtx.out.log` are still included with real size/SHA-256.
They alone use FileMode.Open, FileAccess.Read, FileShare.ReadWrite plus Delete, permitting the
existing writer. A reader which shares Read only conflicts with an existing write
handle even when that writer permits readers. The sharing flags do not obstruct
writer rotation; the path is reopened for the second pass. Two sequential hashes, handle/path
length and path last-write metadata must agree; detected concurrent changes or
access failures return null hash plus an error, and the existing completeness gate
still rejects the snapshot. No metadata-only substitute or volatile-log exclusion.
Reparse/nonordinary entries are rejected. No writer is stopped or log modified.

The old real before-var.json remains incomplete and is not rewritten by this task.
After review of this change, NEW EVIDENCE CAPTURE REQUIRED under separate approval.
If a log changes during hashing or between observation and capture, STOP and review;
do not weaken the equality/completeness checks. Read operations issue no content,
last-write timestamp, namespace or service mutation. Windows-managed last-access
accounting is not an application-controlled timestamp write.

Future ordering: complete read-only preflight; separately authorized complete external
capture; separately authorized proof installation; verify permanent proof/ACL;
prepare, persist and independently review original proof-bound authorization;
observe/reapprove initial checkpoint; only then separately authorize phase authorized.
