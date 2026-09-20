# 1003.7A1 + DP1 final verification

Final verification only. Documentation synchronized; production and test code unchanged during this verification. No staging, commit, push, server restart or live authority reconciliation performed.

## Build and Git state

- Branch: build/1003.7A1.
- HEAD and work baseline: 77d46ac54dcca3498464a8a2d2ec5fb41e0a4078 (build/1003.6A1).
- HEAD parent: 808cd2f9b7e3a4a5b1473f1456ac9a399d2ccedc.
- Closed build/1003.5A5 remains 808cd2f; closed UI baseline remains 77d46ac.
- No configured upstream and no cached origin/build/1003.7A1 ref. Cached origin/build/1003.6A1 is 77d46ac. No fetch/push performed; remote existence was not asserted.
- Staged files: none. Proposed scope: 55 files (27 production, 24 tests, 3 documents, 1 maintenance CLI), comprising 27 tracked modifications and 28 new files.
- The M/NEW manifest below reports every in-scope tracked modification and untracked candidate. Exact remaining exclusions follow it. Local full porcelain inventory: var/a1-final-worktree.txt.

## Review findings

Reviewed the complete candidate diff against HEAD and new candidate modules/tests, not merely the tracked diff. No accidental production debugger/temporary browser interception, new console debug logging, hardcoded workstation PID/epoch/session/path or embedded authentication secret was found. The browser fetch-interception tool is explicitly excluded. Bounded RuntimeTrace provenance and collapsed operator diagnostics are intentional functionality.

New modules all have production or maintenance CLI import consumers. Test hooks/file-operation injection remain constructor-level isolated test seams with no HTTP/CLI bypass option. Test fixture tokens/identities are not production configuration. The randomUUID/getRandomValues compatibility fallback is deliberate tested fail-closed functionality, separate from the resolved real timer-receiver bug. Existing legacy first-boot continuity and authenticated durable activation paths have distinct prerequisites; neither is an alternative unfenced executor.

## Security and ownership

PASS: only BROWSER_OWNER/NO_OWNER; serverTake and server execution remain false. There is no server ENTRY/TAKE/RETURN or browser durable-import API. Automatic Program publications require publisher credentials plus a current authenticated browser grant bound to epoch, process, principal, document and publisher; final fencing occurs after asynchronous validation. The explicit manual path separately requires operator mutation authorization and is not a publisher-token-only escape.

Ownership/reconciliation requests retain origin, CSRF and operator-marker checks. Old epoch/process grants fail, a competing tab cannot steal an active grant, and authenticated manual intent invalidates prepared reconciliation. Missing/corrupt/unresolved retained authority blocks restart reconciliation rather than becoming empty. A new restart epoch is fenced; F5 in an already reconciled epoch is not a new restart. Challenges last 60 seconds, are bounded to 256 entries and bind Program identity/durable generation, config/source, manual intent and ownership revision plus operator/document identity. Expired/stale confirmation fails closed. Duplicate confirmation does not extend or resurrect its lease. Reconciliation mutates neither Program nor Preview.

Durable state is outside static serving. Grant/lease/auth/CSRF/publisher credentials are not persisted in the Program record. Source locators are the intended catalog data, not ownership credentials. Browser and server execution guards remain independent.

## Durability and limitations

PASS: candidate construction and validation precede staged write/flush/close; final CAS and ownership checks precede same-directory replacement and canonical-file flush; that commit precedes exact memory installation, ownership effects, notification and HTTP 202. Post-commit observer failure cannot undo or report an uncommitted publication. Shutdown drains pending work before releasing the exclusive writer lock.

Schema 1, SHA-256 canonical checksum and 128-KiB bound are enforced. Explicit empty is a real accepted envelope, never a missing-file substitute. Hydration preserves accepted publisher/revision/timestamps, playback anchors and bounded retirement history. Catalog/source/configRef and managed asset bindings are validated; historical durable asset references protect deletion. No older backup or orphan staging file is selected automatically.

Windows/Node 24/local NTFS isolated tests prove graceful recovery and old/new canonical recovery at tested process-exit boundaries, with injected write/short-write/flush/rename/uncertain-replacement failures. There is no delete-before-replace. A lost response after commit may leave the client uncertain; a failed/ambiguous replacement is not acknowledged and remains fail-closed. Sudden power-loss, directory-metadata persistence and hardware-cache guarantees are NOT claimed.

Known limits: single host/shared authority path, inherited Windows directory ACLs, managed assets byte-verified but external URL content not byte-verified, asset hashing/storage latency, unresolved dependencies requiring repair/revalidation or a legitimate new publication, no automatic corrupt-record rollback, and controlled validation required for downgrade/re-upgrade. Interrupted maintenance can leave a fail-closed gate; no automatic lock breaking. Live decoders/ONLINE health are not persisted.

## Real-browser acceptance (operator-reported, 2026-09-20)

| Gate | Result | Evidence |
|---|---|---|
| A | PASS | Reviewed lock archived, epoch preserved, audit complete, unrelated processes untouched; graceful shutdown releases lock. |
| B | PASS | New process requires explicit restart reconciliation; config remains usable. |
| C | PASS | Missing authoritative Program remains PROGRAM NON VERIFICABILE; browser state not promoted. |
| D | PASS | Legitimate MEDIA B TAKE creates valid durable record. |
| E | PASS | Restart hydrates MEDIA B with playback continuity and unchanged Preview. |
| F | PASS | Deliberate >60-second confirmation rejected as RECONCILIATION_EXPIRED with matching CAS; fresh prepare/confirm succeeds without TAKE. |
| G | PASS | Source ONLINE leads through full normal gate to LIVE. |
| H | PASS | Durable authorized HLS LIVE verified at generation 8, accepted epoch 17, revision 4. |
| I | PASS | Restart while broadcasting hydrates LIVE with no empty/fallback/ENTRY/new gate. |
| J | PASS | Epoch-18 reconciliation grants valid browser ownership and retained ADOPTED/LIVE without acquisition commands. Subsequent activation defect resolved in K/L. |
| K | PASS | First actual active-owner health projection fixed; construction emits nothing; readiness guard and 15-second loss policy preserved. |
| L | PASS | Ctrl+Shift+R, without Node restart, shows LIVE with Program/Preview unchanged and no ENTRY/TAKE/new gate. |

The earlier OFFLINE/unresolved trace mixed monitor observations and stale controller projection with healthy Program progress. Explicit provenance now separates these. Initial actual Program observation projects even when internally already ONLINE, then normal equal-state suppression resumes. Technical Monitor ONLINE alone cannot establish execution readiness. Automated tests cover genuine loss, recovery before deadline and legitimate closure after the existing confirmed-loss deadline.

## Final automated validation

Focused matrix: 1,294 tests, 1,294 pass, 0 fail, 0 cancelled, 0 skipped; duration 66,200.6956 ms. Exact file arguments: var/a1-final-focused-files.txt. Output: var/a1-final-focused.log.

Full command: node --test --test-timeout=60000 --test-concurrency=2.

Full completed run: 1,868 tests, 1,868 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; duration 132,854.9744 ms; exit 0. Output: var/a1-final-full-repeat.log. The first attempt stalled without failure output or final totals and was interrupted through its own test session; the exact command was repeated without code changes. That incomplete attempt is not counted as a passing run. The live server and unrelated Node processes were untouched.

git diff --check: exit 0 after documentation synchronization. All 55 proposed files, including untracked documents/modules, also passed a trailing-whitespace scan. Nothing is staged.

Open release blockers: none found. The incomplete first full-test attempt is recorded above as a test-run limitation; the repeat completed successfully.

Readiness: READY FOR COMMIT.

## Proposed commit

Message: feat: fence browser execution and persist authoritative Program

Push target after separate authorization: origin, refs/heads/build/1003.7A1 (establish upstream on first push).

Stage only the exact manifest below, never a blanket git add. Temporary diagnostic capture, local media and all var artifacts remain excluded.


## Exact proposed commit files

Status M = tracked modified; NEW = untracked candidate.

### production

- M `public/control/index.html`
- M `public/css/studio.css`
- M `public/js/core/RuntimeTrace.js`
- M `public/js/entries/control-room-app.js`
- M `public/js/program-output/NetworkProgramOutputTransport.js`
- M `public/js/program-output/ProgramOutputManager.js`
- M `public/js/studio/AutoLiveActiveHealth.js`
- M `public/js/studio/AutoLiveEntryController.js`
- M `public/js/studio/AutoLiveEntryPresentation.js`
- M `public/js/studio/AutoLiveLegacyBridge.js`
- M `public/js/studio/DominantLiveController.js`
- M `public/js/studio/ProgramPlaybackContinuity.js`
- M `public/js/ui/DominantLiveUI.js`
- M `server/program-output-server.js`
- M `server/program-output/ProgramOutputStore.js`
- NEW `public/js/studio/BrowserExecutionActivation.js`
- NEW `public/js/studio/BrowserExecutionOwnershipClient.js`
- NEW `server/GracefulShutdown.js`
- NEW `server/autolive/AuthorityMaintenanceGate.js`
- NEW `server/autolive/BrowserExecutionOwnership.js`
- NEW `server/autolive/ReconcileAuthorityLock.js`
- NEW `server/autolive/RestartReconciliation.js`
- NEW `server/autolive/WindowsAuthorityProcessProof.js`
- NEW `server/program-output/DurableProgramContract.js`
- NEW `server/program-output/DurableProgramRepository.js`
- NEW `server/program-output/ProgramCommitCoordinator.js`
- NEW `server/program-output/ProgramRestoreValidation.js`

### tests

- M `test/asset-authority-closure.test.js`
- M `test/asset-reference-authority.test.js`
- M `test/autolive-post-take-session.test.js`
- M `test/autolive-retained-health.test.js`
- M `test/control-socket-pool-http.test.js`
- M `test/external-hls-public.test.js`
- M `test/operator-auth.test.js`
- M `test/program-identity-continuity.test.js`
- M `test/program-output-network.test.js`
- M `test/programmable-crawl.test.js`
- M `test/runtime-determinism.test.js`
- M `test/server-schedule-api.test.js`
- NEW `test/autolive-initial-health-projection.test.js`
- NEW `test/browser-execution-client.test.js`
- NEW `test/browser-execution-config-bootstrap.test.js`
- NEW `test/browser-execution-lifecycle.test.js`
- NEW `test/browser-execution-ownership.test.js`
- NEW `test/browser-execution-process-proof.test.js`
- NEW `test/dp1-reconciliation-diagnosis.test.js`
- NEW `test/durable-program-crash.test.js`
- NEW `test/durable-program-reconciliation.test.js`
- NEW `test/durable-program-validation.test.js`
- NEW `test/durable-program.test.js`
- NEW `test/restart-reconciliation.test.js`

### docs_tools

- NEW `docs/BUILD-1003.7A1-BROWSER-OWNERSHIP-AUDIT.md`
- NEW `docs/BUILD-1003.7A1-DP1-DURABLE-PROGRAM.md`
- NEW `tools/reconcile-autolive-authority.mjs`
- NEW `docs/BUILD-1003.7A1-FINAL-VERIFICATION.md`

## Excluded worktree files

- `public/media/demo2.mp4`
- `playlist.m3u8`
- `public/assets/logo/logo-test.svg`
- `public/media/demo3.mp4`
- `public/media/imm.jpg`
- `public/media/test-audio.mp3`
- `tools/dp1-reconciliation-browser-diagnostic.js`
- `var/**` — every current runtime/state/media/audit/trace/log artifact, without exception. Complete path inventory: local `var/a1-final-manifest.json`.
