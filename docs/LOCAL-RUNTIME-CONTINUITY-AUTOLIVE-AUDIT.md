# Local runtime continuity and AutoLive audit — 2026-09-08

DECISION = LOCAL_RUNTIME_CONTINUITY_AUTOLIVE_BLOCKED

Continuity is implemented and automated checks pass. The overall request remains
blocked on real acquisition measurements and reproduction of the already-open
Public/OBS failure. No measured acquisition root cause or LIVE update divergence
is claimed from simulated decoding.

BASELINE = branch `build/1003.3`, HEAD
`2ad3fc1ea361022bf0ed5c78f0e91d0fd42d5c19`, confirmed before and after work.
The authorized dirty baseline passed 431/431 tests before edits.

NORMAL_PROGRAM_OUTPUT_STATUS = preserved; existing normal VIDEO/AUDIO/TAKE tests
pass. The subscriber behavior changes from the previous dirty baseline were
already present when this audit began. This fix only adds an HLS preparation
trace to PublicProgramController, not new subscriber synchronization behavior.

CONTROL_SCHEDULER_ROOT_CAUSE = separate HTML documents and entry modules. The
Control editor link is a normal same-tab `./schedule/` anchor. Selection storage
restores IDs when scenes register; renderer startup previously created Program
without a preparation context and defaulted to zero/playing. Navigation replaces
the document/runtime unless the browser freezes it in back/forward cache. The
pages do not need separate lifecycles conceptually: a future shared shell could
retain the media element and scheduler/control runtime. No router or SPA rewrite
was performed. The present fix reconstructs logical playback; it does not keep
Control's physical media element or AutoLive controller running on Scheduler.

PLAYBACK_CONTINUITY_MODEL = reuse the existing retained Program Output snapshot.
Network mode reads the existing SSE endpoint once before renderer/publisher
startup, validates the envelope, and closes the temporary subscription. Local
mode reads the existing Program Output retained storage. No new cue storage or
playback authority is introduced. A candidate must match the restored Program
scene, current source ID/kind and media URL (audioUrl for AUDIO), have a valid
contract and playing/paused/ended state, be no older than six hours, and not carry
future published/start timestamps. `expectedPlaybackTime` applies the same
elapsed-time projection used by Public/OBS. Playing 37 + 10 seconds becomes 47;
paused remains 37. Projection is bounded by known duration and stops at the end.
Preview selection is never changed by this code.

CONTROL_SCHEDULER_FIX = obtain retained state before first render/publication;
provide a one-use Program preparation context with cue and initial playback;
await restored surface readiness before activation; omit activation for paused
restoration. A narrow startup exception allows publication of an intentionally
restored paused source, while ordinary TAKE still waits for playing readiness.
Back/forward-cache restoration reloads through this same bootstrap. Later
Program events discard the startup context and cannot reuse the navigation cue.
The network read has a 2,000 ms deadline and releases listeners/connection on
success, error or timeout. Missing/invalid/stale/mismatched retained data produces
no cue and falls back to existing selection/bootstrap behavior. Consequently
continuity is not guaranteed after retained state loss, a network read failure,
a changed source, or the freshness cutoff; a fresh baseline media start can
occur in those cases. Missing sources are never recreated from retained URLs.

AUTOLIVE_ACQUISITION_TIMELINE = not measured in the real failing runtime.

| Boundary | Real elapsed milliseconds | Evidence available |
| --- | --- | --- |
| Publisher available → candidate | unavailable | No active publisher during inspection |
| Candidate → CHECKING | unavailable | Monitor creates the consumer immediately on selection/retry |
| CHECKING → manifest/media ready | unavailable | Monitor/readiness deadline configured at 12,000 ms |
| Media ready → advancing playback → ONLINE | unavailable | Consumer requires a subsequent advancing timeupdate |
| ONLINE → stabilization complete | unavailable | Configured stabilization interval 3,000 ms |
| Stabilization → command → preparation | unavailable | Controller/command call chain inspected |
| Preparation → committed Program LIVE | unavailable | Program preparation deadline configured at 12,000 ms |
| Commit → publish → POST → retained/SSE | unavailable | Real HTTP/store/SSE verified in isolated tests |
| SSE → Public/OBS promotion | unavailable | Decoding/readiness simulated in automated tests |

Configured OFFLINE retry is 5,000 ms; progress-stall watchdog is 5,000 ms;
loss grace remains 5,000 ms. These values are not actual measured delays and must
not be added together and reported as a measured acquisition time. Stabilization
can be cancelled by loss; retries replace consumer generations; the health probe
and Program each have a media preparation lifecycle. Publisher detection is
currently coupled to browser playback progress. Its total latency is not bounded
by one retry interval when readiness repeatedly fails.

AUTOLIVE_LATENCY_ROOT_CAUSE = unproven. Potential cumulative waits were located,
but no timer was shortened or declared responsible without runtime evidence.

SOURCE_HEALTH_FINDINGS = existing server-only MediaIngestStatusClient queries
`/v3/paths/list`, checks the configured path's online/source/tracks2 fields, then
probes the configured HLS manifest. Its sanitized status includes
`health.publisherPresent`, `health.hlsAvailable`, `lastSeenAt`, and the playback
URL, through the operator-protected `/api/media-ingest/status` route. The
configured request timeout defaults to 1,500 ms per fetch; body parsing happens
after that fetch timer is cleared, so this is not a proven end-to-end status bound.
The browser is not given the MediaMTX API origin. This client monitors one
configured ingest path, whereas AutoLive can authorize other HLS sources.
Any future integration must first match the authorized source to this ingest and
separate fast path presence from the manifest probe. Publisher presence could
trigger a fresh readiness attempt; it must not replace the playback-progress
test that protects the working loss/recovery path. No integration was made
without evidence of that match and the actual latency boundary.

Read-only local probes: Node `/healthz` returned HTTP 200 in 52 ms;
the unauthenticated operator-session probe returned `authenticated:false` in
20 ms; MediaMTX path-list returned HTTP 200 in 20 ms, with one offline path,
no source, zero tracks and no onlineTime. These are individual probe round trips,
not acquisition measurements. Browser discovery returned zero available sessions.

AUTOLIVE_PROGRAM_COMMIT = code path is DominantLiveController →
StudioProgramCommand → StudioTransitionCoordinator → StudioStateManager.take →
STUDIO_PROGRAM_CHANGED. Added trace boundaries immediately around AutoLive's
state commit, plus acquisition-start and stabilizing. The existing `acquire`
trace occurs after the command succeeds, not when acquisition starts. Program
publication may occur synchronously inside the commit event dispatch, between
the commit-start and committed traces. No real acquisition was captured.

PROGRAM_OUTPUT_LIVE_REVISION = isolated integration tests inject the committed
LIVE identity at ProgramOutputManager's boundary. Revision 1 is A, revision 2
is HLS LIVE, revision 3 is A at cue 37. They use the production publisher,
actual HTTP POST, actual server store/SSE, production subscriber validation, and
PublicProgramController. Revision 2 matches the server-retained envelope and
promotes after a simulated canplay event. No observed production revision number
is available. These tests do not execute a real publisher acquisition.

SERVER_RETAINED_LIVE_STATE = demonstrated in isolated HTTP tests only. No real
AutoLive retained LIVE revision captured during this audit.

PUBLIC_OPEN_SUBSCRIBER_TRACE = automated sequence: A promoted → revision 2
received over actual SSE → production network subscriber accepts → controller
has pending LIVE revision 2 → simulated readiness → LIVE promoted → old A
released/src cleared → revision 3 restores cue 37. Production browser trace absent.

OBS_OPEN_SUBSCRIBER_TRACE = the same integration test is run independently in
OBS mode and passes, including LIVE promotion, old A release and cue-A return.
It does not automate the native OBS application or real HLS decoding.

FRESH_BOOTSTRAP_COMPARISON = server bootstrap and broadcast both call formatSse
on a ProgramOutput envelope. Both arrive as EventSource `program` events and
use the same network validation and PublicProgramController handler. The test's
fresh SSE connection receives exactly the same LIVE envelope as the open one.
A fresh controller has no outgoing A, pending render, or previous generation/
revision history and recreates its media/HLS consumer. Refresh therefore retries
the retained LIVE snapshot with new local lifecycle state. Which old lifecycle
state failed in the user's test is not proven; the exact reason refresh cures
that real failure remains blocked on its traces.

FIRST_LIVE_UPDATE_DIVERGENCE = not established. Manual and AutoLive commits share
the publication pipeline; ProgramOutputManager does not branch on event origin.
HLS uses a different preparation path than recorded media. The isolated tests
show no divergence through the modeled promotion, but cannot exclude a real HLS,
browser-generation, delivery or readiness failure. No speculative normalization
of the working Program Output behavior was applied.

AUTOLIVE_ACQUISITION_FIX = none to acquisition behavior; diagnostic extensions
only. RuntimeTrace remains local-only, bounded, field-allowlisted and URL/secret
excluding. Entries now include inter-entry deltaMs and scene identities. Added
AutoLive stabilization/acquisition/commit boundaries and subscriber HLS
preparation start. Existing publish, POST, SSE, accepted, ready, promoted and
destroyed traces remain available. No new server diagnostic endpoint or Program
Output protocol field was introduced.

AUTOLIVE_RETURN_PATH_REGRESSION = existing controller tests for restoring Program
identity/cue, sustained loss, cached/frozen frames, transient loss, duplicate
completion and manual override all pass. Public/OBS HLS callback/generation
regressions pass. Two additional HTTP integration tests also return LIVE → A at
cue 37. Acquisition timers, progress qualification and loss rules were preserved.

PREVIEW_REGRESSION = new navigation tests preserve Preview independently for
VIDEO/AUDIO, playing/paused; existing AutoLive Preview and operator-override
tests pass. Real manual confirmation remains required.

TESTS_ADDED = 14: four media-kind/playback-state continuity cases; stale/future/
invalid/missing/replaced identity/source cases; elapsed-to-end projection; network
retained read/cleanup; bounded empty/error read; one-use renderer context; two
renderer-kind readiness/paused-activation cases; paused startup publication with
ordinary TAKE readiness preserved; two independent Public/OBS real HTTP tests.

REGRESSION_RESULTS = baseline 431/431; focused final 154/154; full `node --test`
445/445, zero failures/skips/cancellations. `node --check` passed for all eleven
changed/new JavaScript files. `git diff --check` exited 0. Git reports existing
LF/CRLF normalization notices, no whitespace errors.

FILES_CHANGED_FOR_THIS_FIX =

- public/js/studio/ProgramPlaybackContinuity.js (new)
- public/js/entries/control-room-app.js
- public/js/studio/StudioRenderer.js
- public/js/program-output/NetworkProgramOutputTransport.js
- public/js/program-output/ProgramOutputManager.js
- public/js/core/RuntimeTrace.js (already untracked baseline)
- public/js/studio/DominantLiveController.js (trace only)
- public/js/studio/StudioTransitionCoordinator.js (trace only)
- public/js/public/PublicProgramController.js (trace only)
- test/program-playback-continuity.test.js (new)
- test/runtime-determinism.test.js (already untracked baseline)
- docs/LOCAL-RUNTIME-CONTINUITY-AUTOLIVE-AUDIT.md (new)

EXISTING_UNSTAGED_WORK_STATUS = preserved in place. Earlier dirty implementations,
tests, OBS files, documentation, media and logo assets were not reset, replaced,
stashed or staged. Changes to overlapping files were additive targeted patches;
the overall Git diff also includes work that predates this request.

PROTECTED_FILES_STATUS = no agent edits to .env, var/media-library/,
var/runtime/mediamtx/, var/runtime/winsw/, var/log/livezone/, or media/logo assets.
Additional integration tests create isolated temporary repositories and servers.

GIT_STATUS = worktree remains dirty, index empty, branch/HEAD unchanged. No
reset/restore/checkout/clean/stash/stage/commit/push performed.

BLOCKERS = no connected browser; no active real LIVE publisher; no production
Control/Public/OBS trace spanning the failure. Acquisition latency, source/path
identity match and first failing subscriber boundary cannot be proved. Required
real-runtime acceptance for acquisition and no-refresh LIVE promotion is open.

MANUAL_RETEST =

1. Load updated Control and keep Public and OBS already open on A. Verify ordinary
   VIDEO/AUDIO and manual TAKE first. Confirm Preview is a distinct chosen scene.
2. With VIDEO near 37 seconds, navigate via the actual Scheduler link, wait ten
   seconds, return by Control link and separately by browser Back. Expect roughly
   47 seconds. Repeat AUDIO; repeat paused media where available and expect 37.
   Confirm Preview identity throughout. Allow for page/media preparation time.
3. On localhost, clear the bounded diagnostic buffers before starting the real
   publisher. Collect the publisher/path-ready timestamp and the Control,
   Public and OBS traces covering candidate/CHECKING/ONLINE/stabilizing,
   acquisition-start, commit, publication revision, POST success, SSE revision,
   accepted, HLS preparation, ready, promoted, destroyed. Correlate by session,
   revision and source/scene; use each trace's at/deltaMs values. Preserve the
   failing traces before refresh. Long tests may exhaust the bounded buffer.
4. Compare the exact AutoLive revision with a manual media TAKE and manual TAKE
   to the same LIVE source. Establish the first absent/rejected boundary
   independently for Public and OBS; capture server retained/broadcast evidence
   if delivery is the first unexplained boundary.
5. Stop the real publisher. Require A to resume at interruption cue in Control,
   Public and OBS, with Preview preserved. Repeat with manual operator override
   and ensure stale recovery cannot take authority back.

NEXT_STEP = MANUAL RETEST CONTROL/SCHEDULER CONTINUITY + AUTOLIVE ACQUISITION

ENV_CHANGED no

SERVICES_CHANGED no

MEDIAMTX_CHANGED no

AUTH_CHANGED no

PROGRAM_OUTPUT_PROTOCOL_CHANGED no

P0_C1B2_STARTED no

STAGING_CHANGED no

COMMIT none

PUSH none

LIVEZONE LOCAL RUNTIME CONTINUITY AND AUTOLIVE AUDIT COMPLETE
