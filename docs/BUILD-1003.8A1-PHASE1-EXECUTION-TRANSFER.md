# 1003.8A1 Phase 1 — Execution Transfer Contract & Readiness Model

Baseline: `3cfe1886486e9a6a00d99e3ea4d98d80c38ebf3c`. Branch: `build/1003.8A1`.
This is an isolated executable specification, not an execution feature. No runtime
entrypoint imports these modules. No HTTP route, grant, timer, filesystem writer,
Program command, observer subscription or production adapter is added. Existing
browser execution and Scheduler suspension are unchanged. No commit/push or live
server/browser operations are part of this phase.

## Transfer and CAS

The model transitions `BROWSER_OWNER -> TRANSFER_PREPARING -> NO_OWNER_FENCED ->
SERVER_CANDIDATE`. Invalid, stale or conflicting inputs terminate in
`TRANSFER_BLOCKED`; create a new explicit preparation to retry. There is no
`SERVER_OWNER`, commit method or automatic takeover. Every result is model-only,
with `executionAllowed:false`, `serverTake:false`, `transferReady:false`.

Preparation requires explicit operator authorization, the same browser instance,
a valid lease, a bounded transfer ID and a maximum 60-second challenge. These are
model assertions, NOT authentication or lease proofs. A future adapter must obtain
them from authenticated server authority, never browser assertions. Fencing models
confirmed release, rejection of the old grant, fencing of in-flight requests and
exclusive process authority. The model does not perform release. Only its expected
ownership revision may advance by exactly one at this edge; the immutable original
binding remains available. All other CAS values must match. Reconnect/another owner,
expiry, clock regression or later changes invalidate the candidate.

Bindings contain exactly bounded scalar fields: authority epoch/process; ownership
revision; durable generation; PRESENT/EXPLICIT_EMPTY; accepted base Program digest;
publisher session/revision; config revision; authorized source ID/fingerprint;
manual-intent revision; recovery revision; action revision; Scheduler SUSPENDED.
Missing/corrupt/unresolved Program is never explicit empty. Unknown binding fields
and invalid revisions/identities are rejected. Results are recursively immutable.

The Program digest hashes the validated canonical accepted envelope, not a
wall-clock projection. The model takes `acceptedProgram` from the authoritative
base, and ignores unrelated projected-position input. Any actually accepted
playback publication changes identity/revision/generation and invalidates CAS.
This is a model digest, not a change to DP1 or the retained wire protocol. A future
adapter must bind the exact server base and recheck after asynchronous work at the
durable commit boundary; merely checking at preparation is insufficient.

## Health capability matrix

| Producer | Presence | Playlist progress | Segment reachability | Decoder progress | Headless equivalent |
|---|---|---|---|---|---|
| External HLS | Transport evidence | Yes | Bounded probe | No | Unproven |
| Managed ingest | Publisher/tracks | No | No | No | Unproven |
| Browser decoder | Separate decoder sample | No claim | No claim | Yes | No transferable proof |
| Active Program | Bound Program sample | No claim | No claim | Yes | No transferable proof |

Capabilities are fixed by producer type; supplied `decoderEquivalent` flags cannot
upgrade HTTP evidence. Samples additionally require matching source/fingerprint,
authority epoch/process and bounded fresh timestamps (maximum 10 seconds). A sample
at its expiry is stale. Active Program progress must match Program identity and
ownership revision. This is a conservative model evidence window, not a change to
existing monitor expiry policy. At most eight samples are projected. Only bounded
enums/booleans enter diagnostics; URLs, credentials and arbitrary payloads do not.

All readiness results include `PHASE1_EXECUTION_FORBIDDEN`,
`HEADLESS_DECODER_EQUIVALENCE_UNPROVEN`, and `EXECUTABLE_RECOVERY_NOT_IMPLEMENTED`.
Additional blockers identify stale CAS, missing/expired evidence, source or Program
binding mismatch, unknown producer, missing decoder progress, incomplete transport
evidence and unproven action/Program atomicity. Even a caller's hypothetical atomicity
proof cannot authorize execution. No actual producer supplies headless equivalence.

Required future evidence is an independently validated, source-bound headless media
readiness/progress capability with expiry, generation/process fencing, uncertainty
and confirmed-loss semantics. HTTP 200, an advancing playlist, reachable segment,
ingest publisher or Technical Monitor ONLINE alone cannot satisfy it. Whether that
requires a headless decoder or an explicitly approved alternative remains a design
decision; this phase does not select or implement a backend.

## Recovery specification

The bounded immutable record describes action ID/type, originating CAS, action
revision, config/source identity, ownership epoch/revision, manual revision,
decision-evidence digest plus bounded observation summary, phase, commit status,
committed Program digest and captured return eligibility/target/cue/playback state.
There is no invented return target. A committed status requires a committed digest.
This is structural validation, not a verified transaction journal; supplied evidence
summaries/digests cannot be treated as authenticated proof.

Inspection covers before reservation, after reservation, before/after Program
commit, before transfer completion, during LIVE, during confirmed loss, and
before/after RETURN. Last recorded phase and observed crash boundary are separate:
an inconsistent/ambiguous reservation cannot be called an unreserved action.
No phase permits replay or RETURN. Observing an already committed Program produces
`OBSERVE_COMMIT_DO_NOT_REPLAY`; missing/stale/unknown outcomes require reconciliation.
New manual intent invalidates recovery even when a committed digest is present.

DP1 guarantees accepted Program durability, not atomic action reservation plus
Program plus transfer completion. A future executor needs a separately reviewed
atomic/idempotent action/Program protocol and authoritative recovery reader, including
safe crash reconciliation and asset references. A matching committed digest alone
does not prove current ownership, fresh health or return eligibility.

## Timing, manual intent and Scheduler

The specification constants match the current browser policies: 30,000 ms ENTRY,
15,000 ms confirmed loss. No timer runs in these modules. Browser uncertainty,
progress reset, active-health recovery and loss corroboration remain unchanged.

| Boundary | ENTRY accumulation | LOSS deadline | Retained LIVE identity |
|---|---|---|---|
| Browser reload | Not inherited | Not inherited | May be adopted after existing validation |
| Owner transfer | Not inherited | Not inherited | Revalidate identity and fresh bound observation |
| Server restart | Not inherited | Not inherited | DP1 restore plus explicit epoch reconciliation |
| Process crash | Not inherited | Not inherited | Durable validation; no timer/action resurrection |

No timing-continuity proof exists in this phase. Playback anchors are separately
preserved by DP1; they are not healthy-time credit. Retained authorized LIVE adoption
must not become a new entry gate merely because health observation restarts.

A newer manual revision invalidates transfer, candidate, pending action and RETURN.
There is no executable automatic commit in Phase 1; production grant fencing remains
the authority. Future automatic work must repeat CAS at its final commit point.

Scheduler remains SUSPENDED. Proposed priority only: manual intent dominates;
without valid ownership all automation is fenced; active AutoLive dominates a due
Program item; an active interruption requires captured return-target/CAS validation;
only otherwise may a Scheduler item become a candidate. No target is manufactured,
no overdue policy is chosen, no scheduler command runs. Future Scheduler and AutoLive
must share one execution owner. Existing server overlay scheduling is independent.

## Comparison and split-brain evidence

Tests call the real browser ENTRY controller/renderer harness, AutoLiveActiveHealth,
AutoLiveDecisionShadow and the new capability model. Synthetic media events and fake
clocks are explicit; this does not claim real headless decoding or live browser proof.

- Production advancing ENTRY and shadow mature at 30 seconds; only the browser path
  commits. A stalled prepared decoder cannot TAKE even when HTTP-only shadow matures.
- Active retained Program progress projects ONLINE while the external observation is
  OFFLINE/UNCERTAIN. The model reports disagreement rather than overriding Program.
- Transport ONLINE with a stalled Program gives browser CHECKING versus shadow
  LIVE_OBSERVED; transport cannot close the active session while corroboration is absent.
- Managed ONLINE lacks decoder progress. Stale timestamps, old process/epoch and
  changed fingerprints cannot become readiness.
- Browser confirmed loss reaches its 15,000-ms deadline; existing shadow uses strict
  `> 15,000`. This diagnostic difference is tested, not normalized or made executable.
- Current ownership is exercised in isolated temporary storage: two tabs, expired
  grant/delayed request, duplicate process, manual revocation and restart fencing.
- Model tests cover lost acknowledgement/idempotent observation, release proof,
  reconnect conflict, manual TAKE race and newly accepted Program invalidation.

There is at most one valid production browser grant. A model SERVER_CANDIDATE has
zero grants and cannot execute. Model proof booleans do not alter production state.

## Files and validation

New isolated modules:
- `server/autolive/ExecutionTransferContract.js`
- `server/autolive/ExecutionReadinessModel.js`
- `server/autolive/ExecutionRecoveryContract.js`

Tests:
- `test/execution-transfer-model.test.js` (new)
- `test/autolive-entry-gate.test.js` (two comparison tests added; existing assertions retained)

Documentation: this file. No existing runtime module changed, no new runtime import.
Validation on Windows / Node v24.15.0:

- New model suite: 69 tests, 69 pass, zero failed/cancelled/skipped;
  460.3649 ms. Two additional production ENTRY comparisons bring new coverage to
  71 tests; existing tests/assertions were retained.
- Focused 58-file matrix: 1,365 tests, 1,365 pass, zero failed/cancelled/skipped;
  69,735.4055 ms. Includes ownership/reconciliation, DP1, health/shadow,
  retained/initial health, ENTRY/loss/restore, Scheduler, Program Output,
  Control/Public/OBS, operator auth and media/reference authority.
- Syntax: all five changed/new JavaScript files pass. Candidate whitespace scan
  passes, including new files (which plain git diff does not inspect).

Logs are outside the repository in the OS temporary directory under
`livezone-1003-8a1-*`; unrelated local media and var artifacts were not edited.
One early full attempt was deliberately stopped before the final strict-boolean
authorization check; it is not counted as a validation result. The first completed
full run reported 1,927 pass / one file-level media-library.test.js failure,
zero cancelled/skipped, duration 136,892.9598 ms. No underlying assertion or error
detail was reported. That unchanged suite passed all 27 tests on isolated rerun
(9,049.1064 ms). No application/test workaround was introduced; the exact full
command was repeated. Do not interpret the unexplained first-run failure as a
diagnosed filesystem issue or silently count it as a pass.

Final full command: `node --test --test-timeout=60000 --test-concurrency=2`.
Repeat completed with exit 0: **1,939 tests / 1,939 pass / 0 fail / 0 cancelled /
0 skipped / 0 todo**, duration **144,202.7105 ms**. `git diff --check`: PASS.
Phase 1 model/regression acceptance passes; headless execution readiness does not.
No actual server execution capability has been enabled.

## Remaining prerequisite

Before even considering SERVER_OWNER, approve and prove both (1) capability-equivalent
headless readiness/loss evidence independent of Control, and (2) an atomic, idempotent
action/Program/ownership recovery protocol with final CAS and manual dominance.
Then separately authorize an executor adapter and ownership transfer integration.
Passing this specification does not authorize that phase or close those gaps.
