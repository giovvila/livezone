# BUILD 1003.4D1 — Asset reference authority

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4D1_ASSET_REFERENCE_AUTHORITY_BLOCKED

The reference authority, serialized mutation boundary, Preview leases, shared status UI and deletion recovery journal are implemented. Production deletion remains disabled. No service restart, production deletion, TAKE, stage, commit or push was performed.

## Completeness and release boundary

The production inventory deliberately includes an incomplete adoption domain for older clients and local catalogs. There is no API, environment flag or force-delete option that removes this guard. An initialized server Studio snapshot alone is not proof that every previously persisted browser catalog has been collected.

New Control clients import an initial compatible catalog into the existing StudioStateRepository and commit future source/scene metadata there before applying local changes. If an already initialized server catalog differs, the browser preserves its local catalog and blocks edits with CATALOG_AUTHORITY_CONFLICT. It does not silently overwrite either catalog. Reconciliation of conflicting or offline pre-D1 catalogs has not been automated or verified. Consequently, the system cannot yet prove production-wide absence of references.

Preview reporting is an authenticated bounded lease, not a change to playback authority. New clients report after Preview/graphics changes and periodically. The production guard also protects the adoption interval, legacy clients and runtime-only reconstructed definitions that have not been acknowledged. Before enabling deletion, the cutover must account for these clients and prove that runtime-only ownership cannot start during an unreported interval. An expired lease must not be mistaken for evidence that an unreachable browser has stopped rendering.

These are release blockers, not failed unit tests. The running backend was not restarted; deploying the new backend alone does not remove them.

## Canonical inventory

AssetReferenceInventory reads the existing Studio state, every persisted scheduler event, retained Program, effective output, static bootstrap/config assets and Preview sessions. It projects safe records containing canonical assetId, classification, kind, ownerId, ownerLabel and location. Details are bounded to 100 displayed references; the full count is retained. No raw snapshots, filesystem paths or authentication secrets are returned.

| Contract | Classification and policy |
| --- | --- |
| VIDEO / IMAGE assetId | PERSISTED; blocks deletion |
| AUDIO audioAssetId / stillAssetId / motionAssetId | PERSISTED; each slot independently protects its asset |
| Scene source reachability | PERSISTED; additional scene owner displayed |
| Sponsor payload.assetId | PERSISTED across future, active, expired and disabled events |
| Bootstrap Channel Logo / slate image | PERSISTED; full managed URL resolved to canonical repository ID |
| Retained Program and effective overlays | RUNTIME; retained output remains the owner |
| Preview | RUNTIME; union of authenticated session leases |
| Lower Third | Current schema has text, not an asset field |
| Text Crawl | Current schema has text, not an asset field |
| Unsaved source/Sponsor selections | TRANSIENT_DRAFT; no global reservation; SAVE revalidates |
| Gallery thumbnails / duration probes | Transient operational reads, not Program/Preview ownership |

Program projection currently strips asset IDs and retains URLs. The inventory resolves the complete managed URL through repository metadata, including URL decoding accepted by the file route. It does not infer identity from a filename. Unknown managed URLs or unsupported/unresolved asset IDs make the inventory UNKNOWN. Text containing an asset ID does not create a reference.

Static configuration is read for the running instance. Out-of-band edits and previously uncollected browser aliases are not certified by this snapshot. Legacy catalog aliases are resolved by the Control bridge to managed IDs or external URLs; unresolved or incompatible catalog shapes fail closed.

## Coordination and validation

AssetMutationCoordinator serializes MediaAssetRepository operations, StudioStateCoordinator catalog commits/initialization, ScheduleStore mutations, authenticated Preview updates and Program Output HTTP publication. The critical section encloses the final reference scan and the filesystem/manifest deletion operation. Scheduler evaluation and rendering are unchanged.

PUT /api/studio/state/catalog updates only source/scene domains in the existing repository and requires its current revision. The operator client stages edits against an isolated catalog, commits the proposed metadata on the server, then runs the existing synchronous local operation. A local application failure after server commit requires reconciliation; the server reference is not silently rolled back. A stale server revision rejects the edit.

Changed Sponsor events and catalog candidates validate asset existence/type before commit. Schedule deletion remains possible when an old invalid reference needs removal. The API returns ASSET_UNAVAILABLE for a stale Sponsor draft, displayed as ASSET NON DISPONIBILE. A reference cannot pass the coordinator while an asset is quarantined. This boundary assumes the existing single Node owner; it is not a distributed lock for multiple server processes or external file editors.

## Preview lifecycle

POST /api/media-library/preview-ownership creates a server-generated session tied to the authenticated operator session. PUT with a strictly increasing sequence replaces that session's asset set; DELETE releases it. Leases expire after 30 seconds; clients renew every 8 seconds. Multiple sessions protect the union. Wrong principals, stale sequences and expired sessions cannot replace newer ownership. Unconfirmed or explicitly uncertain sessions make completeness false; uncertainty retains previously reported references. Closed/expired sessions eventually clear. All routes use existing operator authentication and mutation/CSRF checks.

## Delete and recovery

DELETE /api/media-library/assets/:id remains canonical. The UI's earlier audit is advisory; DELETE repeats it inside the shared boundary. USED or UNKNOWN never authorizes deletion. The repository additionally refuses duplicate metadata owners of the same managed file. IDs and owned paths are validated, root/files/kind/temp/file links are rejected, and no arbitrary or recursive deletion is used.

The durable delete-journal.json records the validated asset and a generated quarantine basename before file movement. Journal and temporary manifest writes are flushed; manifest replacement remains atomic by rename. Normal ordering is journal, quarantine, manifest removal, quarantine unlink, journal removal. Exception rollback restores file and metadata. Failed recovery blocks further deletion/reference validation.

On a fresh process/repository initialization, a quarantined or original file is restored with metadata. If both file and metadata are absent, the completed unlink is acknowledged and the marker cleared. Ambiguous, malformed or traversal-bearing markers fail closed and remain available for recovery. Tests reconstruct a fresh repository at each interruption boundary. This covers process interruption; it is not a guarantee against storage-device failure, arbitrary external filesystem edits or every power-loss ordering on Windows.

There is no separate owned-thumbnail/derivative contract in the current repository. Only the managed file and its metadata are removed; unrelated files are preserved.

## Shared UI

Control and Scheduler receive server audit summaries with library refresh. USED requires complete inventory plus references; UNUSED requires complete inventory, zero references and eligibility; otherwise UNKNOWN. ALL/USED/UNUSED/UNKNOWN filtering is available. References are displayed in the existing confirmation dialog, and only an eligible final audit permits confirmation.

No optimistic removal occurs. Success emits the existing BroadcastChannel notification; both workspace directions are tested. A new reference after confirmation produces a conflict, retains the asset and displays the reference. No new Public/OBS mutation privileges were introduced.

## Validation

- Added 66 tests in test/asset-reference-authority.test.js, including deterministic mutation ordering, both deletion/reference outcomes, final rechecks, quarantine exclusion, duplicate DELETE, catalog CAS, Preview lifecycle/uncertainty, recovery boundaries, authorization, stale Sponsor API rejection, statuses and cross-workspace notifications.
- Existing regression fixtures now provide valid canonical media IDs. Missing/wrong-type Sponsor runtime tests inject corruption after a valid commit rather than asking the new API to create a broken reference.
- Focused suite: 602/602 PASS.
- Full suite: 1157/1157 PASS.
- Syntax: 28 changed/new JavaScript files checked.
- git diff --check: PASS; Git emitted line-ending conversion notices.
- Logs: var/1003-4d1-focused-final.log, var/1003-4d1-full-final.log, var/1003-4d1-diff-check.log.

Final checks are repeated after the last owned-root guard change. Real browser acceptance, old-client inventory reconciliation and production activation are not claimed by these tests. Successful deletion tests use complete isolated inventories; production tests explicitly assert UNKNOWN and denial.

## Files changed for D1

Server:
- server/media-library/AssetMutationCoordinator.js (new)
- server/media-library/AssetReferenceInventory.js (new)
- server/media-library/PreviewOwnership.js (new)
- server/media-library/MediaAssetRepository.js
- server/media-library/MediaLibraryRoutes.js
- server/program-output-server.js
- server/studio/StudioStateCoordinator.js
- server/studio/StudioStateRoutes.js
- server/scheduler/ScheduleStore.js

Client:
- public/js/studio/StudioReferenceAuthority.js (new)
- public/js/studio/PreviewOwnershipClient.js (new)
- public/js/studio/StudioCatalogManager.js
- public/js/entries/control-room-app.js
- public/js/media-library/MediaLibraryClient.js
- public/js/media-library/MediaLibraryManager.js
- public/js/ui/MediaLibraryUI.js
- public/js/ui/ScheduleOverlayEditorUI.js
- public/js/ui/StudioOperationalSourcesUI.js
- public/js/ui/StudioUI.js
- public/js/ui/StudioSourcesUI.js
- public/js/ui/StudioLiveSourcesUI.js

Tests:
- test/asset-reference-authority.test.js (new)
- test/authoritative-state.test.js
- test/server-schedule-api.test.js
- test/programmable-crawl.test.js
- test/schedule-overlay-editor.test.js
- test/sponsor-runtime-workspace.test.js
- test/safe-media-delete.test.js

Audit:
- docs/BUILD-1003.4D1-ASSET-REFERENCE-AUTHORITY-AUDIT.md (new)

Existing build/1003.4 changes and excluded local media were preserved. No .env, MediaMTX, playback/rendering implementation, AutoLive policy, scheduled Program execution or Program Output wire contract was changed for D1.

MANUAL_RETEST: Pending. First verify adoption/conflict handling and Preview ownership with separately loaded backend code. Production unused-delete acceptance remains blocked until inventory completeness and runtime adoption are proven.

NEXT_STEP = MANUAL RETEST SAFE UNUSED MEDIA DELETE

LIVEZONE BUILD 1003.4D1 ASSET REFERENCE AUTHORITY AUDIT COMPLETE
