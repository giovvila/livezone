# BUILD 1003.4D3 — asset authority closure

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Decision: **BUILD_1003_4D3_SAFE_MEDIA_DELETE_READY_FOR_RUNTIME_RESTART**.

This decision concerns the implementation and isolated regression tests. The running service was not restarted or modified. Production eligibility is conditional on the runtime census and reference checks after an authorized restart; no asset was deleted in production.

## Client census and upgrade policy

Current Control and Scheduler advertise version 3 with four bounded capabilities: canonical-catalog, preview-ownership-v2, asset-validation and channel-logo-authority-v1. The existing authenticated operator session identifies the principal; random per-tab client identity, generation and hashed resume token identify that tab. There is no browser fingerprinting.

The registry exposes CURRENT_CAPABLE, LEGACY/UNKNOWN and DISCONNECTED. Operator sessions without compatible registered participation block the census. Privileged API requests without identifiable client metadata create an unknown presence marker; Public and OBS do not participate. Known old clients retain their existing identity and references and must reload through a successful current handshake and catalog/alias reconciliation. A sibling tab with the same authentication cookie cannot silently erase an unknown participant.

Every server start invalidates the in-memory handshake epoch and restored active clients' confirmation. Every current registration/re-registration requires catalog and alias reconciliation again. Old capability traffic or a reconnected old SSE cannot certify the new epoch. Control also requires logo confirmation and Preview ownership for its current client generation. There is no unconditional production completeness flag.

The relevant population is authenticated current/recent operator participation plus durable client records, rather than an unprovable census of all historical browser installations. Authentication sessions are already process-local. Unresolved submitted catalogs, aliases and conflicts survive disconnect, revocation and restart. Offline legacy data must reconcile and validate before participating again; it is not imported by guessing filenames or replacing server records.

Request-only unknown markers are distinct from submitted legacy catalogs. They remain incomplete while their authentication session may participate. Explicit authenticated logout revokes that session and resolves a request-only marker only if it never submitted a catalog or reference payload. Recorded conflicts, invalid imports and aliases are never cleared by this rule. There is no automatic timeout, silent force-clear, or public bypass.

D2 request-only markers predate the explicit marker field. At upgrade, only an empty pending OBSOLETE marker can be classified this way. It is retired only if the authoritative process-local authentication store confirms that its former credentials are revoked. Retiring such a marker does not certify the new census epoch, release actual Preview sessions, or erase submitted catalogs. Development authentication bypass does not use this revocation inference.

No new automatic reload behavior was introduced. Old open operator tabs may require a manual reload/reconnect. Catalog conflicts require resolution; they intentionally continue to block deletion.

## Channel Logo mutation

`ChannelLogoAuthority` stores reference metadata in a private `.logos.json` file alongside the existing authority files. Entries are scoped to client and preview/program consumer. An assignment validates its full URL against managed repository metadata and validates image type; the stored reference is a canonical assetId. External HTTP(S) assets have no local repository file to delete. Malformed managed paths and missing/wrong-type assets fail closed.

The mutation acquires the same AssetMutationCoordinator used by DELETE, checks the entry revision, persists the new reference and retains previous references as pending. Only then does the UI apply the captured assignment. The client acknowledges the committed revision after application; that acknowledgement releases the previous references. A failure or lost acknowledgement leaves UNKNOWN and protects both assignments.

Clear follows the same sequence, so the old asset remains protected until the local clear has also been acknowledged. Program references remain independently protected by retained Program output. The UI captures the selected logo before awaiting the server; editing the input while a request is pending cannot apply an unconfirmed replacement.

Concurrent assignment and DELETE have one serialized order. Assignment first protects the asset and blocks DELETE. DELETE first removes the asset and assignment fails ASSET_UNAVAILABLE. Clear followed by DELETE remains blocked until acknowledgement. Stale revisions and superseded client generations cannot overwrite or clear the current reference. No renderer, Sponsor, Crawl or Program protocol change was required.

## Preview liveness and lost close

The authenticated presence SSE is per client/generation and bounded by the registered client population. Socket loss marks capability/Preview confirmation uncertain. A network interruption, throttled tab, missed heartbeat or laptop sleep never releases ownership.

Positive release evidence is an accepted explicit client close or authenticated session revocation through the existing logout path. Revocation releases Preview even when the page's close message was lost. A Control close releases only that client's ownership; logout revokes the owning authentication session, including its tabs. Neither operation discards persisted Studio, Sponsor or logo references. A late independent Preview cleanup cannot create a spurious obsolete-client marker after accepted close.

An unobserved browser disappearance with no explicit close and no session revocation remains UNCERTAIN. This is the required safe outcome when absence cannot be proved; no timer fabricates UNUSED. Operator text states: “Preview ownership cannot currently be verified.”

After restart, retained Preview records are uncertain. An active Control without its first Preview report also blocks completeness, even if no Preview record exists yet. Required ownership principals include the client generation, so a new Control cannot borrow the preceding generation's confirmation. Token-based Preview resume preserves references, accepts the newer ownership generation and rejects stale close/update callbacks.

## Exact completeness and deletion predicate

Global COMPLETE requires all of the following:

1. Every inventory provider is readable and complete; no delete recovery is pending.
2. The current server handshake epoch has been established; each relevant active client has current compatible capability confirmation; authenticated participation has no unregistered/unknown session.
3. All submitted Studio catalogs and legacy aliases are reconciled, with no conflict, invalid import or pending local-application acknowledgement.
4. Scheduler/Sponsor and persisted Studio references are authoritative.
5. Every active Control has both logo consumer records confirmed for its current generation; no logo entry is pending.
6. Retained Program identity exists and all managed URLs resolve deterministically.
7. All retained Preview sessions are confirmed, and every active Control has positively reported Preview ownership for its current client generation, or its participation has safely ended.

For asset X, deletion additionally requires zero persisted/runtime references, a normal repository asset/file, and the existing final audit inside the shared mutation coordinator. Other mutations serialize before or after deletion. The existing journal, quarantine and recovery checks remain in force. USED and UNKNOWN cannot be deleted. There is no force-delete or unconditional enablement switch.

## Operator status

The shared Media Library list receives global completeness, including when there are no assets. Control/Scheduler display REFERENCE CHECK COMPLETE or REFERENCE CHECK INCOMPLETE with concise reasons for reload/reconnect, Preview uncertainty, pending logo confirmation or catalog reconciliation. UNKNOWN rows retain their explanatory message and have no delete action.

## Validation

Baseline: 1214 tests. D3 adds 48 tests in `test/asset-authority-closure.test.js`, including real authenticated HTTP routes, SSE disconnect, logout revocation and a complete production-route eligibility/DELETE sequence using temporary assets and an ephemeral server.

The tests cover capable Control/Scheduler, unknown and old clients, token-based reload, epoch invalidation, reconnect reconciliation, disconnected legacy state, Public/OBS exclusion, all logo assignment/clear/race/type/revision cases, pending reference recovery, Preview uncertainty and positive release, multiple Controls, generation isolation, first-report absence, final delete recheck and captured UI draft application.

Full suite: **1262/1262 PASS**. Focused suite: **673/673 PASS**. Syntax: 85 JavaScript files, zero failures; the final three changed JavaScript files were also rechecked after the migration test. `git diff --check`: PASS. Logs are under `var/1003-4d3-*`. Syntax checks cover all changed/untracked JavaScript, including earlier build work. Tests use temporary authority storage rather than the service's private records.

No production service, browser, schedule, media asset, Program or Preview was manipulated. No stage, commit, push, .env change or MediaMTX change occurred. Public/OBS behavior, scheduled Program execution, AutoLive, Sponsor/Crawl timing and playback remain protected by regression coverage.

## D3 files

New:

- server/media-library/ChannelLogoAuthority.js
- public/js/studio/ChannelLogoReferenceClient.js
- test/asset-authority-closure.test.js
- docs/BUILD-1003.4D3-ASSET-AUTHORITY-CLOSURE-AUDIT.md

Changed:

- server/media-library/ReferenceClientRegistry.js
- server/media-library/PreviewOwnership.js
- server/media-library/MediaLibraryRoutes.js
- server/program-output-server.js
- public/js/studio/ReferenceClient.js
- public/js/entries/control-room-app.js
- public/js/ui/StudioGraphicsUI.js
- public/js/ui/MediaLibraryUI.js
- public/js/media-library/MediaLibraryManager.js
- test/asset-reference-authority.test.js (current protocol and dynamic gate expectations)
- test/safe-media-delete.test.js (dynamic gate expectation)

Earlier dirty workspace changes are outside this D3 list.

NEXT_STEP = AUTHORIZED LIVEZONENODE RESTART + CLIENT RECONNECT + SAFE DELETE MANUAL RETEST.
