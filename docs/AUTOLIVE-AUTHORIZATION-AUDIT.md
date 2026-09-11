# AutoLive authorization audit

DECISION: AUTOLIVE_AUTHORIZATION_BLOCKED

BASELINE: C:/Projects/livezone-broadcast-engine-x, branch build/1003.3. The existing dirty worktree was retained as the authorized baseline. No reset, restore, clean, stash, stage, commit or push was run.

AUTHORIZED_SOURCE_EXPECTED: Unknown. MAIN LIVE is the bootstrap source `primary-live` (scene `main-live`) in public/config/studio.json. This is a source definition, not evidence that the operator selected it. The IDs and previous authorization of primecast and test rtmp cannot be established from repository configuration. No source was selected by this audit.

AUTHORIZED_SOURCE_ACTUAL: The operator reports a checked checkbox, DISARMED and NO AUTHORIZED SOURCE. The actual stored ID and browser catalog were not accessible. Browser setup succeeded, but selection returned “No browser is available” and discovery returned an empty list. The original controller would report NO AUTHORIZED SOURCE as its status for armed=true with no resolved source; DISARMED with a checked checkbox therefore also requires investigation of whether startup reached UI binding. The static HTML initially contains DISARMED / NO AUTHORIZED SOURCE. This is an unresolved hypothesis, not a diagnosed bootstrap failure.

AUTHORIZATION_STORAGE: Browser localStorage, origin-specific key `livezone.studio.dominantLive.v1`, schema `{version:1, armed:boolean, authorizedSourceId:string|null}`. Catalog overlay key `livezone.studio.mediaCatalog.overlay.v1`, current schema version 3. Config and catalog persistence are separate. No browser storage was changed or cleared. No schema version change was needed. Existing v1 bootstrap IDs now pass normalization; previously the `live-*` restriction rejected `primary-live` and returned a fully disarmed default. If an earlier write already replaced an ID with null, the prior choice cannot be reconstructed safely from the remaining source names.

AUTHORIZATION_HYDRATION: DominantLiveConfig synchronously loads its policy in its constructor and later handles storage events. Catalog initialize synchronously loads its overlay and registers sources/scenes after StudioBootstrap fetches and validates studio.json. Catalog now notifies subscribers after initialization. Unknown saved IDs remain persisted while unresolved; they cannot control AutoLive. Invalid known kinds, disabled sources and removal of a previously resolved source revoke the authorization. Later source registration or policy events reconcile deterministically.

SOURCE_REGISTRATION_ORDER: The code order is policy constructor/load → ControlDesk start → runtime start → StudioSourceManager.initialize(config) → awaited asset/media initialization → awaited StudioBootstrap.initialize() → catalog overlay load → base source registration → base scenes → operator overlay sources/scenes → catalog initialized and notification. Source manager initialization resolves the runtime configuration; catalog registration preserves source IDs. Actual runtime timestamps were unavailable, so these are source-code ordering observations, not measured timings.

CONTROLLER_START_ORDER: After awaited bootstrap, retained Program Output, renderer, transition and scheduler setup, the technical monitor is started, SourcePresenceMonitor is constructed, DominantLiveController is constructed and started, then DominantLiveUI is constructed and started. Controller start subscribes to config and catalog (both immediately publish their current snapshots), then health and scheduler, transition and EventBus. UI subscription immediately renders the controller snapshot. An earlier thrown error could prevent these steps; this audit did not observe a runtime exception and did not modify these optional bootstraps.

CONTROL_DESK_ORDERING_REGRESSION: Not demonstrated. The early layout start does not reorder catalog hydration relative to controller construction. It uses its own layout storage key. Its code and the control-room entry are unchanged by this fix. A focused ordering assertion and the existing ControlDesk suites pass. Browser timing and real startup completion remain unverified.

ROOT_CAUSE: The first loss point for a saved `primary-live` ID is DominantLiveConfig.normalizeId/load, before controller construction. Separately, the existing authorization UI excluded bootstrap sources by origin. For a saved operator ID with late catalog hydration, controller reconciliation previously persisted null at its immediate config subscription, and catalog initialization did not notify existing subscribers. These are reproduced code defects, but none proves which source the real operator previously authorized. The first loss point for the reported browser session remains blocked on browser evidence.

FIX: Accept safe source identifiers independent of operator prefix; validate effective authorization against enabled HLS catalog records; preserve unresolved saved identities until registration; revoke known invalid/deleted resolved identities; notify after catalog hydration; expose bootstrap LIVE authorization through the existing Schedule LIVE SOURCES workflow. Missing effective authorization renders DISARMED with the existing NO AUTHORIZED SOURCE message. The checkbox retains the operator's armed preference. Bootstrap edit/disable/remove controls remain hidden in that legacy panel. No source is implicitly authorized.

OPERATOR_CONFIGURATION_REQUIRED: Not yet established. If the saved ID is null or no saved policy exists, the operator must explicitly select the intended source. If the saved ID exists, investigate/restore that exact identity without substituting a different LIVE source.

FILES_CHANGED_FOR_THIS_FIX:

- public/js/studio/DominantLiveConfig.js
- public/js/studio/DominantLiveController.js (authorization reconciliation/status only, on top of the dirty baseline)
- public/js/studio/StudioCatalogManager.js (one post-hydration notification)
- public/js/ui/StudioLiveSourcesUI.js
- test/autolive-authorization.test.js
- docs/AUTOLIVE-AUTHORIZATION-AUDIT.md
- var/autolive-authorization-focused.log and var/autolive-authorization-all.log (test output)

TESTS_ADDED: 13 focused tests cover saved bootstrap LIVE identity, registration after controller start, operator overlay reload, schedule navigation/reconstruction, missing source UI, deletion, multiple LIVE sources, non-LIVE rejection, late catalog hydration, late policy hydration, existing UI authorization actions, bootstrap authorization control rendering, and entry startup order. These use the real config/catalog/controller classes with dependency doubles; the startup-order test inspects the entry source and is not an end-to-end browser timing test.

REGRESSION_RESULTS: Focused suites 195/195; node --test 494/494; syntax checks pass for all changed JavaScript; git diff --check passes. No skipped/cancelled tests. Browser visual verification and real localStorage/reload/navigation validation were not possible. Logs are in var/.

EXISTING_UNSTAGED_WORK_STATUS: SHA-256 comparison of all 43 pre-existing dirty/untracked files found 42 unchanged and only DominantLiveController.js changed by this task. No pre-existing files were removed. Existing controller health/acquisition/continuity changes remain intact.

PROTECTED_FILES_STATUS: No edits to ControlDesk, source-health algorithm, timers, MediaMTX publisher detection, Program Output, Public Viewer, OBS, scheduler playback continuity, auth, .env or MediaMTX configuration. Existing modifications in protected areas were retained.

GIT_STATUS: build/1003.3; dirty baseline retained; three additional tracked files modified (DominantLiveConfig, StudioCatalogManager, StudioLiveSourcesUI), controller remains modified; new test, audit and two logs untracked. Index remains empty. No staged changes.

BLOCKERS: No connected browser; actual saved policy, current operator LIVE IDs, prior selected identity and runtime startup timestamps are unknown. The user was asked for only the AutoLive storage key and LIVE IDs. Missing configuration has not been proven, and the real-session root cause cannot be claimed resolved.

MANUAL_RETEST:

1. Before changing settings, record the exact AutoLive policy key and current LIVE source IDs on the same origin as the Control Room. Do not clear storage.
2. Reload Control Room and confirm startup reaches the AutoLive UI; inspect startup errors if a checked checkbox remains disconnected from its displayed state.
3. Follow ADD / EDIT PALINSESTO → LIVE SOURCES. Match the saved ID exactly. MAIN LIVE now has an AUTO INTERRUPT control in this existing workflow.
4. Only if there is no saved authorization, explicitly select the operator-intended source with AUTO INTERRUPT: ON. Do not choose merely by position or name similarity.
5. Return to Control Room, confirm the selected source name, then reload and navigate away/back. The same ID must persist. With no valid source the status must remain DISARMED / NO AUTHORIZED SOURCE.
6. Once authorization is verified, resume the previously deferred AutoLive runtime retest.

NEXT_STEP = RESTORE AUTOLIVE AUTHORIZATION, THEN RESUME AUTOLIVE RUNTIME RETEST

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

LIVEZONE AUTOLIVE AUTHORIZATION AUDIT COMPLETE
