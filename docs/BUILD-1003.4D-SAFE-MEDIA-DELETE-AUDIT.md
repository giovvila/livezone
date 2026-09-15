# BUILD 1003.4D — Safe Media Library Delete audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4D_SAFE_MEDIA_DELETE_BLOCKED

The implementation adds guarded deletion infrastructure and shared confirmation UI. It does **not** enable production unused-asset cleanup. Every production DELETE is denied until the reference inventory is authoritative and complete. Zero references in a partial inventory never means unused.

## Blocking architecture

Current source/scene edits persist in browser localStorage (`livezone.studio.mediaCatalog.overlay.v1`), with legacy aliases in `livezone.studio.assetLibrary.overlay.v1`. Selection persists in `livezone.studio.selection.v1` and can also exist only in memory. StudioStateCoordinator initialization is not an ongoing authoritative catalog mutation channel. Preview has no authoritative ownership feed. Static bootstrap assets and browser overrides are not a complete server inventory either.

Enabling deletion requires an authoritative catalog/reference owner, complete legacy/bootstrap reference resolution, live Preview ownership, and coordination between reference creation and deletion. A client snapshot cannot prove the absence of other browsers' references. Those changes were not introduced implicitly into this protected baseline.

## Model and policy

- Canonical operator route: `DELETE /api/media-library/assets/:id`. Read-only audit: `GET /api/media-library/assets/:id/references`.
- The server rescans at DELETE time inside the repository operation. Known references return `ASSET_REFERENCED`; incomplete inventory returns `REFERENCE_AUDIT_UNAVAILABLE`, both HTTP 409.
- Production inventories include all persisted scheduler events, server Studio snapshot, ingress Program snapshot and effective output. Browser catalog/Preview is explicitly unavailable, so eligibility is always false in production.
- The scanner follows canonical IDs and indirect record links. Legacy managed URLs require the full managed path; filenames alone never establish identity.
- Fixtures cover VIDEO/IMAGE, AUDIO audio/still/motion, Sponsor, channel/slate logos, lower-third-like references, source/scene links and Program/Preview. This demonstrates scanner behavior, not complete production ownership coverage.
- Future, active, expired and disabled events remain protective while persisted. No historical schedule is rewritten to permit deletion.
- There is no force-delete. Optional USED/UNUSED filtering is omitted because a complete classification is unavailable.

## Filesystem and consistency

The repository validates canonical IDs and owned paths, rejects links at the checked files/kind/temp/file components, and deletes no arbitrary client-supplied paths. Unknown/repeated IDs return explicit not-found. Missing files fail without removing metadata. No current asset contract owns independent thumbnails or derivatives; unrelated files remain untouched.

Within the repository queue: audit, rename file to quarantine, remove metadata through the existing temporary-manifest/rename strategy, then unlink quarantine. Metadata failure restores the in-memory record and original file. Unlink failure restores the file and manifest and returns failure. Rollback failure returns DELETE_RECOVERY_REQUIRED and blocks further deletes in that process.

This is exception recovery, not a durable crash-recovery transaction. There is no persistent transaction journal or atomic coordination with schedule/catalog writers. These limitations must be resolved or explicitly designed before production deletion is enabled. Tests inject rename, manifest and unlink failures in isolated temporary repositories; no production asset was deleted.

## Shared UI and drafts

Control and Scheduler use the same MediaLibraryUI and backend. DELETE / REMOVE opens a dialog with “Eliminare definitivamente questo media?”, name, type, size and image thumbnail where applicable. Confirmation remains disabled until a complete audit establishes eligibility. References and unavailable inventory names are displayed. The existing BroadcastChannel notification is emitted after a successful delete; other workspaces retain their existing refresh listener.

An unsaved Sponsor selection does not become a persisted reference. Save refreshes the library and rejects missing assets or refresh failure with ASSET NON DISPONIBILE. This is a client preflight, not an atomic server guarantee against concurrent deletion after preflight. Production deletion remains blocked; save/delete coordination is required before enabling it.

Existing privileged Media Library authorization covers audit and DELETE. Public/OBS anonymous requests cannot delete. No GET endpoint deletes. Authentication, .env, MediaMTX, renderers, scheduler timing, Program Output protocol and Program/Preview behavior were not changed by this fix. No services were restarted, no TAKE was performed, and no stage/commit/push was performed.

## Validation

- New tests: 36 safe-media-delete cases plus 2 stale Sponsor draft cases; existing Media Library expectations updated for mandatory auditing.
- Focused: 293/293 PASS (`var/1003-4d-focused.log`).
- Full `node --test`: 1091/1091 PASS, zero skipped (`var/1003-4d-full-final.log`).
- Syntax: all 11 changed JavaScript/test files PASS.
- `git diff --check`: PASS; only existing LF/CRLF conversion notices.
- Shared confirmation and notifications are fixture/jsdom checks. Real cross-workspace deletion acceptance and visual browser testing were not performed. Successful deletion tests use complete isolated inventories, not the production inventory.

## Files changed for this fix

1. server/media-library/MediaReferenceAudit.js (new)
2. server/media-library/MediaAssetRepository.js
3. server/media-library/MediaLibraryRoutes.js
4. server/program-output-server.js
5. public/js/media-library/MediaLibraryClient.js
6. public/js/media-library/MediaLibraryManager.js
7. public/js/ui/MediaLibraryUI.js
8. public/js/ui/ScheduleOverlayEditorUI.js
9. test/safe-media-delete.test.js (new)
10. test/media-library.test.js
11. test/schedule-overlay-editor.test.js
12. docs/BUILD-1003.4D-SAFE-MEDIA-DELETE-AUDIT.md (new)

Existing build/1003.4 work was preserved. Generated test logs are under var. The running Node service has not been restarted to load these backend changes; loading them alone would not remove the architecture blocker.

MANUAL_RETEST: Not completed. Required unused upload/delete and Control/Scheduler propagation acceptance remain blocked by incomplete authority. After resolving that blocker and separately loading the backend, execute the user-specified unused/referenced/future/expired/draft/runtime acceptance matrix.

NEXT_STEP = MANUAL RETEST SAFE MEDIA LIBRARY DELETE

LIVEZONE BUILD 1003.4D SAFE MEDIA DELETE AUDIT COMPLETE
