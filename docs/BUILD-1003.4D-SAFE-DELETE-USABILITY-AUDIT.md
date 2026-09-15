# Safe DELETE usability regression audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4D_SAFE_DELETE_USABILITY_READY_FOR_MANUAL_RETEST

Implementation readiness only: the changed backend has not been loaded into the production service. No production DELETE, service restart, TAKE, stage, commit or push was performed. Existing unrelated worktree changes were preserved.

## Historical reconstruction

The operator's successful browser deletion is accepted as real evidence. Git cannot identify the exact intermediate working UI implementation: branch build/1003.4 still points to e249fa0, with D/D1/D2/D3 changes in the working tree. The retained D audit says production DELETE was blocked; that document does not invalidate the operator's observation, but cannot establish which deployed bytes they used.

At HEAD, server/media-library/MediaLibraryRoutes.js already exposes DELETE and defaults referenceGuard to `() => false`. server/program-output-server.js supplies no guard. MediaAssetRepository.delete validates ID/existence, evaluates the guard, then quarantines and removes the asset. Thus the retained endpoint predicate was authenticated authorized mutation + valid existing asset + guard returns false + filesystem operation succeeds. It did not prove zero persisted/runtime references. public/js/ui/MediaLibraryUI.js already has collapse behavior but its DELETE button is disabled; HEAD Scheduler HTML has no shared Media Library panel. These facts prevent claiming HEAD is the exact operator-tested combined UI state.

The earliest retained safe scanner, MediaReferenceAudit.inspect, adds `all inventory domains complete && references.length === 0`. The D audit describes browser catalog/Preview domains as unavailable, so this rule already blocks zero-reference assets. D1 makes completeness authoritative and adds the shared coordinator/journal. D2/D3 feed ReferenceClientRegistry.snapshot into AssetReferenceInventory.collect: every registered client's catalog/alias acknowledgement can veto all assets, even when its authenticated write capability has ended. This is the exact currently reproduced regression; a particular D1/D2/D3 commit cannot be named because those changes were never committed.

Current predicate: complete server/bootstrap/Studio/schedule/Program/effective-output domains + complete independent Preview/logo ownership + complete client authority census + no recovery issue + asset-specific referenceCount=0; final DELETE repeats this under the shared mutation coordinator, with ID/path/file/recovery validation. The UI audit is advisory.

## Current persisted census and write capability

The production census still contains these pending Scheduler clients, all generation 1, version 3, supported=true, confirmed=false, active=true, catalog=PENDING and legacyStatus=PENDING:

| ID | Last seen UTC |
|---|---|
| 1e8a44e7-bb31-4e95-a373-5287755d762e | 2026-09-14 06:57:22.140 |
| 2621e6df-d90d-4b91-b304-08424453ddb1 | 2026-09-14 06:58:49.341 |
| 1380d97a-5b23-42d5-9750-e58cf69bbd56 | 2026-09-14 07:19:02.310 |

The persisted active flag does not prove a live connection or valid credentials. There are also four reconciled/explicitly closed Control records and two reconciled/explicitly closed Scheduler records. Their full IDs/generations are in BUILD-1003.4D3-STUDIO-RECONCILIATION-MEDIA-PANEL-AUDIT.md. No record was deleted or rewritten by this audit. Live auth-store contents and browser connectivity were not inspected, so no production client is declared revoked based only on this file. The running backend must apply the authoritative session predicate.

OperatorAuth uses process-local sessions. A missing credential cannot pass OperatorRequestGuard.authorizeMutation. ReferenceClientRegistry already receives isSessionRevoked from this actual auth store, with development auth bypass deliberately returning false. This is positive credential invalidation, not elapsed silence. An expired session still retained in the map may conservatively block until auth sweeps it; the change does not infer expiry independently.

## Mutation gate audit

| Reference path | Gate and validation |
|---|---|
| Current Studio create/edit, image/video/audio/still/motion, scenes | StudioReferenceAuthority stages then PUTs catalog; StudioStateCoordinator serializes initialize/update/reconcile through assetMutations and validates candidate asset IDs/types. Local application follows server commit. |
| Legacy asset aliases in current clients | LegacyAssetReferenceAuthority submits/acknowledges references; ReferenceClientRegistry mutations share coordinator and validate assets. Submitted and pending aliases remain in inventory. |
| Sponsor and all persisted schedule events | ScheduleStore mutationCoordinator and referenceValidator; current and retained events remain inventoried. |
| Channel Logo | ChannelLogoAuthority mutation queue, validation and pending/previous reference union. |
| Program publication | Authenticated publisher accept runs validation and store acceptance inside assetMutations; retained/effective output inventoried. |
| Preview | Independent authenticated PreviewOwnership records; uncertainty and known references stay protective. |
| DELETE | Same coordinator, final audit, repository quarantine/journal and final filesystem checks. |

Old browser code can still mutate its localStorage/in-memory catalog without the current StudioReferenceAuthority. The optional authority branches in StudioCatalogManager and StudioAssetLibrary demonstrate that bypass. Therefore unsupported legacy clients remain conservative vetoes, even if their HTTP credentials are gone: revocation alone does not certify their old local runtime. Network silence and a shared principal never certify a current pending client either. This fix certifies only current supported v3 clients whose server credentials are positively invalidated. It does not claim control over external disk edits or multiple Node owners.

## Fix and preserved safety

ReferenceClientRegistry.isHistoricalNonwriter requires coverageProven, supported current version at least 3, and isSessionRevoked(principal) exactly true. snapshot excludes only such records from the catalog/alias/capability veto and labels them `HISTORICAL / NON-AUTHORITATIVE`. It preserves every stored record, pending state and legacy reference. Resuming with new authentication immediately makes the record subject to normal pending/current checks again. Neither a new unrelated ID nor age triggers classification.

The global inventory still protects genuinely unresolved writers and runtime ownership. Asset-specific zero-reference eligibility works once those real uncertainty domains are clear. Known historical aliases continue to make their asset USED; other assets can be UNUSED. Existing conservative UNKNOWN precedence when another real authority is incomplete is unchanged. Preview/Program/Sponsor/logo references, pending mutations, final recheck, ID/type validation, auth, shared-library notifications and journal/quarantine are unchanged. No new authority layer or force-delete switch was introduced.

## Validation

Added 16 tests in test/safe-delete-usability.test.js. Its production-path fixture starts the real server on an ephemeral port with temporary media/Studio/schedule/authority stores and real auth/CSRF requests. Current Control and Scheduler reconcile via HTTP, including empty Preview and logo acknowledgements. A separate v3 client's session is invalidated while its pending census record survives: its attempted catalog PUT gets 401, asset X reports UNUSED, and HTTP DELETE succeeds. This is fixture media only.

Opposite cases verify valid-but-disconnected pending clients, active legacy clients, unsupported clients with revoked credentials, absent revocation proof, retained pending aliases, current Preview ownership, uncertain historical Control runtime, token resume, restored census, final recheck, and queued catalog-before-DELETE. A deleted asset cannot later be committed into the catalog. Anonymous Public/OBS requests remain denied. The first retained safe scanner's completeness predicate is also reconstructed in a test.

Existing focused suites cover Sponsor/Program references, source/audio/still/motion assignments, both mutation/delete orderings, journal/quarantine interruption recovery, and Control/Scheduler library notifications. They run alongside the new cases.

- Focused: 224/224 PASS, var/1003-4d-usability-focused.log.
- Full: 1334/1334 PASS, var/1003-4d-usability-full-recheck.log (baseline 1318).
- First full run: 1333/1334; isolated Windows EPERM renaming a temporary fixture manifest in an existing test. Unchanged-code full repeat passed.
- Syntax: ReferenceClientRegistry.js, program-output-server.js, safe-delete-usability.test.js PASS.
- git diff --check PASS.

Files changed for this task: server/media-library/ReferenceClientRegistry.js (logic); server/program-output-server.js (comment correcting lifetime description only); test/safe-delete-usability.test.js; this audit.

## Manual readiness

The backend change requires a separately authorized LivezoneNode load/restart before production acceptance. No such restart was performed. After loading, use current Control/Scheduler and inspect reference completeness; verify that only positively invalidated supported historical clients lose their global veto. Verify a deliberately unused test upload can be deleted and both libraries refresh; referenced/runtime-owned media must remain protected. Do not infer success for the existing production census before that runtime check. The exact first operator-tested uncommitted UI snapshot remains unavailable.

NEXT_STEP = MANUAL RETEST UNUSED ASSET DELETE WITHOUT WEAKENING ACTIVE-WRITER SAFETY
