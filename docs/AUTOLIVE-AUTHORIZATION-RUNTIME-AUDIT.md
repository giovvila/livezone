# AutoLive authorization runtime persistence audit

DECISION: AUTOLIVE_AUTHORIZATION_RUNTIME_BLOCKED

BASELINE: C:/Projects/livezone-broadcast-engine-x, build/1003.3. The current dirty worktree, including the earlier 494-test authorization audit, is the authorized baseline. No reset, restore, clean, stash, staging, commit or push.

The operator's supported configuration attempt is authoritative. OPERATOR_CONFIGURATION_REQUIRED is FALSE. This audit does not attribute the reported failure to failure to configure a source.

SCHEDULER_WRITE_PATH: The actual rendered StudioLiveSourcesUI button has data-action=authorize and data-id=<source.id>. The list click listener calls handleClick, which validates kind=hls and enabled, then calls DominantLiveConfig.setAuthorizedSourceId. This action saves immediately. The current markup has an AUTO INTERRUPT toggle button, not an authorization checkbox followed by a separate authorization SAVE. SALVA LIVE SOURCE calls StudioLiveSourcesUI.handleSubmit and writes source metadata through catalog.addLiveSource/updateLiveSource. Schedule SAVE calls ScheduleWorkspaceUI.handleFormSubmit → ScheduleStore.save and writes scheduled items. Both SAVE handlers were exercised together with the production authorization action. No separate scheduler authorization policy was found in this frontend.

SCHEDULER_WRITTEN_SOURCE_ID: Automated integration runs capture `primary-live` and `live-selected-1`, respectively, from the rendered button, actual setter and retained record. A multiple-source run captures `live-selected-2` without substituting the first source. These are test observations, not the unknown ID from the operator's browser.

PERSISTED_AUTH_RECORD: The production writer produces `{version:1,armed:false,authorizedSourceId:"primary-live"}` in the MAIN LIVE integration case, under `livezone.studio.dominantLive.v1`. The false armed value is the existing independent AutoLive preference; selecting an authorized source does not implicitly arm the system. The source name must still resolve and display when disarmed. Schedule SAVE separately produces `livezone.scheduler.schedule.v1`, whose selected item contains `target:{kind:"source",id:"primary-live"}`. It neither contains nor overwrites dominantLive authorization. The source catalog uses `livezone.studio.mediaCatalog.overlay.v1`. No compatibility migration or guessed field alias was added. Actual browser records remain unobserved.

DOMINANTLIVE_READ_PATH: Config constructor → load → version/field checks → normalizeId → snapshot.authorizedSourceId. Control Room awaits catalog bootstrap and now emits AUTOLIVE_AUTH_READ immediately after it, before optional runtime setup. Controller subscriptions reconcile the same source ID against enabled HLS catalog entries, emit authorization diagnostics and render through DominantLiveUI. Late catalog notification from the previous fix remains intact. No browser localStorage was edited or cleared.

FIELD_CONTRACT:

| Surface | Identity |
| --- | --- |
| Rendered AUTO INTERRUPT button | data-id = catalog source.id |
| Source metadata SAVE | editingId or generated source.id |
| Schedule item SAVE | target.id with target.kind=source; legacy scene targets use sceneId |
| AutoLive persisted configuration | authorizedSourceId |
| DominantLiveConfig snapshot | authorizedSourceId |
| DominantLiveController resolution | catalog source.id equality, kind=hls, enabled |
| MAIN LIVE bootstrap | source.id=primary-live; scene.id=main-live; configRef=stream.primary |

PRIMARY_LIVE_FINDING: The previous audit's dependency doubles accepted primary-live unconditionally. The real StudioSourceManager requires configRef=stream.primary to resolve to an HTTP(S) URL at registration. schedule-app initialized this manager with an empty object, so it rejected primary-live and StudioCatalogManager omitted it. Control Room initializes the same manager with its loaded technical config. This asymmetry is reproduced using the real source manager and the repository's studio.json. Schedule now loads config.json through InitializeScheduleSources before manager initialization and catalog bootstrap. It does not log configuration values or change config files.

FIRST_DIVERGENCE: For the reproduced bootstrap-source case, the first divergence is source registration in Schedule, before authorization: initialize({}) leaves stream.primary unresolved, registration returns null and the catalog has no primary-live. For injected storage failure, the divergence was DominantLiveConfig.update: it changed its in-memory snapshot, swallowed the write failure, and the UI reported success although reconstruction had no authorization. These findings do not establish the first divergence in the operator's actual session, whose selected ID and diagnostics are still unavailable.

ROOT_CAUSE: Two proven defects: asymmetric technical configuration during Schedule bootstrap, and unchecked authorization persistence with false success feedback. The reported real failure could also occur after successful persistence if Control Room startup never reaches controller/UI binding; no such runtime exception was observed in this session. No cause is assigned to the operator or to health/acquisition behavior.

FIX:

- Initialize Schedule sources with the technical configuration required by bootstrap configRef sources, matching Control Room.
- Commit the authorization snapshot only after setItem and read-back agree. Report failure in the existing LIVE SOURCES feedback instead of falsely confirming success.
- Preserve safe controller behavior if revocation cannot be persisted: an invalid/deleted source still stops monitoring and remains DISARMED.
- Add bounded console diagnostics at actual authorization writes, post-bootstrap reads, reconciliation and controller start. No change to health evaluation, acquisition, stabilization or loss grace.

RUNTIME_DIAGNOSTICS: Browser console events are enabled in browser execution, allowlist their fields, suppress repeated identical records and stop after at most 100 events per page. No raw snapshots, URLs, credentials, tokens, cookies, exception messages or technical config objects are logged by this instrumentation.

```text
AUTOLIVE_AUTH_WRITE
{ sourceId, sourceKind, storageKey, schemaVersion, ok, reason }

AUTOLIVE_AUTH_READ
{ storedSourceId, normalizedSourceId, catalogMatch, finalAuthorizedSourceId }

AUTOLIVE_AUTH_CONTROLLER
{ authorizedSourceId, state, reason }
```

WRITE occurs at the existing immediate-save AUTO INTERRUPT action. A subsequent Schedule SAVE intentionally does not rewrite authorization. `ok:true, reason:PERSISTED` means write-back verification passed; PERSISTENCE_FAILED produces visible UI feedback. READ is emitted after Control catalog bootstrap even if later optional initialization blocks controller construction. CONTROLLER is emitted on initialization and authorization reconciliation; it is not a health polling log. ARMED_FALSE with a valid ID means source authorization resolved but the independent armed preference is off.

TESTS_ADDED: 12 tests in test/autolive-authorization-runtime.test.js. They cover real-manager primary-live registration, rendered AUTO INTERRUPT selection plus production source/Schedule SAVE and Control reconstruction for bootstrap/operator sources, repeated reload, Control → Scheduler → Control, late catalog hydration, exact selection among multiple sources, safe deletion/reconstruction, non-LIVE rejection and no implicit selection, explicit OFF, throwing and silently discarded writes, bounded/sanitized diagnostics, and failed revocation safety. The integration harness uses production source/config/catalog/UI handlers/ScheduleStore/controller and UI subscriptions, with a small DOM/FormData adapter and memory storage. It does not simulate browser navigation, origin separation or storage policy enforcement in a real browser.

REGRESSION_RESULTS: Focused authorization/dominant-live/live-sources/unified-sources/schedule-workspace suites: 207/207 pass. Full node --test: 506/506 pass; no skipped/cancelled tests. Syntax checks pass for all eight changed/new JavaScript files, and git diff --check passes. Logs: var/autolive-authorization-runtime-focused.log and var/autolive-authorization-runtime-all.log. The two prior audit logs remain unchanged.

EXISTING_UNSTAGED_WORK_STATUS: SHA-256 comparison of 50 baseline dirty/untracked files: 46 unchanged. Only control-room-app.js, DominantLiveConfig.js, DominantLiveController.js and StudioLiveSourcesUI.js received additional authorization-related edits. Existing modifications within them were retained. schedule-app.js was previously clean. No pre-existing file was removed.

PROTECTED_FILES_STATUS: Source health, MediaMTX publisher presence, stabilization, loss grace, Program Output, Public Viewer, OBS, scheduler playback continuity, ControlDesk collapse, auth, .env, MediaMTX config and P0-C1B.2 are unchanged relative to this turn's baseline.

GIT_STATUS: build/1003.3, dirty worktree retained, empty index. This turn changes five tracked files (the four named above plus schedule-app.js), adds InitializeScheduleSources.js, AutoLiveAuthorizationDiagnostics.js, the integration test, this audit and two test logs. All remain unstaged.

BLOCKERS: Browser discovery still returns no connected browser. The actual selected source ID, persisted browser record and runtime console events have not been observed. The normal-path integration tests succeed, and the reproduced defects are fixed, but the exact causal chain of the operator's reported session is not yet proven. The user was asked for the new console events; no localStorage editing is required.

MANUAL_RETEST:

1. Reload the Schedule page so the updated code runs, on the same origin as Control Room.
2. Use the existing intended LIVE source and AUTO INTERRUPT control. It saves immediately; if already ON, retain that exact selection. Use normal source/Schedule SAVE as needed. Confirm the source card and feedback reflect the selection.
3. With console log preservation enabled, capture AUTOLIVE_AUTH_WRITE; it must contain the exact chosen ID, hls, the dominantLive v1 key and ok=true. If the UI reports a failed save, do not edit storage: retain that diagnostic.
4. Return to Control Room. READ must show the same stored/normalized/final ID and catalogMatch=true; CONTROLLER must show that ID. Check the displayed source name independently of the AutoLive armed preference.
5. Reload and navigate Control → Schedule → Control. The source identity must remain exact. Capture absent/mismatched events or startup errors if the failure persists.
6. Keep health/acquisition/loss retesting deferred until authorization is verified.

NEXT_STEP = MANUAL RETEST AUTOLIVE AUTHORIZATION THROUGH NORMAL UI

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

LIVEZONE AUTOLIVE AUTHORIZATION RUNTIME AUDIT COMPLETE
