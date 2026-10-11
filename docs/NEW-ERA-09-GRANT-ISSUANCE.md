# ERA entry grant issuance and recovery

The NEW-ERA-08 finding is a missing durable mutation class. NEW-ERA-09 adds only
grant issuance and its dependent Schedule publication coverage. The initial
protected TEMP probe demonstrated a separate defect within this class: two
identical unobserved issuance calls returned different incarnation IDs/hashes.
The initial failing log is retained; historical ERA07 PASS totals are not used
as evidence for the new boundaries.

`ScheduleStore.mutate` rejects client-owned identity metadata and checks the
expected Schedule revision before invoking `issueEraEntry` for insertion or
conversion to `source.live`. A retired historical event ID is rejected on both
paths. A legacy/unbound executable identity cannot be supplied as a new grant:
its identity metadata is rejected by the server-owned-identity fence. A new
operator-created event has a new executable identity even when an unavailable
historical string cannot be reconstructed from old history.

Issuance requires the active era, intact activation/forensics/retirement,
current authority lock/session/epoch and durable ControlledStart READY. It does
not acquire runtime ownership, reserve Start, advance epochs or consume Ledger.
The unchanged pinned durability abstraction performs native namespace barriers,
no-overwrite same-directory archive installation and verified cleanup.

NEW-ERA-10 supersedes the original retry policy. A first operation/incarnation ID
still derives from activation, event ID, executable request hash and its initial
exact Schedule predecessor. Before deriving a new ID, issuance now discovers
and validates the existing durable pending grant for that event. A matching
request with a compatible target predecessor reuses that grant's original bytes
and ID despite unrelated Schedule drift. A conflict or duplicate pending anchor
fails closed. See [NEW-ERA-10-GRANT-RETRY-CONTRACT.md](NEW-ERA-10-GRANT-RETRY-CONTRACT.md).

The Schedule API captures caller input and hashes type, source and interval,
excluding editorial labels and overwritten timestamps. Published incarnation IDs
are retained in server-owned `publishedEraGrants` inside the same durable Schedule
replacement. No separate request ID or completion file is created. Deletion or
conversion away from LIVE retains these publication receipts, so a later
deliberate new issuance is not mistaken for a pending retry. An unobserved
successful insert is recognized read-only and returns `alreadyPublished: true`.
Ordinary executable edits retain incarnation and advance entryRevision through
the existing Ledger edit fence.

Version-2 grant bytes contain ERA/transition/activation, retirement,
repository/HEAD, event/incarnation/operation, request hash and the captured
Schedule predecessor bytes/hash/revision. Incarnation identity is reproducible
before file creation; no random identity must be reconstructed from a partial
file. There is no invented Ledger history or verified-v1-migration claim.
Historical version-1 grants retain their existing admission contract; current
issuance produces version 2. Admission validates exact bytes/seal, ERA/event,
incarnation/operation derivation, retirement/activation/repository/HEAD and
Schedule predecessor binding. A pending stage is never executable.

| Actual state | Durable artifact | Legitimate retry |
| --- | --- | --- |
| NO_GRANT / authorized | Existing activated era, READY and Schedule predecessor | Recompute same operation ID; create stage |
| Staging | `grant-ID.json.stage`, absent/partial matching canonical prefix | Validate prefix; complete same bytes and same ID |
| Staging file/namespace durable | Full stage with file and native namespace barriers | Fence current authority/READY/Schedule; install same ID |
| Installing | Stage or installed destination; native no-overwrite archive | Inspect exact artifacts; never choose another ID |
| Grant durable | Canonical sealed `grant-ID.json`, native sync and readback | Discover and validate the pending anchor before deriving another ID; recognize/resync same bytes despite compatible Schedule drift; no Ledger consumption |
| Conditional duplicate full stage | Installed grant plus byte-identical stage | Verified native removal of duplicate stage; retain installed grant |
| Published / observable | Canonical Schedule contains server-issued metadata and retained publication IDs | Same insert is recognized read-only, including a stale expected revision; no second allocation |
| REVIEW_REQUIRED | Nonmatching installed/staged bytes or foreign binding | Fail closed; no event/identity publication or capture |

Publication IDs are retained inside the existing Schedule artifact. No separate completion file is invented: the installed sealed grant and its
exact native readback are the issuance evidence. A mismatched stage or grant is
not auto-deleted. Operator must preserve bytes, inspect the exact request and
predecessor plus owner census, and obtain explicit review before repairing any
corruption; a foreign grant is never adopted by changing ERA/event metadata.
Ordinary matching-prefix interruptions resume automatically after canonical
runtime-owner reconciliation and a separately approved restart where required.

Twenty-seven boundaries are enumerated in `test-support/EraGrantBoundaries.js`:
14 issuance points, including two conditional exact-stage cleanup points, and
13 dependent Schedule publication/observation points, including approved cleanup
of an unpublished Schedule stage after an injected write-path error. A focused
probe demonstrated that this grant-publication error path previously used raw
unlink rather than the required namespace abstraction. Only this grant path is
corrected; other Schedule operations retain their existing behavior. The conditional duplicate
stage represents a namespace state the cross-platform link/unlink archive
fallback can leave; Windows native archive uses a write-through atomic move.
Its conditional fixture is explicitly identified, not reported as an observed
Windows atomic-move failure.

The abrupt child activates a legitimate TEMP era and enters production
ControlledStart before calling the ordinary Schedule store insertion path.
At the selected hook it exits 73 without cleanup. Parent inspection records
grant artifact hashes and the original READY evidence. Recovery uses the
existing completed-owner Ledger/Scheduled/authority reconciliation and a new
approved Start operation; it never uses grant issuance to bypass ownership.
The original READY is verified unchanged before that recovery. The current
grant request is retried, or the published event recognized, with one grant.
Representative cases then run production Scheduled runtime/Ledger/PROGRAM
components: durable consume precedes capture, one capture, RETURN, END and
restart with no replay. The supported isolated health descriptor avoids H1,
transport/network and actual service/application launch.

The current canonical matrix preserves all original 470 rows and adds these
27 grant points. Native per-boundary results, aggregate totals, focused and
broader totals and preservation proof are recorded in the final report only
after execution completes. No real runbook is executed by this task.
