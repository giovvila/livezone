# 1003.7A1 browser execution ownership

Final candidate; uncommitted. Operator-reported A–L browser acceptance is PASS.
See [final verification](BUILD-1003.7A1-FINAL-VERIFICATION.md) for current totals and the complete commit manifest. Branch `build/1003.7A1`
starts at `77d46ac54dcca3498464a8a2d2ec5fb41e0a4078`. Closed A5 and UI baseline
branches are unchanged. No server media execution is implemented.

## Contract and enforcement

### Confirmed runtime fixes (2026-09-20)

The real browser confirmed `TypeError: Illegal invocation` at the ownership client's
stored native timer call. Default timers now call `globalThis.setTimeout` and
`globalThis.clearTimeout` through wrappers. Lease deadlines and renewal policy are
unchanged. Receiver-sensitive timer regressions now pass.

Identity generation uses `crypto.randomUUID`, falling back to a UUID built from
16 cryptographically random bytes via `getRandomValues`. It never uses Math.random.
Absent secure primitives yield NO_OWNER / SECURE_IDENTITY_UNAVAILABLE. This portability
issue was separate from the real-browser incident.

Control calls `startBrowserExecutionOwnership`, which isolates construction/startup
exceptions as NO_OWNER / OWNERSHIP_STARTUP_FAILED with an error-name diagnostic.
It retires any partial client's authority before returning a passive client.
No grant is invented. Authenticated configuration startup continues independently.
The passive AutoLive UI observes accepted configuration and Scheduler consent updates
without starting the executor. Temporary browser instrumentation has been removed.

The CLI installs idempotent SIGINT/SIGTERM/SIGBREAK shutdown handlers, closes HTTP
connections and drains the authority through the existing server close path. The
10-second shutdown timeout exits unsuccessfully; an unclean exit still fails closed.
Signal tests exercise the registered lifecycle handlers against real server/authority
instances. They do not force-stop the actual Windows service. WinSW/native console
delivery remains part of manual validation.

Initialization and maintenance now share an exclusive `.maintenance` gate. It is
held only during initialization/reconciliation. Existing authority locks are never
automatically removed. A crashed maintenance operation can leave its gate behind;
the command then refuses, requiring a separate reviewed recovery rather than guessing.

Historical validation immediately after these fixes: **143 focused tests pass; 1749 full tests pass,
0 fail, 0 cancelled**. Full duration: 106.7 seconds. Logs:
`var/a1-runtime-fixes-focused.log`, `var/a1-runtime-fixes-full.log`.
Both former intentional failures (timer receiver and randomUUID portability) are
now passing behavior regressions; historical red proof remains in
`var/a1-blocker-combined-diagnostic.log`. No full browser/service-stop validation
has been claimed. `git diff --check` passes.

```powershell
node --test test/browser-execution-config-bootstrap.test.js test/browser-execution-client.test.js test/browser-execution-lifecycle.test.js test/browser-execution-ownership.test.js test/autolive-entry-gate.test.js test/program-identity-continuity.test.js test/autolive-retained-health.test.js test/autolive-authority-client.test.js test/autolive-server-api.test.js
node --test --test-reporter=tap --test-timeout=60000 --test-concurrency=2
```

The authority grants either BROWSER_OWNER or NO_OWNER. A grant binds the
authenticated operator session, document instance, publisher session, durable
authority epoch, random authority process session, revision and secret lease ID.
Lease lifetime is 15 seconds; the client renews at most every 3 seconds and uses
a conservative local monotonic deadline. These are control-plane timings, not
changes to the AutoLive 30/15/5 second media policies.

`POST /api/studio/execution-ownership` supports acquire, renew, release and inspect
behind the existing operator session/origin/CSRF boundary. Grant responses include
the current retained Program for bootstrap reconciliation. Inspection and UI
diagnostics do not disclose lease secrets. Grants are document-local, never
persisted in browser storage. No public ownership or TAKE endpoint is added.

`server/program-output-server.js` checks ownership at Program POST ingress and
again immediately before durable commit/memory installation, after asynchronous asset validation and
mutation-queue waits. Automatic publications require the publisher bearer token,
operator session and `X-Livezone-Execution-Grant`, bound to the envelope publisher.
Queued requests retain their original grant; retries cannot borrow a later grant.
Expired/released/retired/restarted owners and arbitrary publisher sessions fail
with 409. Existing Program envelopes, store revision/session rules and public
subscriber protocol are unchanged.

Explicit manual Program activations and their playback/graphics updates use
`X-Livezone-Program-Manual: 1`, with the independent publisher token AND existing
authenticated operator mutation checks. This is a privileged manual path, not a
claim that a server can distinguish the intent of malicious authenticated code.
A manual publication from another publisher revokes browser ownership and
suppresses automatic acquisition until an explicit enabled/armed/source change.
Manual operations by the current owner retain normal controller precedence.

Control acquires ownership before starting its AutoLive controller. Opening a tab
does not publish a startup Program activation. A waiting tab can follow retained
Program without changing Preview. Ownership acquisition reconciles current retained
identity before controller startup; delayed VIDEO acquisition restores its playback
context. Loss of ownership cancels controller work without endSession/return/release.
Program guards and server ingress fencing independently reject stale work.
Passive tabs also cannot overwrite the owner's browser-stage observation.

Renewal failure can use only the remainder of an existing valid lease. Rejection
or expiry leaves a formerly owning document passive; reload is required to request
a new document identity. A never-owning tab polls for a grant. Unload release is
best effort: server expiry provides the fence if release is lost.

## Process exclusivity and restart limits

An exclusive `wx` filesystem lock at `<autoLivePath>.execution.lock` protects
one authority for the same configured persistence scope. The durable epoch at
`<autoLivePath>.execution` advances while holding the lock; every process also has
a fresh random identity. A second OS process cannot acquire the same scope.
All instances for the same channel must use the same local persistence path.
This is single-host enforcement, not multi-host failover or protection against
an administrator launching an independent channel with another data directory.

Normal close and CLI graceful signals remove the process's own lock. A crash leaves the lock behind intentionally;
the implementation never breaks a lock based on age or PID. Recovery requires
stopping all relevant processes, confirming the authority is absent, preserving
the epoch file, and explicitly reconciling only the abandoned lock. Corrupt epoch
or lock errors fail closed. Do not automatically delete runtime lock files.

A restarted authority rejects old grants and blocks acquisition until explicit
operator restart reconciliation binds the authoritative retained Program and issues
a fresh browser grant. The legacy authenticated manual Program activation plus
explicit consent path remains available, but must not be used merely to obtain ownership.
Reload retired Control documents.
DP1 now persists and validates base Program before memory installation and ACK.
NO_OWNER itself sends no clear/return/TAKE. Durable identity/playback recovery
does not guarantee uninterrupted decoding during a network/server outage.

Retired document IDs are retained for the process lifetime, bounded at 4096;
at that limit acquisition fails closed rather than forgetting replay defenses.
Background-tab throttling can expire a lease. Initial ownership requests depend
on normal HTTP completion; an unavailable/hung authority may delay Control startup.

## Automated evidence

The initial 12 tests were written and run before implementation at the baseline:
`var/ownership-before.log`: 12 tests, 0 pass, 12 fail. Cases 1–11 failed because
the ownership endpoint returned 404 instead of 200; case 12 exposed token-only
publication returning 202 instead of the expected 409. Thus the baseline lacks
the authority; those initial failures alone do not prove each later fence.

The cases cover first owner, second tab, expiry, clean release, replay, restart,
publisher binding, stale callback, renewal/F5 identity, NO_OWNER preservation,
duplicate authority and legacy-token rejection. Additional tests exercise a real
separate OS process, expiry during asset-queue waits, authenticated manual override,
secret redaction, retirement, client renewal/rejection and production-module
retained LIVE startup with first/second tabs and delayed loss callbacks.

Original pre-runtime-fix focused command (90 pass, 0 fail):

```powershell
node --test test/browser-execution-ownership.test.js test/browser-execution-client.test.js test/autolive-retained-health.test.js test/autolive-entry-gate.test.js test/program-identity-continuity.test.js
```

Full regression command:

```powershell
node --test --test-timeout=60000 --test-concurrency=2
```

Pre-runtime-fix full result: **1729 pass, 0 fail, 0 cancelled** (118.6 seconds), recorded
with the TAP reporter in `var/ownership-full-accepted.log`. Focused result is in
`var/ownership-focus-final.log`. `git diff --check` passes; new files also pass
the trailing-whitespace check. Nothing is staged, committed or pushed.

Existing real HTTP fixtures now identify fixture publications as authenticated
manual operations; token-only publication is explicitly tested as rejected.
Media, Program, UI, authentication, Scheduler, overlay and Preview assertions are
retained. One earlier concurrency-4 run had an unexplained worker failure in the
unchanged prepared-preview-video suite; its isolated rerun passed 8/8 and the
subsequent concurrency-2 full run passed. Logs remain local and uncommitted.
Later repeat runs exposed `ENOTEMPTY` cleanup races in two Media Library HTTP
fixtures: they removed their temporary directories before the new asynchronous
epoch write completed. Those fixtures now await authority readiness alongside
Scheduler readiness. Their safety assertions are unchanged.
A run with a 30-second per-test limit passed 1728 tests but cancelled the existing
Public/OBS idle test, which deliberately waits three 10-second phases. Use the
60-second limit above; the timeout was not an ownership assertion failure.

## Historical A1-only candidate files

Superseded by the complete A1 + DP1 manifest in the final verification document.

- `public/js/entries/control-room-app.js`
- `public/js/program-output/NetworkProgramOutputTransport.js`
- `public/js/program-output/ProgramOutputManager.js`
- `public/js/studio/AutoLiveEntryController.js`
- `public/js/studio/AutoLiveLegacyBridge.js`
- `public/js/studio/BrowserExecutionOwnershipClient.js` (new)
- `public/js/studio/DominantLiveController.js`
- `public/js/ui/DominantLiveUI.js`
- `server/program-output-server.js`
- `server/autolive/BrowserExecutionOwnership.js` (new)
- `server/autolive/AuthorityMaintenanceGate.js` (new)
- `server/autolive/ReconcileAuthorityLock.js` (new)
- `server/autolive/WindowsAuthorityProcessProof.js` (new)
- `server/GracefulShutdown.js` (new)
- `tools/reconcile-autolive-authority.mjs` (new)
- `test/browser-execution-ownership.test.js` (new)
- `test/browser-execution-client.test.js` (new)
- `test/browser-execution-config-bootstrap.test.js` (new)
- `test/browser-execution-lifecycle.test.js` (new)
- `test/browser-execution-process-proof.test.js` (new)
- `test/autolive-retained-health.test.js`
- `test/asset-authority-closure.test.js`
- `test/asset-reference-authority.test.js`
- `test/control-socket-pool-http.test.js`
- `test/external-hls-public.test.js`
- `test/operator-auth.test.js`
- `test/program-output-network.test.js`
- `test/programmable-crawl.test.js`
- `test/runtime-determinism.test.js`
- `test/server-schedule-api.test.js`
- `docs/BUILD-1003.7A1-BROWSER-OWNERSHIP-AUDIT.md` (new)

Unrelated local media, playlist, logo fixture and `var/` files are excluded.

## Historical completed maintenance procedure — DO NOT REPEAT

The operator confirms this reviewed operation is complete: epoch preserved, lock
archived, audit completed, unrelated Adobe/Codex processes untouched. Commands
below are historical evidence, not instructions for the current machine state.

The actual epoch and lock were NOT changed during implementation. Reviewed state:
epoch 13; abandoned PID 14284; process session
`a9c74573-3885-43bc-9423-8b6122da8df4`. The manually running server must first be
stopped with Ctrl+C in its terminal. Do not reconcile while it is running.

Use an elevated PowerShell terminal. Record the service's original StartMode before
temporarily disabling it; do not alter LivezoneMediaMtx. The process proof is scoped
to LIVEZONE authority evidence. It permits verified Adobe Creative Cloud application
entry points and Codex kernel/trusted-worker entry points, even when Codex's working
directory is this repository. It never whitelists PIDs. LIVEZONE server entries in
any worktree, a stray LivezoneNode wrapper, unreadable metadata, code-injection
options or unclassified Node launchers refuse reconciliation. Unknown applications
require identity review, not automatic termination. CIM access failure also refuses.
The positive unrelated classification checks the executable and actual entry script;
a vendor executable running the LIVEZONE server still blocks.

```powershell
Set-Location -LiteralPath 'C:\Projects\livezone-broadcast-engine-x'
$a1PreviousStartMode = (Get-CimInstance Win32_Service -Filter "Name='LivezoneNode'").StartMode
Set-Service -Name LivezoneNode -StartupType Disabled
Get-Service -Name LivezoneNode
node --input-type=module -e "import {proveWindowsOffline} from './server/autolive/ReconcileAuthorityLock.js'; const p=await proveWindowsOffline(); console.log(JSON.stringify(p,null,2)); if(!p.absent)process.exitCode=1;"
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
Get-Content -LiteralPath '.\var\studio-state\state.json.autolive.json.execution'
Get-Content -LiteralPath '.\var\studio-state\state.json.autolive.json.execution.lock'
```

Proceed only when service status is Stopped/Disabled, the scoped process proof passes
and port 8080 is unused. Unrelated Adobe/Codex processes remain running. The command independently rechecks these predicates while holding its
maintenance gate and exclusive HTTP port reservation. It validates the reviewed
epoch, PID, process session and the reviewed SHA256 hashes, and refuses a live/ambiguous recorded PID. Service
proof is checked twice. No PID/age-based automatic lock stealing is implemented.

```powershell
node tools/reconcile-autolive-authority.mjs 'C:\Projects\livezone-broadcast-engine-x\var\studio-state\state.json.autolive.json.execution' 13 14284 a9c74573-3885-43bc-9423-8b6122da8df4 66D3B6E1A4FF64AB0D94A93EEC15C5C66783D2D3ABA84EDE9FC70AE3954C5469 C935262750A348E6DA1304E5597E4D4C01E834AAC3B11BA260D0CC347C9644B9
```

Success archives the exact lock under `.lock.reconciled-<id>` and writes a PREPARED
audit plus a COMPLETED marker. The epoch bytes are never rewritten. If the reviewed
values differ, stop for a fresh review. If any proof fails, leave the files intact.
Do not use Remove-Item as a workaround. The operation assumes exclusive administrative
maintenance: no other operator may start old/unpatched servers or change files.
All updated servers sharing this authority path respect the maintenance gate.
This operation is deliberately limited to the single-host Windows/port-8080 deployment.

Keep the service Disabled during manual-server testing, then run `npm run serve`.
The epoch should advance to 14 and the authority should be available, initially
NO_OWNER / RESTART_RECONCILIATION_REQUIRED. This is expected and is separate from
the abandoned lock. Load Control; authenticated configuration controls must work.
Establish the intended Program with an explicit manual TAKE, then explicitly toggle
AutoLive consent off/on. Ownership can then be acquired; reload a previously retired
document if necessary. Never bypass this by resetting the epoch.

After manual testing, stop that server before restoring the service start mode.
Use the recorded mode (Auto -> Automatic, Manual -> Manual, Disabled -> Disabled),
then start exactly one service/server. Do not run WinSW and `npm run serve` together.

```powershell
$a1RestoreMode = switch ($a1PreviousStartMode) { 'Auto' { 'Automatic' } 'Manual' { 'Manual' } 'Disabled' { 'Disabled' } default { throw 'Review original service mode' } }
Set-Service -Name LivezoneNode -StartupType $a1RestoreMode
```

At this historical implementation checkpoint, the agent had not executed these commands against the current machine. The operator subsequently completed the reviewed maintenance procedure, as recorded in the final verification; do not repeat it.

## Historical broader manual test plan

The actual completed acceptance scope is A–L in the final verification report.
The scenarios below are a test plan, not a claim that every variant ran manually.

Use an isolated/test channel, authenticated Control, Public Viewer and OBS.
Record Program scene/source, Preview, Program revisions, private ownership
diagnostics and AutoLive transition counts. Never copy lease secrets into reports.
Reload all Control clients when deploying this gate: older clients' token-only
automatic publications are intentionally rejected.

A. One Control: acquire BROWSER_OWNER, arm an authorized HLS source, bring it
ONLINE. Verify exactly one complete 30-second ENTRY and one LIVE TAKE. Exercise
existing loss/recovery, manual TAKE, disarm and source change. Confirm 15/5-second
media policy behavior, Preview and scheduled overlays remain correct.

B. While established LIVE, wait 5–10 seconds and F5. Confirm retained LIVE,
ownership restored, no ENTRY/new gate/duplicate TAKE/release/Preview change.
Repeat with playing VIDEO and check playback continuity. If unload release is
lost, a new document must wait for lease expiry without publishing a replacement.

C. Open a second Control. Verify only one grant/controller executes, second tab
does not publish ENTRY or INACTIVE over LIVE, and retained output/Preview stay
stable. Perform an explicit manual TAKE in the second tab: it must succeed and
fence the previous owner without immediate automatic reacquisition.

D. With no manual suppression, close the owner. The waiting tab must acquire
after release or lease expiry, adopting retained LIVE without a new entry gate.
Repeat with abrupt owner loss so correctness does not depend on unload.

E. Disconnect the owner briefly, then reconnect before expiry: renewal validates
the same lease. Repeat beyond expiry while another tab acquires. Restore the old
tab; it must remain passive and stale queued publications must be rejected.
Reload it explicitly if another ownership attempt is desired.

F. During a controlled maintenance test, restart the authority with Control open.
Old grants must fail; NO_OWNER must not issue a clear/return/TAKE. Establish the
intended output with authenticated manual TAKE, change AutoLive consent explicitly,
then reload Control to reconcile (historical pre-DP1 path). Current DP1 restart
recovery uses explicit prepare/confirm against hydrated Program, without TAKE.
Separately validate duplicate-process rejection
using the same data path. Crash-lock recovery requires the procedure above.

G. Keep Public/OBS connected through C–F. Check that ownership ambiguity itself
does not clear or replace their Program, no new ENTRY appears, and overlays remain
independent. Distinguish expected network/server outage effects from ownership
mutations. Verify public requests cannot inspect/acquire/renew ownership and
legacy publisher tokens cannot execute automatic Program writes.

SERVER_OWNER is not a state or operation in this implementation. Authority
diagnostics keep `executionAllowed:false` and `serverTake:false`; no server ENTRY,
TAKE, LOSS, RETURN, decoder, automatic closed-Control takeover or Scheduler Program
execution is added. Operator-reported A–L browser/runtime acceptance now passes.

## Offline-proof refinement (2026-09-20)

The previous all-Node census was overbroad. The revised read-only Windows proof
was run on this workstation and returned absent=true with both Adobe processes
and both Codex workers positively classified as unrelated. Service configuration
remained Stopped/Disabled. No authority reconciliation was executed.

Focused validation: 46 pass / 0 fail across browser-execution-process-proof,
browser-execution-lifecycle and browser-execution-ownership. Includes actual
occupied-port refusal, live reviewed PID refusal, epoch/lock hash mismatches,
worktree/relative LIVEZONE entry paths and successful isolated reconciliation with
an unrelated Codex worker. Tests do not alter this machine's authority files.
The earlier 1749-test full result predates this scoped maintenance refinement.

For the currently paused maintenance session, do NOT repeat Set-Service, stop
Adobe/Codex, or restore/start the service yet. Re-run only the read-only proof and
reviewed hash checks, then invoke the six-argument reconciliation command above.
Verify the archived lock hash, unchanged epoch hash and COMPLETED audit afterward.
Keep the service stopped/disabled during the subsequent manual-server validation.


## Explicit restart reconciliation sub-gate (uncommitted)

The protected ownership POST now accepts prepare-reconciliation and reconcile.
Preparation is read-only and returns a server-recorded, session/document-bound
challenge, valid for 60 seconds (maximum 256 records). Confirmation atomically
compares epoch/process, complete retained base-envelope identity, AutoLive config
revision/source fingerprint, ownership revision and manual-intent revision before
issuing BROWSER_OWNER. No store.accept, TAKE, Preview change or server execution
occurs in reconciliation. Missing/malformed retained Program remains fail-closed;
an explicit empty envelope is distinct from an absent snapshot.

Authenticated manual requests invalidate challenges on arrival and block preparation
while pending, including before their publication reaches the mutation queue.
Duplicate confirmation is bound to the original operator/document and cannot extend
or resurrect a lease. The epoch stays reconciled after release/expiry/F5, but a new
server process requires a new explicit confirmation. Publisher tokens alone do not
authorize either operation; existing origin, request marker and CSRF checks apply.

Control displays RIPRISTINO RICHIESTO with RIPRISTINA CONTROLLO AUTOLIVE.
Preparation opens an explicit confirmation with the server's Program summary.
Absent/unresolved Program displays PROGRAM NON VERIFICABILE and disables confirmation.
Details retain expected identity, reconciliation ID/error and grant outcome, never secrets.
Retained-LIVE activation holds presentation/publication while the initial health
classification replay is unresolved, then uses existing A5 ownership and loss rules.
No new ENTRY or TAKE is required for authorized retained LIVE. Non-LIVE startup
replays already ONLINE source health into the existing full preparation gate.

Pre-DP1 validation record (superseded by the DP1 procedure linked below):
stop only the manually launched server with Ctrl+C;
restart npm run serve from build/1003.7A1. Do not repeat abandoned-lock maintenance
or alter its audit. Keep the stopped WinSW service stopped. Reload Control and use
only the explicit UI action. A real restart empties the current in-memory Program
store: expect PROGRAM NON VERIFICABILE unless authoritative retained state is
independently available. Do not seed it from browser storage or TAKE merely to
bypass this condition. Durable authoritative Program recovery was not implemented at this pre-DP1 checkpoint; DP1 and its completed runtime validation supersede this limitation.
Positive-path tests use isolated servers with authoritative retained envelopes;
real-browser positive acceptance remains a separate gate requiring that prerequisite.

Validation of explicit reconciliation: focused A1/ownership/continuity suites
191 PASS / 0 FAIL; full node regression 1797 PASS / 0 FAIL using
node --test --test-timeout=60000 --test-concurrency=2.
Logs: var/reconciliation-focused-final.log and var/reconciliation-full-verified.log.
At that earlier implementation checkpoint, browser acceptance had not run.
The subsequent operator-reported acceptance is recorded in the final report.

## DP1 durable Program follow-up

The pre-DP1 in-memory limitation above is addressed by
[1003.7A1-DP1 — Durable Program Authority](BUILD-1003.7A1-DP1-DURABLE-PROGRAM.md).
That document defines the commit/hydration contract, isolated crash qualification,
first-run implications and the current-machine browser acceptance procedure.
The historical abandoned-lock maintenance audit and epoch/archive state are
unchanged by final verification. The operator subsequently completed live restart,
reconciliation and post-fix browser acceptance; all A–L stages pass.
