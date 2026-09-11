# AutoLive configuration persistence across refresh

DECISION: AUTOLIVE_CONFIG_PERSISTENCE_READY_FOR_MANUAL_RETEST

BASELINE: C:/Projects/livezone-broadcast-engine-x, build/1003.3. All existing dirty work, including the prior 506-test audit, was treated as authorized baseline. No reset, restore, clean, stash, stage, commit or push.

REAL_BROWSER_EVIDENCE: Accepted as authoritative: selecting existing, different and newly created LIVE sources still produced DISARMED / NO AUTHORIZED SOURCE; checking AutoLive did not survive refresh. This is not attributed to missing operator configuration or to primary-live alone. No connected browser was available for direct observation in this session. The readiness decision rests on the requested production-module reconstruction tests, not a claim that the operator's browser has already passed.

STORAGE_ORIGIN: Expected local origin http://127.0.0.1:8080. Control's ./schedule/ link and Schedule's return link are relative and preserve the origin; an automated check verifies that at the expected local origin. Actual location.origin is now included in all three bounded console diagnostic events. The live browser origin has not been observed; no mismatch is asserted and no URLs were changed.

STORAGE_KEY: One frontend authorization record: livezone.studio.dominantLive.v1, version 1, containing armed and authorizedSourceId. Production reads/writes are centralized in DominantLiveConfig. No frontend removeItem/clear targets this key, no constructor writes defaults, and no new migration or persistence layer was added. ScheduleStore persists schedule items under a different key and does not own these two fields. Server authoritative-state defaults are a separate contract, not a browser writer for this key.

CONFIG_INSTANCES: One explicit new DominantLiveConfig in schedule-app.js and one in control-room-app.js, each per document/module execution. Controller and UI share their page's instance. Overlapping pages can therefore hold different snapshots while browser storage events are pending. There is no evidence of a second same-page constructor writing defaults. A constructor regression test proves that creating additional instances performs no writes and preserves a valid record.

AUTHORIZED_SOURCE_WRITE_TRACE: Rendered LIVE SOURCES button data-id=X → production click listener → StudioLiveSourcesUI.handleClick → setAuthorizedSourceId(X) → load latest authoritative record → merge only authorizedSourceId → serialize version 1 → storage.setItem → storage.getItem equality verification → publish confirmed snapshot → render. Source kind remains enabled HLS, with no implicit selection. The same production UI/store path is exercised for primary-live, a custom source created in an earlier document and a source created in the current Scheduler document.

ARMED_WRITE_TRACE: Native checkbox change → registered DominantLiveUI.handleChange → setArmed(true) → load latest authoritative record → merge only armed → serialize → setItem → verified getItem → confirmed in-memory snapshot → controller subscription/render. The UI now explicitly renders the model after the setter returns, including failure cases where no config event was emitted. On failure the checkbox returns to the confirmed value and the status says CONFIG NOT SAVED. The WRITE diagnostic now covers armed mutations as well as source mutations and records both writeSucceeded and readBackSucceeded.

STORED_RECORD_AFTER_SCHEDULER: In each production-module integration flow, storage contains {version:1, armed:false, authorizedSourceId:X}. This is an observed test record; X is primary-live or live-selected-1 in isolated fixtures. Selecting a source preserves the prior armed field rather than automatically arming.

STORED_RECORD_AFTER_ARM: After dispatching the real checkbox change handler in fresh Document B, the same storage object contains {version:1, armed:true, authorizedSourceId:X}. Tests assert the entire record and successful write/readback diagnostics, not just the checkbox state.

FRESH_CONTROL_READ_TRACE: Destroy Document B's UI/controller/config/catalog. Document C constructs fresh production config, source manager, catalog, controller and UI from the same storage. Config loads armed=true and the exact X before catalog hydration. Controller construction against the not-yet-hydrated catalog does not erase either value. Catalog hydration resolves X; the UI is checked and displays the source name rather than NO AUTHORIZED SOURCE. Both CONFIG_LOAD and CATALOG_RESOLUTION diagnostics retain true/X. The source definition fixture is repository studio.json; the real source manager resolves its configRef with test technical configuration.

FIRST_VALUE_LOSS: The baseline regression tests reproduce two concrete losses at mutation/serialization, not constructor load:

1. Control instance reads false/null; Scheduler saves X; before Control receives a storage event, its setArmed(true) previously spread its stale snapshot and persisted true/null.
2. Scheduler instance reads armed=false; Control saves armed=true; before Scheduler receives an event, its source mutation previously spread armed=false and persisted false/X.
3. Independently, the browser-native checkbox changed visually before persistence. A failed write emitted no model update, so the checkbox could remain checked even though storage had no armed=true record.

ROOT_CAUSE: Reproduced defects are whole-record mutations based on stale instance snapshots and a checkbox handler that did not reconcile after persistence failure. The exact cause in the operator's real session is not asserted without its diagnostic trace. The ordinary single-writer three-document flow already passed against the baseline; the three stale-instance/failure regressions failed before the fix. This distinction is retained in var/autolive-config-persistence-before.log.

FIX: Both field setters now read the existing authoritative record immediately before merging their own field. A storage read failure refuses the mutation rather than writing defaults over unreadable state. Existing write/readback verification remains required before publishing a successful change. Checkbox failure feedback follows confirmed state. Browser storage access denied during construction is handled safely. Diagnostic context includes instanceId, schemaVersion, storage availability and safe origin; READ/WRITE/CONTROLLER include both configuration fields. No health or acquisition logic was changed.

MULTIPLE_INSTANCE_FINDING: The storage record owns the state; page instances are readers and field-scoped writers. Tests explicitly delay delivery of storage events by using separate instances with the same storage object, then invoke sequential UI mutations. They prove preservation of unrelated fields despite stale snapshots. This is not a claim of an atomic cross-tab transaction for truly simultaneous read-modify-write operations; localStorage provides no compare-and-swap transaction. No second store, polling loop or automatic source selection was introduced.

FIELD_PRESERVATION_FINDING: setArmed preserves the latest saved authorizedSourceId; setAuthorizedSourceId preserves the latest saved armed value. Constructor/load remain read-only. Existing reconciliation retains valid unresolved IDs through late hydration. Read denial causes no write; thrown/discarded writes cause no successful UI state.

TESTS_ADDED: Eleven additional tests in test/autolive-authorization-runtime.test.js, plus assertions extending the reconstruction coverage. Three required Document A/B/C cases; both stale-instance mutation orders; failed armed write; armed/exact-ID Control → Scheduler → Control navigation; read-only constructors; unreadable storage preventing destructive default writes; armed readback failure; same-origin link resolution and safe origin logging. Production event handlers, config, source manager, catalog, ScheduleStore, controller and UI subscriptions run with an explicit DOM/FormData adapter and shared memory storage. Documents are destroyed and reconstructed. This is integration-style simulation, not browser automation. No health activity is needed for authorization proof.

REGRESSION_RESULTS: Before fix, the new suite had 15 passes and 3 failures identifying the value losses above. After fix, all 23 runtime authorization tests pass. Focused suites: 218/218. Full node --test: 517/517, no skipped/cancelled tests. Syntax checks pass for all five changed JavaScript files; git diff --check passes. Logs are var/autolive-config-persistence-before.log, var/autolive-config-persistence-focused.log and var/autolive-config-persistence-all.log. Prior logs were preserved.

EXISTING_UNSTAGED_WORK_STATUS: SHA-256 comparison of 57 baseline dirty/untracked files: 53 unchanged; four intentionally extended (DominantLiveConfig.js, DominantLiveController.js, AutoLiveAuthorizationDiagnostics.js and autolive-authorization-runtime.test.js). DominantLiveUI.js was previously clean. All previous changes remain; no pre-existing files were removed.

PROTECTED_FILES_STATUS: AutoLive source health, MediaMTX publisher detection, acquisition/stabilization, loss grace, Program Output, Public Viewer, OBS, playback continuity, ControlDesk collapse, authentication, .env, MediaMTX config and P0-C1B.2 unchanged relative to baseline. Controller changes in this turn only extend diagnostic fields.

GIT_STATUS: build/1003.3; dirty worktree retained; index empty. This turn modifies the five files identified above and adds this audit and three logs. All remain unstaged. Existing untracked files remain untracked.

BLOCKERS: None for the explicit code/test acceptance criterion: Scheduler writes X → fresh Control reads X → checkbox writes true/X → destroyed/reconstructed Control reads true/X is proved for all three source cases. The actual browser origin and post-fix runtime behavior remain manual validation items, not claimed observations.

MANUAL_RETEST:

1. Reload Scheduler and Control so both use the updated modules. In the normal LIVE SOURCES workflow retain/select the intended source explicitly; no localStorage editing is required.
2. Confirm AUTOLIVE_AUTH_WRITE shows its exact ID with writeSucceeded=true and readBackSucceeded=true. Verify its safe origin matches the Control diagnostics.
3. Return to Control, verify READ resolves that ID, then check AutoLive. Confirm WRITE shows armed=true and the same ID with both verification flags true.
4. Refresh Control. CONFIG_LOAD, CATALOG_RESOLUTION and CONTROLLER must retain armed=true and that ID; checkbox must be checked and the source name displayed.
5. Repeat Control → Scheduler → Control and verify both fields. If persistence fails, expect CONFIG NOT SAVED and a reverted checkbox; retain the safe diagnostics without editing storage. If no armed WRITE appears, retain startup errors and the last READ/CONTROLLER events to locate an unbound UI.
6. Keep health/acquisition/loss investigation deferred until this persistence retest passes.

NEXT_STEP = MANUAL RETEST AUTOLIVE CONFIGURATION PERSISTENCE ACROSS REFRESH

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

LIVEZONE AUTOLIVE CONFIGURATION PERSISTENCE AUDIT COMPLETE
