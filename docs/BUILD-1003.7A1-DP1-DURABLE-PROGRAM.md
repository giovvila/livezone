# 1003.7A1-DP1 — Durable Program Authority

## Retained LIVE initial active-health projection follow-up

The epoch-18 browser run confirmed successful reconciliation and retained LIVE
adoption, but activation waited on an unresolved controller health projection.
The active Program owner initialized internally ONLINE and suppressed its first
actual ONLINE progress observation as an equal-state notification.

AutoLiveActiveHealth now projects its first actual observation once, including
equal-state ONLINE, then resumes equal-state suppression. Construction emits
nothing. Progress still requires the bound Program surface/scene and current
session/generation; an invalid execution lease cannot publish. Genuine uncertainty
can project CHECKING. BrowserExecutionActivation's readiness predicate is unchanged.
No Technical Monitor observation alone is promoted to active Program authority.

Handoff traces retain their legacy fields and add bounded scalar provenance:
externalMonitorState/Reason/Authority, controllerProjectionState/Authority/Generation,
and activeProgramPlayerState/HealthState/Authority/HealthProjected/PlaybackProgressing/
CurrentTime/LastHealthyAt. An initial internal ONLINE state is distinguishable from
an actually projected observation. The existing trace sanitizer rejects unknown
fields and URL-shaped labels. No decisions change for diagnostic formatting.

Production files for this fix only:

- public/js/studio/AutoLiveActiveHealth.js
- public/js/studio/AutoLiveEntryController.js
- public/js/core/RuntimeTrace.js

Tests: autolive-retained-health.test.js, autolive-initial-health-projection.test.js,
and autolive-post-take-session.test.js. The latter restores source-monitor sequence
in its historical fault injection, matching the pre-active-owner path it simulates;
its false-close-loop assertions are unchanged. The immediate post-confirmation
readiness assertion now delivers a real progress sample after observer attachment;
it does not require manufactured constructor readiness.

Before the fix: all five intentional activation regressions failed
(`var/dp1-projection-before.log`). After: focused suites 658 passed, zero failed
(`var/dp1-projection-focused-final.log`). Loss/projection/retained suites: 53 passed,
including recovery before the 15-second confirmed-loss deadline, cancellation of
stale deadlines, and exactly one legitimate closure after persistent loss.
The new OFFLINE-monitor/advancing-Program case now displays LIVE and completes
activation without ENTRY, TAKE, release, new gate or Preview change.
Full Node regression: 1,868 passed, zero failed/cancelled/skipped
(`var/dp1-projection-full-final.log`, `node --test --test-timeout=60000 --test-concurrency=2`).
`git diff --check` passed; new test/document whitespace checks also passed.

Current-machine revalidation for this browser-only fix:

1. Leave the current manual server and WinSW state unchanged. Keep primecast
   broadcasting and record the current Program/Preview identities.
2. Hard reload Control (Ctrl+Shift+R). The server serves JS from disk with no-cache;
   no server restart is needed. A fresh document may wait for release/expiry of
   the old document's lease (up to the existing 15-second lease).
3. The already reconciled epoch should grant fresh browser ownership without a
   new restart confirmation. Do not TAKE or restart the source.
4. After actual Program progress, verify LIVE instead of RIPRISTINO IN CORSO,
   retained ADOPTED/LIVE, valid BROWSER_OWNER, unchanged Program/Preview and no
   ENTRY/30-second gate. Trace controllerProjectionAuthority should become
   active-program; activeProgramHealthProjected should become true.
5. Observe for at least two minutes. Monitor OFFLINE evidence must remain separate
   from healthy advancing Program ownership. Do not deliberately interrupt the
   live source for this check; confirmed-loss qualification is automated.

No running-server restart, live reconciliation, live authority/durable mutation,
commit or push was performed. Server execution remains disabled.

DP1 is an uncommitted sub-gate of build/1003.7A1. It does not enable server
execution. Operator-reported A–L browser acceptance now passes. Current final
verification and the exact commit manifest are in
[BUILD-1003.7A1-FINAL-VERIFICATION.md](BUILD-1003.7A1-FINAL-VERIFICATION.md).

## Record and commit contract

The private canonical path is `<studioStatePath>.program-output.json`, normally
`var/studio-state/state.json.program-output.json`. Schema version 1 contains a
monotonic durable generation, acceptance time/authority epoch, Program state,
the exact base envelope, source/catalog/asset identity bindings, a bounded
publisher retirement ledger, and a SHA-256 checksum over canonical sorted JSON.
The maximum record is 128 KiB; the retirement ledger is bounded to 100 sessions.
Effective-output composition, scheduled overlay winners and ownership secrets
are excluded. No durable import endpoint is exposed.

Production publication enters the existing shared asset/Program mutation queue.
The store prepares a candidate without mutation. Validation binds catalog and
managed assets before a unique same-directory staging file is written fully,
flushed and closed. Ownership, manual intent and store/session CAS are rechecked.
The final synchronous rename/flush/install section prevents JavaScript mutations
from interleaving after that check. There is no delete-before-replace. The exact
committed candidate is installed, ownership effects applied, then observers are
notified before HTTP success. Observer exceptions cannot undo the commit.

Failed staging leaves the previous memory state intact. An uncertain replacement
or final flush blocks further writes and reconciliation; it does not acknowledge
success or pretend the previous file is still authoritative. Restart validates
the canonical file. Temporary files and older backups are never selected as
authority. Shutdown drains pending commits before releasing the writer lock.

## Restore, identity and playback

Startup waits for exclusive authority, catalog and asset readiness. It validates
the bounded file, checksum, envelope, ledger and dependencies before installing
the original envelope without manufacturing a publisher revision or timestamp.
Retained reads/SSE and reconciliation preparation wait for this readiness.

Statuses are PRESENT, EXPLICIT_EMPTY, UNAVAILABLE, CORRUPT and UNRESOLVED.
Only an accepted null scene/source envelope represents explicit empty. Missing,
corrupt and unresolved records cannot be reconciled as empty. Historical publisher
identity/retirement remains fenced even when dependencies cannot be restored.

Bindings detect changed source URLs/configRef endpoints, audio/still/motion and
slate content, plus managed asset bytes using streamed SHA-256. Display names
do not define content identity. Durable asset references participate in deletion
protection, including historical records not currently installed in Program.

Playing media uses the original anchor plus elapsed time, clamped to known
duration; paused/ended media preserves cue/state. LIVE restores identity and
intent, never persisted decoder health. A current authenticated browser grant
can carry a durable binding to the exact retained envelope and current epoch.
Only that binding bypasses the six-hour continuity age check. Unverified retained
snapshots keep the age protection. Program changes during renderer hydration
abort activation rather than start execution against another Program.

## Ownership and reconciliation

Hydration does not grant ownership. New server epochs retain the explicit restart
fence. Prepare binds durable generation and Program/config/manual-intent identity;
operator confirmation can grant only BROWSER_OWNER. Reconciliation itself does
not publish, TAKE, clear Program or change Preview. The already-reconciled epoch
survives ordinary F5; a new process epoch requires confirmation again.

Authorized retained LIVE uses A5 adoption without ENTRY or TAKE. Retained non-LIVE
with an already-ONLINE source replays health into the existing full 30-second gate.
SERVER_OWNER, serverTake and server ENTRY/TAKE/RETURN remain disabled.

## Qualification and limits

Tests run on Windows, Node 24.15.0, local C: NTFS. Isolated child-process crash
tests stop at open/write/flush/stage/pre-replace/post-replace/install/notify
boundaries and recover the appropriate old or new canonical record. Real HTTP
restart tests recover all supported kinds and explicit empty, fence old grants,
exercise reconciliation/F5/another epoch, and observe Public/OBS SSE hydration.
Injected tests cover disk full, access denial, short writes, flush/replacement
failure, ambiguous replacement, corruption, oversize and orphan staging files.

This establishes normal restart and the tested process-crash behavior. It does
not establish sudden-power-loss durability of Windows directory metadata or
hardware caches. The implementation flushes the staged file and the replaced
canonical file; it does not claim a separately proven directory metadata flush.

All writers must share the same single-host authority scope. Windows file ACLs
inherit the private state directory; Unix mode 0600 is not a Windows ACL guarantee.
External/legacy URL bytes are not verified like managed assets. Large managed
assets incur hashing latency and publication acknowledgements await storage.
Uninitialized catalog/ephemeral ENTRY bindings are not executable restore proof;
unresolved dependencies require repair and revalidation on restart or a legitimate
new publication. Corrupt/uncertain state has no automatic rollback/repair. Older
builds are not safe writers of this durable contract; downgrade/re-upgrade needs
controlled validation. A lost HTTP response after commit leaves the client
uncertain, but cannot undo the durable record.

## Historical first-run acceptance procedure — now completed

The current machine already has durable primecast LIVE. Do not repeat first-run
TAKE or abandoned-lock maintenance. This procedure records the sequence validated
by the operator; final acceptance includes VIDEO and retained LIVE recovery.

No live server, authority files, completed maintenance audit or archived lock was
modified by this work. Do not repeat abandoned-lock reconciliation.

1. Keep the WinSW LivezoneNode service stopped. In the existing manual server
   console, use Ctrl+C and wait for graceful exit. Verify branch build/1003.7A1
   and no listener on port 8080, then run `npm run serve` from this repository.
   The current server must restart to load DP1. Do not kill unrelated Node apps.
2. On first DP1 startup, no durable file is expected. PROGRAM NON VERIFICABILE is
   correct: existing browser storage/in-memory state is not imported automatically.
3. With primecast OFFLINE, perform an intentional operator TAKE of a known VIDEO
   as the acceptance setup. Do not TAKE merely to bypass reconciliation or seed
   the file manually. Confirm the actual Program publication returned 202 and
   the canonical file now exists with the accepted identity/generation. A VIDEO
   already visible before this step is not proof of durable acceptance.
4. Record Program identity, Preview and playback cue. Gracefully stop/restart the
   manual server again. Verify hydrated VIDEO in Control/Public/OBS with elapsed
   playback, and RIPRISTINO RICHIESTO. No artificial empty update is expected.
5. Authenticate if needed. Select RIPRISTINA CONTROLLO AUTOLIVE; review the
   prepared current Program summary and explicitly confirm. With the source
   OFFLINE, verify ownership is restored without Program/Preview mutation.
6. Bring primecast ONLINE. Verify the complete 30-second preparation and one LIVE
   commit. After LIVE is established, verify the durable base source is HLS.
7. Keep primecast ONLINE; gracefully restart the server. Explicitly prepare and
   confirm reconciliation. Verify retained LIVE adoption, no fresh ENTRY/gate/TAKE,
   no Preview change, and restored active-health ownership.
8. F5 in this reconciled epoch: no new restart confirmation. A previous document's
   unexpired lease may briefly delay acquisition. Another server restart must
   require explicit confirmation again.
9. Repeat separate acceptance setups for paused/ended media, AUDIO and an explicit
   legitimate Program release. Never substitute missing state for empty. Do not
   corrupt files or crash the live server; destructive tests use isolated state.

PowerShell checks after Ctrl+C, before each manual restart:

```powershell
Set-Location 'C:\Projects\livezone-broadcast-engine-x'
git branch --show-current
Get-Service LivezoneNode | Select-Object Name, Status
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
# Continue only with build/1003.7A1, service Stopped and no listener.
npm run serve
```

Read-only acceptance check in a separate terminal after a legitimate publication:

```powershell
$dp1Path = 'C:\Projects\livezone-broadcast-engine-x\var\studio-state\state.json.program-output.json'
$dp1Record = Get-Content -LiteralPath $dp1Path -Raw | ConvertFrom-Json
$dp1Record | Select-Object schemaVersion, generation, programState, acceptedAuthorityEpoch
$dp1Record.envelope | Select-Object publisherSessionId, revision, publishedAt
$dp1Record.envelope.snapshot.source | Select-Object id, kind
Get-FileHash -LiteralPath $dp1Path -Algorithm SHA256
```

These commands are for the operator; none starts reconciliation automatically.

## Files in this DP1 change

Production:

- server/program-output/DurableProgramContract.js (new)
- server/program-output/DurableProgramRepository.js (new)
- server/program-output/ProgramCommitCoordinator.js (new)
- server/program-output/ProgramRestoreValidation.js (new)
- server/program-output/ProgramOutputStore.js
- server/program-output-server.js
- server/autolive/RestartReconciliation.js
- public/js/studio/BrowserExecutionOwnershipClient.js
- public/js/studio/BrowserExecutionActivation.js
- public/js/studio/ProgramPlaybackContinuity.js
- public/js/entries/control-room-app.js

Tests:

- test/durable-program.test.js (new)
- test/durable-program-crash.test.js (new)
- test/durable-program-validation.test.js (new)
- test/durable-program-reconciliation.test.js (new)
- test/program-identity-continuity.test.js
- test/autolive-retained-health.test.js
- test/browser-execution-config-bootstrap.test.js
- test/asset-reference-authority.test.js

Documentation: this file and BUILD-1003.7A1-BROWSER-OWNERSHIP-AUDIT.md.
Other existing A1/unrelated working-tree changes are outside this DP1 list.

## Automated validation

The initial durable-suite run failed 14 tests before implementation. The trusted
audio age-limit regression also failed before its playback-cue fix. Focused
ownership/reconciliation/durable/output/continuity/reference suites: 384 passed,
zero failed (`var/dp1-focused-final.log`). Full regression: 1,850 passed, zero
failed/cancelled/skipped (`var/dp1-regression-final-retry.log`); command:

`node --test --test-timeout=60000 --test-concurrency=2`

`git diff --check` passed. New DP1 files were also checked for trailing whitespace.
One preceding full run stalled without a result and was interrupted; the repeat
completed successfully. Two earlier full runs also completed successfully before
the last regressions were added. Operator-reported browser acceptance above is now
PASS, including Ctrl+Shift+R loading the active-health projection fix without a
Node restart. The initially rejected VIDEO confirmation was deliberately delayed
past the 60-second challenge lifetime: RECONCILIATION_EXPIRED with matching CAS,
followed by successful fresh prepare/confirm. It was not playback-induced CAS drift.
