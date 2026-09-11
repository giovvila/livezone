# AutoLive stability counter audit

DECISION: AUTOLIVE_STABILITY_COUNTER_READY_FOR_MANUAL_RETEST

REAL_RUNTIME_RESULT: User reported ENTRY active but counter reset every approximately 5–10s. This fix has deterministic runtime coverage; no connected real browser/OBS session was available for a new physical retest.

COUNTER_RESET_TRACE: Existing localhost-only livezoneRuntimeTrace now records autolive-entry PAUSED, RESUMED and RESET. Records contain timestamp, source ID, candidate consumer generation, stableElapsed (milliseconds), source/player state, reason, currentTime, lastProgressAge, readyState and waiting/stalled/error flags. Existing 1000-record bounded buffer and field sanitization remain. No URLs, secrets or raw errors. Export with livezoneRuntimeTrace.download().

RESET_ROOT_CAUSE: The former continuous helper reset immediately on waiting/stalled/pause, after a 1500ms progress gap, and on any non-ONLINE health epoch. The entry controller independently zeroed its UI counter for CHECKING. Normal HLS uncertainty could therefore repeatedly erase all progress. These are verified code paths, not an assertion that a particular event was captured in the user's real browser. Exact attribution of that observed 5–10s cadence requires the new runtime trace.

SOURCE_HEALTH_CLASSIFICATION: ONLINE permits actual candidate progress to count. CHECKING/uncertain ERROR pauses. OFFLINE/non-uncertain ERROR resets immediately. Existing source routing and monitor authority are unchanged; stale generations and wrong source IDs are rejected before notification.

PLAYER_HEALTH_CLASSIFICATION: Advancing playable candidate frames count. waiting, stalled, pause, insufficient readiness and short progress gaps pause. Fatal error, destroyed/ended surface and backwards timeline reset. Fatal candidates retain the existing bounded retry/abandonment lifecycle.

TRANSIENT_UNCERTAINTY_MODEL: A finite non-extending uncertainty deadline uses LIVE_SOURCE_UNCERTAINTY_MS, currently 5000ms. Repeated waits cannot postpone it. Actual healthy progress cancels it. This matches the existing source monitor boundary rather than introducing a competing 2–3s loss verdict. Missing-progress detection remains 1500ms; uncertainty expires 5000ms after detection (up to 6500ms from the last frame).

COUNTER_PAUSE_MODEL: Preserve accumulated milliseconds. Do not count any paused interval or the gap to the first recovery sample. Subsequent healthy intervals contribute the lesser of wall time and advancing media time. The first recovery sample resumes counting. Example verified: 20s healthy + 2s wait + 40s healthy = TAKE at wall time 62s.

COUNTER_RESET_MODEL: Confirmed loss, fatal failure or expired uncertainty zero the counter. Source replacement creates a new candidate/session gate. Source updates notify the gate immediately, including between frames. Abort and candidate/session generation checks prevent stale completion. Timer epochs prevent cancelled watchdog callbacks from changing the counter.

TOLERANCE_THRESHOLD: 5000ms, imported from existing LIVE_SOURCE_UNCERTAINTY_MS. Entry target remains 60000 healthy milliseconds; abandonment remains 22000ms of unavailable playback.

FIX: Separate entry-only accumulated-health gate; legacy pre-roll and post-TAKE loss policies unchanged. Entry controller no longer clears accumulated time for uncertain source observations.

ENTRY_SLATE_REGRESSION: ENTRY remains through pauses, reset and recovery. A stays paused at its captured cue; Preview and return target remain preserved. Existing Public/OBS shared slate tests pass.

PROGRAM_HISTORY: Healthy/recoverable entry A → ENTRY → LIVE, exactly once. Abandonment A → ENTRY → A at captured cue. Operator TAKE A → ENTRY → B, with no stale LIVE. Post-TAKE LOSS behavior remains covered.

TESTS_ADDED: Six integration cases: exact 20+2+40 acquisition; repeated short waits with CHECKING; fixed uncertainty expiry despite repeated waits; stale source observation rejection; short progress-gap accumulation; safe bounded pause/resume/reset diagnostics. Existing tests cover continuous 60s, OFFLINE reset, fatal retry, source change, disarm, operator override, stale completion, captured-cue abandonment, Preview, Public/OBS and post-TAKE loss.

REGRESSION_RESULTS: Focused 161/161 PASS. Full suite 648/648 PASS. JavaScript syntax checks PASS. git diff --check PASS.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/studio/EntryHealthyPlayback.js (new)
- public/js/studio/LivePlaybackStability.js
- public/js/studio/AutoLiveEntryController.js
- public/js/core/RuntimeTrace.js
- test/autolive-entry-gate.test.js
- docs/AUTOLIVE-STABILITY-COUNTER-AUDIT.md (this audit)
- var/stability-counter-* (baseline and validation artifacts)

BLOCKERS: No implementation blocker. Real-browser attribution and physical OBS validation remain manual; do not interpret automated coverage as an observed real-browser result.

MANUAL_RETEST: Refresh Control, authorize the external HLS source, arm AutoLive with A in Program and P in Preview. Confirm A pauses and ENTRY is visible on Control/Public/OBS. Observe counter pauses during short waits and resumes without zeroing; export trace. Confirm LIVE after 60 accumulated healthy seconds. Stop the source and verify confirmed loss/return policy. Repeat with operator TAKE during ENTRY and confirm no late LIVE promotion.

No reset, restore, clean, stash, stage, commit or push. No environment, service, routing, authorization or media changes.

NEXT_STEP = MANUAL RETEST AUTOLIVE 60S STABILITY COUNTER

LIVEZONE AUTOLIVE STABILITY COUNTER AUDIT COMPLETE
