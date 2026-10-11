# NEW-ERA-10: grant retry identity across Schedule drift

Scope: fixes ERA08BA-GRANT-RETRY-SCHEDULE-DRIFT and directly related grant/publication idempotency. The final independent review is not resumed. No duplicate capture caused by the original defect is claimed.

## Identity and retry anchor

Previously, the version-2 operation/incarnation ID was derived immediately from activationHash, eventId, requestHash and the exact current Schedule SHA-256. The latter includes every event, editorial label, timestamp, revision, plan and era binding. Thus an unrelated Schedule write changed the key even when the issuance request was identical.

The initial derivation remains unchanged for a new operation. The server first discovers installed grants and validates their canonical sealed bytes, filename/incarnation/operation derivation, event, request hash, captured predecessor bytes/hash/revision, active executionEraId/transition/activation, retirement and repository/approved HEAD. Current authority and durable ControlledStart READY are checked before discovery and at the existing mutation fences. A canonical pending grant is the durable operation reservation: its existing operationId/incarnationId is sufficient; no new identifier is introduced.

The stable logical operation is the active activation, event ID, executable request (type, source ID, start/end interval), compatible target predecessor and outstanding publication status. The request hash follows the existing executable-identity contract: labels, enabled/priority settings, precheck/end/unavailable policies and server-overwritten timestamps do not define a new incarnation. Compatible insertion retries may publish updated non-identity settings; after durable publication, recognition is read-only and changing those settings requires an explicit update. Exactly one pending anchor is allowed for the target event. It must match the request, preserve predecessor publication IDs and not point to a future Schedule revision. It is reused byte-for-byte; the current Schedule snapshot is still fenced exactly throughout the attempt. Multiple, corrupt, foreign or conflicting anchors reject rather than allocate a replacement.

A partial grant stage at the original deterministic path resumes from a verified canonical prefix under unchanged predecessor bytes. An unknown stage after predecessor drift fails closed; it is never bypassed with a new ID. No artifact is deleted to manufacture authority. Exact duplicate stage cleanup retains the existing approved namespace path.

## Publication status without another durable file

Schedule-v3 with an active execution era can contain the server-owned array publishedEraGrants. Values are existing incarnation UUIDs, unique and retained across all normal Schedule mutations. Issued event metadata and its publication ID are written atomically in the existing Schedule replacement. Deletion and conversion away from LIVE retain the old ID. Snapshots without this optional field are accepted; currently published era events are also recognized as published and copied into the array on the next Schedule mutation. The field is neither accepted from event inputs nor erased by plan replacement.

This retained history is necessary to distinguish an unpublished retry from a new insertion after deleting a previously published event with identical executable fields. Grant bytes alone cannot distinguish those two histories. It adds no new identifier, artifact, write, namespace operation or mutation class.

## Schedule drift policy

| Change | Result |
| --- | --- |
| A: other events, plan, editorial labels, revision | Reuse the pending grant when target predecessor and request still match; retain exact current-byte fencing during the attempt. |
| B: pending conversion target name/createdAt/updatedAt; insertion retry name or overwritten timestamps | Compatible. Reuse original grant. Current editorial values enter the normal publication; no new incarnation. |
| C: pending request type/source/interval change, or target predecessor type/payload/interval/enabled/priority/identity change | Reject REQUEST_CONFLICT and preserve G1. A different new event ID is a separate operation. A pending conflicting request is not implicitly cancelled or superseded. |
| C: edit of already published LIVE executable fields | Existing update contract: retain incarnation, advance entryRevision, obey validateEntryEdit/Ledger fences. It is not another grant issuance. |
| New deliberate insertion after published deletion, or conversion back to LIVE | Old publication ID remains recorded; derive a fresh grant from the new current predecessor. Old incarnation is no longer admitted for the current target. |
| D: era, retirement, repository/HEAD, owner or READY lineage mismatch | Fail closed before a dependent write. Legitimate canonical authority restart within the same era validates current READY and can resume the original pending grant. |

After publication, the same insert without caller-owned identity metadata recognizes the current canonical event read-only (alreadyPublished: true), even if the caller retained the old expected revision. Changed executable fields must use update; insert does not edit the existing event. Caller-supplied identity or era metadata never supplies authority. A pre-publication insert with a stale expected revision still returns REVISION_CONFLICT; after refreshing revision it finds the original pending grant.

ScheduleStore keeps dependent issuance/publication in its existing mutation queue. Direct duplicate issueEraEntry calls are also serialized per Ledger path under the existing exclusive runtime authority ownership contract. The queue is not a replacement for durable evidence: after process loss the installed grant is rediscovered. No cross-process authority lock is weakened or added.

## Admission, Ledger and ownership

Issuance is corrected at the durable source of truth. eraAdmits shares canonical grant validation and rejects ambiguous pending anchors, changed target predecessors and publication history whose incarnation no longer belongs to the current event. A valid pending grant is still distinguishable from Ledger consumption; normal runtime obtains its event from the canonical Schedule. Executable edits and terminal records continue to use the existing entryRevision/Ledger and Scheduled ownership contracts.

No grant call creates an owner, advances authority, reserves Start, completes READY, consumes Ledger or captures a source. Production ordering remains grant -> atomic Schedule publication -> eligibility -> durable Ledger consume -> capture. The exact regression exercises one capture and restart/no-replay with the isolated component and health fixture, independently of H1.

## Durability and matrix

The correction adds read-only anchor discovery, validation and serialization; publication history is payload in the existing Schedule file. The stage/open/two writes/file flush/namespace flush/archive/sync and approved cleanup operations are unchanged. Existing 14 grant and 13 publication hook names remain exact, with no new durable mutation boundary. test/new-era-grant-matrix-mapping.test.js verifies 497 unique canonical IDs, exact 14/13 hook correspondence and the existing grant mutation primitives. The 27 native TEMP boundaries are rerun against current code; the original 470 rows remain historical execution evidence and are not claimed as freshly executed by this task. The final task report records the new subset evidence and distinct gate totals.

Helper, gate, protocol, pins and service-account requirement are unchanged. The retained LocalSystem proof is revalidated, not recreated. All mutations and capture fixtures use TEMP through the protected runner; no real runbook is executed.
