# AutoLive CHECKING audit

DECISION: AUTOLIVE_CHECKING_FIX_BLOCKED

BASELINE: C:/Projects/livezone-broadcast-engine-x, branch build/1003.3. Current dirty worktree authorized and retained. Baseline full suite 523/523. No reset, restore, clean, stash, staging, commit or push.

AUTHORIZED_SOURCE_STATUS: The operator's confirmation is authoritative: authorization, armed preference, persistence and bootstrap work; the native timer invocation error is gone. None of these paths was investigated further or modified in this task.

TECHNICAL_MONITOR_SIGNAL: TechnicalLiveMonitorUI uses LiveSourceMonitor with a StudioHlsSurface consumer of the selected catalog source.url. Surface readiness requires media readyState >= 2 and a presented first frame (or the fallback when video-frame callbacks are unavailable). The surface starts muted. This is HLS playback evidence, not a MediaMTX source-presence API. The consumer/monitor allows 12000ms for readiness, then reports unavailable/retries after 5000ms. Video/HLS events drive readiness; it is not the one-second server presence poll. The technical selection uses its own selected source ID.

AUTOLIVE_SIGNAL: Control Room constructs SourcePresenceMonitor directly and supplies it to DominantLiveController. It requests /api/media-ingest/status?sourceOnly=1, credentials=same-origin, cache=no-store. The server MediaIngestStatusClient inspects /v3/paths/list at its configured loopback MediaMTX API and selects its one configured mediaPath. For sourceOnly requests it skips HLS probing. Current positive classification requires state=live or connecting, health.publisherPresent=true, and an exact normalized endpoint match. A matching positive source-only response can have hlsAvailable=false and still emit ONLINE. The old DominantLiveHealthConsumer is not constructed in the current AutoLive entry path.

SIGNAL_DIFFERENCE:

| Property | Technical Monitor | AutoLive |
| --- | --- | --- |
| Authority | Browser HLS surface readiness | Authenticated server publisher-presence response |
| Target | Selected catalog source.url | Configured server ingest URL, checked against authorized source.url |
| Positive condition | Media data and first frame | Matching endpoint plus publisherPresent=true and live/connecting state |
| Timing | Readiness <=12s; retry 5s | Request/body deadline 2s; next poll 1s after outcome |
| Playback requirement | Muted browser HLS playback | None before ONLINE/stabilization |
| Failure independence | HLS may work while presence API fails | Requires a usable authenticated presence response |

SOURCE_ID_MAPPING: Catalog source.id = controller authorizedSourceId = SourcePresenceMonitor selected source.id. configRef resolves through the source manager into source.url before monitoring. Technical Monitor can select a different ID independently; it uses that source's URL. AutoLive does not pass arbitrary source IDs or paths to the server: it probes the server's configured ingest and validates the resulting playbackHlsUrl against the authorized URL. Hostnames localhost and 127.0.0.1 are normalized by the existing equality function; other endpoint differences are not silently accepted. A source outside that ingest is not automatically considered present. New safe trace fields selectedPath/probedPath expose simple /<path>/index.m3u8 path IDs when the URL has no credentials, query or fragment; endpointMatch records the comparison result. The actual two browser selections/path values have not been supplied.

CHECKING_STATE_TRACE: Existing source-health observations lacked HTTP status, failure reason, publisher presence, endpoint match and retry deadline. Repeated HTTP/network failures or server uncertainty left state=CHECKING every iteration. Each attempt now records checking-start with generation, selected source/path, attempt and deadline; observation records state/reason, HTTP status, presence, HLS flag, endpoint comparison, safe path IDs, API state, request duration and next deadline. checking-timeout is emitted when the hard deadline wins. Existing controller stabilizing, acquisition-start and acquire/program-committed trace events remain available. No raw response, URL, exception text, credential or token is added to RuntimeTrace.

FIRST_MISSING_TRANSITION: Tests reproduce two missing finite outcomes before any fix: failed/uncertain API responses repeatedly published CHECKING instead of a diagnosed retry outcome; an uncooperative fetch or response-body promise could remain unresolved even after abort, preventing both outcome and retry. Conversely, matching publisherPresent=true already progressed through ONLINE, stabilization and Program command in the baseline. There is no demonstrated missing player-readiness transition in that successful presence path. Which failing API condition occurs in the operator's session remains unproven.

ROOT_CAUSE: Reproduced defects are the unconditional CHECKING fallback for failed/uncertain responses and reliance on abort alone to settle request/body promises. These explain classes of indefinite checking, not yet the particular response received by the user's authenticated browser. A read-only anonymous request to the local app returned HTTP 401, as expected without an operator session; this is not evidence that the browser also receives 401. A separate read-only sample from the default loopback MediaMTX API returned the path livezone-test with online=false and empty tracks at the time of inspection; it does not replace the user's earlier LIVE observation or prove the active app's configured path. No authentication bypass or service/config change was made.

FIX: Requests and JSON bodies race a deadline/cancellation promise, so every active attempt has a finite outcome even if the dependency ignores abort. Known absence remains OFFLINE. HTTP errors, network errors, timeout, unusable server presence and endpoint mismatch produce ERROR with an explicit reason and retry. Controller displays ARMED — RETRY for source-health errors and exposes presence reason/HTTP/attempt/deadline diagnostics. Uncertainty is tagged and handled exactly as the former source-health CHECKING uncertainty for loss-grace ownership; it is never forged into confirmed publisher absence. Endpoint mismatch is not promoted to presence. Poll interval, timeout value, stabilization and grace durations are unchanged.

CHECKING_TIMEOUT_MODEL: Before: native network failures normally returned within the intended 2000ms timeout, but every result could remain CHECKING indefinitely; dependencies/body operations not settling on abort had no guaranteed retry bound. After: each request plus body has a 2000ms budget and a terminal ONLINE, OFFLINE or ERROR/retry result. Next attempt starts 1000ms after settlement, so an all-timeout attempt cycle is at most 3000ms, subject to normal browser task scheduling/throttling. Repeated failures may remain ARMED — RETRY with changing generation/count/reason; this is an explicit failure state, not a promise of eventual source availability. ERROR is intentionally not mislabeled OFFLINE, which would incorrectly confirm loss and regress ownership. With a matching positive response, stabilization remains 3000ms; readiness during Program preparation retains the existing 12000ms limit. AutoLive presence checking does not wait for canplay, currentTime, manifest parsing or an audible play promise.

TESTS_ADDED: 17 tests in test/autolive-checking.test.js. They cover HTTP 401, server uncertainty, publisher-not-ready, network rejection, never-settling fetch/body, Technical ONLINE independent of API authorization, positive production MediaIngestStatusClient source-only responses, exact endpoint mismatch, immediate/delayed renderer readiness, pending-play/manifest-delay models, absence/flaps, readiness timeout, repeated retry recovery, acquired-session preservation across uncertainty/grace, and safe diagnostic fields. Acquisition tests use the production monitor, controller, StudioProgramCommand and StudioTransitionCoordinator with a deterministic renderer readiness gate. The play/manifest variants model that downstream delay; they are not real browser media/autoplay tests. Existing real HLS-surface/consumer and authorization suites are also run. One existing uncertainty assertion is updated from opaque CHECKING to ERROR/PRESENCE_UNAVAILABLE.

REGRESSION_RESULTS: Initial 14-test reproduction had 6 passes and 8 failures; positive presence/acquisition cases passed before the fix. Final 17 new tests pass. Focused monitor/AutoLive/authorization/runtime/startup suites: 193/193. Full node --test: 540/540; no skipped/cancelled tests. Syntax checks pass for all five changed/new JavaScript files and git diff --check passes. Logs: var/autolive-checking-before.log, var/autolive-checking-focused.log, var/autolive-checking-all.log.

FILES_CHANGED_FOR_THIS_FIX:

- public/js/studio/SourcePresenceMonitor.js
- public/js/studio/DominantLiveController.js
- public/js/core/RuntimeTrace.js
- test/source-presence.test.js
- test/autolive-checking.test.js
- docs/AUTOLIVE-CHECKING-AUDIT.md
- var/autolive-checking-before.log
- var/autolive-checking-focused.log
- var/autolive-checking-all.log

EXISTING_UNSTAGED_WORK_STATUS: SHA-256 comparison of 67 baseline dirty/untracked files: 63 unchanged; only SourcePresenceMonitor, DominantLiveController, RuntimeTrace and the existing source-presence test changed. No pre-existing file removed. Prior diagnostics, authorization fixes, timer binding fix and logs remain intact.

PROTECTED_FILES_STATUS: No changes to authorization/persistence, ControlDesk, Preview/Program cue restoration, Program Output, Public Viewer, OBS, Control/Scheduler continuity, server MediaMTX integration, auth, .env or MediaMTX config. No stabilization/grace duration changes. Controller uncertainty handling preserves the previous grace semantics for the newly explicit uncertainty result; a regression verifies an acquired session survives uncertain responses beyond grace and recovers without reacquisition.

GIT_STATUS: build/1003.3; dirty baseline retained; index empty. Changes remain unstaged; no commit or push. Prior untracked files remain untracked.

BLOCKERS: No captured response/trace from the authenticated browser during its stuck state; no confirmed comparison of the actual technical selected URL and AutoLive ingest URL. The operator was asked for the API status and safe state/presence fields/path. Until those arrive, the exact real-session first divergence and restored acquisition cannot be claimed. The bounded retry/diagnostic defects are fixed and verified, but changing source authority or path selection without that evidence would be speculative.

MANUAL_RETEST:

1. Reload Control Room, retain the intended authorized source and arm AutoLive. Do not change authorization or storage for this diagnosis.
2. Capture RuntimeTrace source-health checking-start/observation/checking-timeout entries. Inspect sourceId, selectedPath, probedPath, endpointMatch, httpStatus, apiState, publisherPresent, reason, generation, retryAttempt and retryDeadline. Existing live-monitor health-transition entries describe Technical Monitor.
3. If reason is HTTP_ERROR, retain its status; if ENDPOINT_MISMATCH, compare the safe paths; if PRESENCE_UNAVAILABLE/PUBLISHER_NOT_READY, retain the actual server presence fields. Do not infer presence from buffered HLS alone.
4. For a matching positive response expect observation ONLINE/PUBLISHER_PRESENT → stabilizing → acquisition-start → program-committed/acquire. HLS readiness may delay Program preparation but must not keep source health CHECKING.
5. Supply that trace if it remains ARMED — RETRY or fails to acquire; it identifies the next concrete missing transition without changing unrelated subsystems.

NEXT_STEP = MANUAL RETEST AUTOLIVE CHECKING → ONLINE → ACQUIRE

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

LIVEZONE AUTOLIVE CHECKING AUDIT COMPLETE
