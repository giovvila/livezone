# BUILD 1003.4D2 — asset reference adoption and runtime ownership

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Decision: **BUILD_1003_4D2_SAFE_MEDIA_DELETE_BLOCKED**.

Production DELETE remains disabled. Automated tests prove the listed mechanisms in isolated fixtures; they do not establish adoption of every production browser. No service was restarted. No stage, commit, push, production deletion, TAKE, environment edit, or MediaMTX change was performed.

## Client adoption matrix

| Client / editor | Mutation and identity path | Revision / conflict | Audit result |
|---|---|---|---|
| Current Control | v2 capability handshake; StudioReferenceAuthority stages canonical sources/scenes before local application | Server revision, stale revision rejection, explicit local application acknowledgement | Implemented and tested; installed browser census unproven |
| Current Scheduler | Same handshake and StudioReferenceAuthority, now wired in schedule-app | Same reconciliation and conflict path | Implemented and tested; installed browser census unproven |
| Source/catalog editor | StudioCatalogManager wrapper commits through shared server mutation coordinator | No browser revision can overwrite newer server state | Implemented and tested |
| Audio still artwork | Canonical stillAssetId through catalog mutation | Server existence/type validation and revision | Implemented and tested |
| Audio motion artwork | Canonical motionAssetId through catalog mutation | Server existence/type validation and revision | Implemented and tested |
| Legacy asset alias editor | LegacyAssetReferenceAuthority reverse-resolves full managed paths; server stages references before local persistence; old and proposed references coexist until acknowledgement | Per-client generation and legacy application revision | Implemented; unresolved/malformed aliases retain INCOMPLETE |
| Channel Logo | StudioGraphicsUI accepts manual URL/path and applies locally; Preview reports it afterward, Program projection retains published identity | No server reservation before manual assignment | **NOT ADOPTED: assignment race remains** |
| Scheduled Sponsor editor | Existing ScheduleStore validation and shared mutation coordinator retain canonical logoAssetId independently of suppression | Schedule revision and existence/type validation | Covered by existing D1/Sponsor tests and D2 ownership tests |
| Other graphics | Current lower-third/crawl payloads are text; static asset-backed graphic definitions are inventoried | Static configuration read by server | No additional runtime asset assignment authority proven |

Channel Logo is not merely a static configuration toggle: manual URLs exist in StudioGraphicsUI. Protecting its static definition and already-reported runtime payload is insufficient to certify an assignment that has not reached the server. D2 therefore exposes `CHANNEL_LOGO_ASSIGNMENT_AUTHORITY_UNPROVEN` as an independent production completeness reason. This must be resolved before any future census certification enables deletion.

## Reconciliation and completeness

The server validates catalog schema version, canonical asset existence/types, and its current revision. Reconciliation is an additive union by source/scene ID with deterministic ordering. Identical records are idempotent; nonconflicting browser-only records are imported; server-only records survive. A differing record with the same ID produces CONFLICT without replacing server bytes. Malformed legacy storage is not reduced to a silently accepted valid subset. Initialization does not rewrite browser catalog storage. Later edits preserve server-only records that this browser did not own.

Catalog removal is guarded by PENDING before server mutation and an explicit acknowledgement after local application. A lost acknowledgement leaves INCOMPLETE. Legacy alias changes retain both old and prospective references through this interval. Reconnect preserves pending alias references and revisions.

`GET /api/media-library/reference-inventory` exposes COMPLETE or INCOMPLETE with reasons and bounded diagnostics. Individual assets expose USED / UNUSED / UNKNOWN. Any incomplete domain yields UNKNOWN and no delete button. Final deletion still checks reference count and completeness inside the shared mutation queue.

The v2 client registry requires canonical-catalog, preview-ownership-v2, and asset-validation capabilities. Missing/obsolete operator request identity creates a durable uncertainty marker. SSE uses client ID/generation query metadata; ordinary requests use headers. Resume secrets are not sent in those headers/queries or diagnostics. Generation plus a hashed resume token protects session replacement. An obsolete marker cannot be silently removed by a new browser with an ambiguous shared session.

Production has no public endpoint or environment switch to assert a completed census. `coverageProven` defaults false; true is used only in isolated tests with a deliberately bounded client population. The required list of historical Control/Scheduler machines and browser profiles, including offline profiles, has not been supplied. An offline localStorage catalog cannot be inferred absent from lack of traffic.

## Preview and Program ownership

Preview sessions persist reference sets, sequence, generation and a hashed resume token. Expiry marks a session uncertain; it never deletes the reference set. Restart restores sessions as uncertain. Corrupt persisted records fail closed. Normal silence, background throttling, a network pause, and sleep therefore cannot make an active asset UNUSED.

Delivered pagehide explicitly releases that client's Preview ownership. ENGINE_STOP instead reports uncertainty. Two Controls sharing an authentication cookie have distinct ownership principals. A stale generation cannot update or close a resumed session. Reconnect with a valid token can change authentication session while retaining references until a new report is accepted.

**Close limitation:** a lost pagehide/keepalive request cannot prove browser absence. The durable record remains uncertain until a valid reconnect/report or explicit close is received. Automatic eventual release after an unobserved true close is not proven and is not claimed. A timeout would reintroduce the forbidden silence-means-absence assumption. Normal delivered close is tested; crash/lost-close liveness remains a blocker.

Retained Program VIDEO, IMAGE, AUDIO, still and motion ownership is resolved through complete managed URL paths and repository metadata, never filenames. Missing retained Program identity and unresolvable managed URLs fail closed. External LIVE has no managed asset identity unless its payload includes a managed reference. No Program wire contract was changed by D2.

Persisted scheduled Sponsor and static Channel Logo references remain protective during ENTRY, LOSS, BREAK and Control closure. Effective Sponsor adds a runtime owner. These tests prove reference retention for known assignments; they do not prove atomic adoption of the manual Channel Logo assignment path.

## Validation

Baseline: 1157 passing tests. D2 adds 57 tests: 55 in asset-reference-adoption.test.js and two HTTP lifecycle/adoption tests in asset-reference-authority.test.js.

Coverage includes valid import, idempotence, additive reconciliation, same-ID conflict, version/revision mismatch, malformed storage, deleted asset references, unrelated storage preservation, Control/Scheduler catalog mutation, audio still/motion, obsolete capability, explicit census uncertainty, application acknowledgement, durable recovery/corruption, pending aliases across reconnect, quiet intervals up to eight hours, explicit close, multiple Controls, stale generations, Program identity, overlay suppression, UNKNOWN UI and safe bounded diagnostics. HTTP tests exercise real authenticated routes and shared-cookie isolation.

Focused suite: 609/609 PASS. Full suite: 1214/1214 PASS. Syntax: 81 JavaScript files checked, zero failures. git diff --check: PASS. Logs are under var/1003-4d2-focused.log, var/1003-4d2-full.log and var/1003-4d2-syntax-summary.txt.

One legacy source-text assertion prohibited any pagehide listener; it now verifies pagehide cannot invoke playback/UI teardown while allowing ownership release. Endpoint test fixtures isolate new durable authority files under temporary directories. The fixture re-exports existing server helpers. This prevents tests from writing adoption markers into the service's private state.

No real browser lifecycle or production adoption test was performed. The service continues to run its existing loaded code.

## Files changed for D2

New implementation files:

- server/media-library/AssetAuthorityDiagnostics.js
- server/media-library/ReferenceClientRegistry.js
- server/studio/ReconcileReferenceCatalog.js
- public/js/studio/ReferenceClient.js
- public/js/studio/LegacyAssetReferenceAuthority.js

Existing implementation files changed (including files introduced by D1):

- server/media-library/AssetReferenceInventory.js
- server/media-library/PreviewOwnership.js
- server/media-library/MediaLibraryRoutes.js
- server/studio/StudioStateCoordinator.js
- server/studio/StudioStateRoutes.js
- server/program-output-server.js
- public/js/auth/OperatorSessionClient.js
- public/js/entries/control-room-app.js
- public/js/entries/schedule-app.js
- public/js/scheduler/ScheduleApiClient.js
- public/js/program-output/NetworkProgramOutputTransport.js
- public/js/studio/StudioReferenceAuthority.js
- public/js/studio/PreviewOwnershipClient.js
- public/js/studio/StudioAssetLibrary.js
- public/js/ui/StudioAssetsUI.js
- public/js/ui/MediaLibraryUI.js

Tests/documentation:

- test/asset-reference-adoption.test.js (new)
- test/asset-reference-authority.test.js
- test/safe-media-delete.test.js
- test/unified-sources.test.js
- test-support/ReferenceAuthorityTestServer.js (new)
- This audit
- Fixture import only: test/authoritative-state.test.js, test/external-hls-public.test.js, test/large-video-range.test.js, test/operator-auth.test.js, test/media-library.test.js, test/program-output-network.test.js, test/schedule-overlay-editor.test.js, test/runtime-health.test.js, test/runtime-determinism.test.js, test/programmable-crawl.test.js, test/server-schedule-api.test.js, test/sponsor-runtime-workspace.test.js.

The workspace already contained changes from earlier builds; the overall git diff is not the D2 change list.

## Remaining blockers and next step

1. Actual historical browser/profile census and production reconciliation remain unproven.
2. Manual Channel Logo assignment still lacks canonical server reservation before local application.
3. Unobserved true close cannot be distinguished from a live but silent client. Safety is enforced; automatic stale-session release is not proven.

DELETE_ENABLED = no.

NEXT_STEP = RESOLVE REMAINING ASSET AUTHORITY GAP.
