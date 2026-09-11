# SourcePresenceMonitor browser receiver fix

DECISION: SOURCE_PRESENCE_MONITOR_RUNTIME_FIX_READY_FOR_MANUAL_RETEST

BASELINE: C:/Projects/livezone-broadcast-engine-x, build/1003.3. Existing dirty worktree authorized and preserved. Baseline full suite: 517 tests. No reset, restore, clean, stash, stage, commit or push.

THROWING_EXPRESSION: The first `this.clearTimer(this.timer)` in SourcePresenceMonitor.stop(), formerly line 20 column 32. The supplied browser stack identifies this call; the new regression reproduces the same stop/selectSource/reconcileConfiguration/subscribe/start stack. The second clearTimer call has the same invalid receiver, but the first throws before it executes.

ILLEGAL_INVOCATION_ROOT_CAUSE: The constructor assigned the unbound globalThis.clearTimeout function to this.clearTimer. Calling it as a monitor member passes the SourcePresenceMonitor instance as its receiver. The browser-native Window function rejects that receiver. setTimer had the identical defect and would fail at the poll deadline after the first issue was removed. Both defaults are now explicitly bound to globalThis.

BROWSER_API_RECEIVER_REQUIREMENT: In this browser Window timer functions require their permitted global receiver, not an arbitrary monitor instance. Binding their default dependencies retains that receiver even when invoked through this.clearTimer/this.setTimer. Default fetch was already bound to globalThis. abort() is called as this.abort.abort() or abort.abort(), preserving its AbortController receiver. No detached EventTarget, EventSource or Media API is involved in this stop path.

SOURCE_PRESENCE_STOP_CONTRACT: Existing semantics retained. stop increments lifecycle to invalidate outstanding async work, cancels retry and deadline timers, aborts any active fetch through its owning AbortController and resets source=null. Undefined/previously cleared timer handles are accepted by the correctly invoked native cancellation function. Repeated stop/abort calls are safe and do not resurrect work; lifecycle continues increasing intentionally. stop retains subscribers for source replacement; destroy calls stop and clears subscribers. There is no EventSource or DOM event listener cleanup in this class. Tests cover before-start, no-source, repeated stop/destroy, initial selection, source replacement and pending-request cleanup. No broad exception suppression was added.

STARTUP_SEQUENCE_BEFORE: DominantLiveController.start → config.subscribe → immediate listener → reconcileConfiguration → monitor.selectSource → stop → clearTimeout with monitor receiver throws. Controller startup therefore cannot finish, and the subsequent DominantLiveUI.start is not reached. Static DISARMED / NO AUTHORIZED SOURCE markup can remain without reflecting the actual saved configuration. This concrete exception supersedes persistence-only explanations for this observed boot failure.

FIX: Only runtime change is the constructor defaults:

```js
setTimer = globalThis.setTimeout.bind(globalThis),
clearTimer = globalThis.clearTimeout.bind(globalThis),
```

Explicitly injected timers are not rebound or replaced. No timer durations, poll scheduling rules, health decisions, lifecycle semantics or authorization rules were changed.

STARTUP_SEQUENCE_AFTER: The same immediate subscription executes stop safely, selects the exact authorized source, schedules its deadline and begins the request. Controller start returns successfully; UI start runs and displays the source. The new tests use the real SourcePresenceMonitor default dependency path with receiver-sensitive global timer functions, not a monitor stub. They also verify default fetch receiver binding, post-response scheduling and cleanup.

WHY_EXISTING_TESTS_MISSED_IT: SourcePresenceMonitor tests injected arrow-function fake timers; these accept any invocation receiver. Node timer functions do not reproduce the observed Window receiver restriction. Prior authorization integration tests replaced the monitor with a simple test double, so they could prove persistence while missing the real monitor's immediate-subscription failure. The new tests model the browser receiver requirement at the global default-function boundary and retain the real monitor/config/controller execution path. They are receiver-contract simulations in Node, not an assertion of a completed browser retest.

TESTS_ADDED: Six tests in test/source-presence-browser-binding.test.js: default cancellation receiver with repeated stop/destroy; default scheduling receiver at deadline and retry; replacement/abort/stale-request cleanup; preservation of explicitly bound injected timers; full immediate-subscription startup/UI/armed-state reconstruction for primary-live; the same flow for live-custom. Before the fix, five failed with Illegal invocation; the explicitly bound injection test passed. After the fix all six pass. The failure log includes the matching production stack.

AUTOLIVE_AUTH_REGRESSION: Production Scheduler authorization handler writes X to the shared storage; fresh config/controller with the real monitor reads X; production checkbox handler saves armed=true; destruction and second reconstruction retain true/X, display the source name and emit READ/CONTROLLER diagnostics. Both primary-live and custom LIVE cases pass. Existing authorization/reconstruction suites also pass. No source was selected or browser storage changed by this audit.

REGRESSION_RESULTS: Focused source-presence, dominant-live, authorization, runtime-determinism and schedule-workspace suites: 176/176 pass. Full node --test: 523/523 pass; no skipped/cancelled tests. Syntax checks pass for the changed runtime file and new test; git diff --check passes. Evidence: var/source-presence-binding-before.log (1 pass, 5 failures before fix), var/source-presence-binding-focused.log and var/source-presence-binding-all.log.

FILES_CHANGED_FOR_THIS_FIX:

- public/js/studio/SourcePresenceMonitor.js — only runtime edit, two bound defaults.
- test/source-presence-browser-binding.test.js — regression coverage.
- docs/SOURCE-PRESENCE-MONITOR-RUNTIME-FIX.md — this audit.
- var/source-presence-binding-before.log
- var/source-presence-binding-focused.log
- var/source-presence-binding-all.log

EXISTING_UNSTAGED_WORK_STATUS: SHA-256 comparison of all 62 pre-existing dirty/untracked files shows 61 unchanged; only SourcePresenceMonitor.js differs from this turn's baseline. All prior work retained, including previous tests, diagnostics and logs. No pre-existing files removed.

PROTECTED_FILES_STATUS: Source-health semantics, MediaMTX integration/publisher detection, loss grace, stabilization, Program Output, Public Viewer, OBS, playback continuity, ControlDesk collapse, auth, .env, MediaMTX config and P0-C1B.2 unchanged. No services were started, stopped or reconfigured by this task.

GIT_STATUS: build/1003.3; dirty baseline retained; index empty. SourcePresenceMonitor.js remains untracked as it was in the baseline; new test/audit/logs untracked. No staging, commit or push.

BLOCKERS: None for the proven receiver fix. The operator's real browser has not been driven or retested in this session; manual validation remains required before full LIVE acquisition testing.

MANUAL_RETEST: Reload the same Control Room browser and check Console. Confirm no SourcePresenceMonitor.stop Illegal invocation. Retain/select the intended source through the normal UI if needed, activate AutoLive and refresh. Expect the authorized source name, retained armed state, and AUTOLIVE_AUTH_READ / AUTOLIVE_AUTH_CONTROLLER events. A valid configured source must not display NO AUTHORIZED SOURCE. Do not begin full LIVE acquisition tests until boot passes.

NEXT_STEP = MANUAL RETEST REAL CONTROL ROOM AUTOLIVE BOOT

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

LIVEZONE SOURCE PRESENCE MONITOR RUNTIME FIX COMPLETE
