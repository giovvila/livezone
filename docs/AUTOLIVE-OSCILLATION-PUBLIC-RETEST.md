**DECISION**

AUTOLIVE_OSCILLATION_PUBLIC_READY_FOR_MANUAL_RETEST

This decision means the local correction and automated regression are ready for testing with the real publisher. It does not certify an observed browser/publisher run.

**BASELINE**

Repository `C:/Projects/livezone-broadcast-engine-x`, branch `build/1003.3`. Authorized dirty baseline preserved. Baseline executed: 445/445 PASS. No reset, restore, clean, stash, staging, commit or push.

**REAL_OSCILLATION_MODEL**

The reported acquisition `A -> LIVE -> A -> LIVE` and persistent-loss `LIVE -> A -> LIVE -> A` remain the authoritative user observation. No historical RuntimeTrace export was supplied and no browser was connected; exact real transition timestamps and the first actual runtime event could not be recovered.

The previous production wiring connected AutoLive to DominantLiveHealthConsumer through LiveSourceMonitor. A progressing HLS player supplied ONLINE, and a player watchdog supplied OFFLINE. The controller then issued real Program commands to acquire/restore. This is an ownership mechanism capable of changing Program itself, not merely a Public renderer problem. A new player retry could play buffered segments and become ONLINE after restoration. Existing monitor generation checks protected callbacks from an earlier attempt, but did not prove that a newly created consumer had a live publisher.

**ACQUISITION_TRANSITION_HISTORY**

Code-derived failure model, not a captured real trace: A; player progress ONLINE; 3000 ms stabilization; LIVE command; player stall/OFFLINE; grace expiry; restore A; retry player progress ONLINE; stabilization; LIVE command again.

Corrected deterministic history: A -> LIVE once. Source uncertainty/recovery and repeated observations do not change Program. The additional committed-player-failure test keeps source ownership after a successful Program commit.

**LOSS_TRANSITION_HISTORY**

Code-derived failure model: LIVE; player loss; restore A; a new buffered player becomes ONLINE; LIVE reacquisition; buffer exhaustion; final A restoration. Exact timings of the reported approximately ten-second resurrection are unmeasured.

Corrected command-to-retained-store test: revision 1 MEDIA -> revision 2 HLS -> revision 3 MEDIA. Exactly one restoration. Stale ONLINE and player-only events leave revision 3 unchanged.

**FIRST_INVALID_AUTOLIVE_TRANSITION**

In the acquisition model: restoring Program because player health degraded without confirmed source absence. In the persistent-loss model: treating buffered player progress as a new source acquisition after restoration. These are identified code paths; the first event in the user's real failing run still requires its trace.

**SOURCE_HEALTH_MODEL**

Control AutoLive now uses SourcePresenceMonitor. It polls the existing authenticated same-origin status route with `sourceOnly=1`. Matching configured HLS endpoint plus a valid server publisher-present result means ONLINE. Explicit server offline means confirmed absence. API failure means CHECKING/uncertainty, which cannot independently restore Program. An unmatched source is not authorized by the local ingest's presence signal. External arbitrary HLS endpoints require their own authoritative source integration; there is no player-based fallback.

Poll requests are sequential, with a 1000 ms interval after completion and a 2000 ms browser abort deadline. Each observation has a monotonic generation. Source replacement and destruction abort requests and invalidate late responses. API pagination that omits the path is treated as uncertain, not false absence.

**PLAYER_HEALTH_MODEL**

HLS decoding, readiness, canplay/playing, buffered currentTime, and recovery remain surface concerns. None feeds the production AutoLive source monitor. Program preparation still validates readiness. After a committed LIVE transition, a player activation failure cannot itself trigger source restoration. Studio HLS surfaces now trace their health and safe instance/consumer identifiers.

**MEDIAMTX_PUBLISHER_SIGNAL**

Local installed binary: v1.20.1. Read-only API observation found `livezone-test`, online=false, ready=false, source=null. At 2026-09-08T21:17:19.132Z the updated server client reported offline/publisherPresent=false in 54 ms without HLS probing.

For this version, `ready` is deprecated and represents availability. Source ownership uses `online`, a valid source descriptor and tracks, not ready/available or HLS contents. Publisher removal sets the path offline and clears its source even when an always-available stream remains. References: [MediaMTX path schema](https://raw.githubusercontent.com/bluenviron/mediamtx/v1.20.1/internal/defs/api_path.go), [path state and publisher removal implementation](https://raw.githubusercontent.com/bluenviron/mediamtx/v1.20.1/internal/core/path.go).

The API remains server-side. No MediaMTX configuration or browser API exposure was introduced. Normal status requests retain the existing HLS probe; ownership-only requests skip it.

**STALE_EVENT_FINDINGS**

- Old monitor responses: lifecycle checks and abort prevent delivery. Confirmed-loss session closure restarts the source observation lifecycle, invalidating requests that began before restoration.
- Duplicate/older authoritative observations and ONLINE from a closed observation generation: rejected.
- Old HLS consumer, delayed playing/canplay, buffered time progress, and retry consumer ONLINE: disconnected from ownership.
- Stabilization callbacks: cleared and protected with both session generation and a timer token.
- Loss timers: session generation checked and cleared on closure/recovery.
- Pending acquisition: a pre-commit guard revalidates generation, arm state, source health and loss epoch after asynchronous preparation. Recovery cannot revive the acquisition invalidated by a loss.
- Session finishing: duplicate completion suppressed, and acquisition waits for restoration to finish.
- Public stale readiness/play callbacks: abort/identity guards prevent replacing a newer surface; a newer return to the current activation cancels an obsolete pending LIVE surface.

**AUTOLIVE_LATENCY_BREAKDOWN**

Real publisher-present-to-commit latency has not been measured. Previous code waited for HLS preparation, decoded readiness and advancing playback before starting its 3000 ms stabilization; offline retry added 5000 ms and preparation could time out at 12000 ms. Those costs must not be presented as measured elapsed time.

The new candidate path is server source observation -> unchanged 3000 ms stabilization -> ordinary Program preparation -> commit. It removes the independent browser HLS ownership probe and its progress wait. The measured 54 ms is only an offline API sample. RuntimeTrace records publisher online time when available, source request duration, source detection, stabilization, acquisition, command and commit timestamps for the next measurement.

**AUTOLIVE_FIX**

Authoritative source monitoring, internal loss grace, one session closure/restore, closed-generation rejection, guarded stabilization/acquisition and serialization with restoration. Interrupted Program cue and operator Preview restoration remain in their existing paths.

**PUBLIC_ROOT_CAUSE**

Confirmed code defects: config failure terminated startup before SSE; a failed accepted revision could not be retried because revision filtering already recorded it; audio preparation could await a pending play promise; NotAllowedError only exposed an audio button without attempting muted fallback; a newer revision returning to the current activation could leave an older pending surface eligible for promotion.

Detached video preparation with default preload was also made explicit and connected to improve browser loading behavior. Its causal contribution to the reported real VIDEO failure is not yet proven in a browser.

**PUBLIC_BOOTSTRAP_SSE_FINDINGS**

The server serves network configuration even though the development file says local. Network transport starts its subscriber after listener registration and receives the server's retained SSE envelope. No alternate HTTP bootstrap snapshot is introduced. Public-only startup now aborts config fetch after 8000 ms, retries after 1000 ms, and cancels on page close. A deterministic config-failure/SSE test verifies that the later retained revision wins. Existing real HTTP POST/store/SSE tests cover open and late subscribers.

**PUBLIC_AUDIO_GATE_FINDINGS**

Fresh VIDEO already requested mute in the baseline; audio permission therefore was not assumed to explain every VIDEO failure. AUDIO, however, was not played before unlock, and a rejected audible play had no muted fallback. Public now prepares/plays muted media independently of audio unlock; its explicit button only requests audible playback. Unlock preserves the current element and existing timeline catch-up behavior.

**PUBLIC_FIX**

Connected transparent preparation, explicit video preload/load, abortable AUDIO preparation, nonblocking play, muted autoplay fallback, retry of the latest failed revision, current HLS fatal-error retry, bootstrap recovery and cancellation of superseded promotion. Failed preparation still releases obsolete media; the stale-surface cleanup baseline was preserved.

**CONTROL_SCHEDULER_REGRESSION**

Full suite passes. SchedulerEngine, ProgramPlaybackContinuity, StudioStateManager and StudioRenderer were not changed by this correction. Normal Program commands use their existing behavior; only callers supplying canCommit request the additional pre-commit check.

**RETURN_CUE_REGRESSION**

Passed media/audio/image/LIVE/empty return coverage and the 37-second interrupted cue assertions.

**PREVIEW_REGRESSION**

Passed operator Preview preservation, Preview changes during LIVE and ordinary CUT/DISSOLVE behavior. Interrupted Program is not copied into Preview.

**OBS_REGRESSION**

OBS entry, configuration and CSS unchanged. OBS and shared-output tests pass, including real store/SSE transport, rapid revision supersession, pending play, retained snapshots and stale cleanup. Actual OBS rendering with the real publisher remains a manual check.

**TESTS_ADDED**

28 tests added across dominant-live, source-presence and runtime-determinism. They cover source-only status, retained tracks after loss, uncertainty, wrong endpoint, late responses, one acquire/restore, stale and player-only ONLINE, old generations, canceled stabilization/acquisition, pre-commit loss, post-commit player degradation, exact retained revision history, muted startup/audio transitions, rejection fallback, pending play, retry without refresh, latest-revision convergence, stale LIVE promotion and config/SSE recovery. Existing audio assertions were updated to require muted playback rather than an audio-dependent start.

**REGRESSION_RESULTS**

Baseline `node --test`: 445/445 PASS. Final `node --test`: 473/473 PASS, zero failures/cancellations/skips. Focused suites pass. Syntax checks: 17 JavaScript files PASS. `git diff --check`: PASS; final changed-code whitespace check PASS.

**FILES_CHANGED_FOR_THIS_FIX**

- public/js/core/RuntimeTrace.js
- public/js/entries/control-room-app.js
- public/js/entries/public-app.js
- public/js/program-output/ProgramOutputTransportFactory.js
- public/js/public/PublicProgramBootstrap.js (new)
- public/js/public/PublicProgramController.js
- public/js/scheduler/StudioProgramCommand.js
- public/js/studio/DominantLiveController.js
- public/js/studio/SourcePresenceMonitor.js (new)
- public/js/studio/StudioTransitionCoordinator.js
- public/js/studio/renderers/StudioHlsSurface.js
- server/media-ingest/MediaIngestRoutes.js
- server/media-ingest/MediaIngestStatusClient.js
- test/dominant-live.test.js
- test/program-output-network.test.js
- test/runtime-determinism.test.js
- test/source-presence.test.js (new)
- docs/AUTOLIVE-OSCILLATION-PUBLIC-RETEST.md (new)

**EXISTING_UNSTAGED_WORK_STATUS**

Preserved. SHA-256 inventory comparison of preexisting tracked/untracked nonignored files found changes only in the intended correction files; existing media/assets and unrelated dirty work were unchanged. Preexisting untracked RuntimeTrace and runtime-determinism files remain untracked, with this task's additions.

**PROTECTED_FILES_STATUS**

No writes to environment files, auth, MediaMTX/service configuration, Program Output protocol, protected project metadata or media assets. The Git index comparison is unchanged. Ignored environment/runtime files were not part of the hash inventory; no task operation wrote them.

**GIT_STATUS**

Branch build/1003.3. Existing dirty and untracked baseline retained, plus the correction above. No staged changes, commit or push. No P0-C1B2 work.

```text
 M public/css/studio.css
 M public/js/core/StudioStateManager.js
 M public/js/entries/control-room-app.js
 M public/js/entries/public-app.js
 M public/js/program-output/NetworkProgramOutputTransport.js
 M public/js/program-output/ProgramOutputManager.js
 M public/js/program-output/ProgramOutputTransportFactory.js
 M public/js/public/PublicProgramController.js
 M public/js/scheduler/SchedulerEngine.js
 M public/js/scheduler/StudioProgramCommand.js
 M public/js/studio/DominantLiveController.js
 M public/js/studio/DominantLiveHealthConsumer.js
 M public/js/studio/LiveSourceMonitor.js
 M public/js/studio/StudioRenderer.js
 M public/js/studio/StudioTransitionCoordinator.js
 M public/js/studio/renderers/StudioHlsSurface.js
 M public/media/demo2.mp4
 M server/media-ingest/MediaIngestRoutes.js
 M server/media-ingest/MediaIngestStatusClient.js
 M test/dominant-live.test.js
 M test/program-output-network.test.js
?? docs/AUTOLIVE-OSCILLATION-PUBLIC-RETEST.md
?? docs/AUTOLIVE-RUNTIME-DETERMINISM.md
?? docs/LOCAL-OBS-OUTPUT.md
?? docs/LOCAL-RUNTIME-CONTINUITY-AUTOLIVE-AUDIT.md
?? public/assets/logo/logo-test.svg
?? public/css/obs-output.css
?? public/js/core/RuntimeTrace.js
?? public/js/entries/obs-output-app.js
?? public/js/public/PublicProgramBootstrap.js
?? public/js/studio/ProgramPlaybackContinuity.js
?? public/js/studio/SourcePresenceMonitor.js
?? public/media/demo3.mp4
?? public/media/imm.jpg
?? public/media/test-audio.mp3
?? public/output/
?? test/obs-output.test.js
?? test/program-playback-continuity.test.js
?? test/runtime-determinism.test.js
?? test/source-presence.test.js
?? test/studio-state-persistence.test.js
```

**BLOCKERS**

No remaining automated-check blocker to manual retest. No connected browser and no supplied historical RuntimeTrace: the exact real oscillation timeline, real acquisition latency and visible seven-case playback matrix remain unverified. These limits must not be mistaken for evidence of a successful real run.

**MANUAL_RETEST**

Load the updated server code and browser modules using the normal local development procedure before beginning; this task did not restart services. Then keep the failing pages open throughout the run.

1. Open Public while A exists; separately open Public before taking A. Both must play muted without ENABLE AUDIO.
2. Run A -> B, VIDEO -> AUDIO and AUDIO -> VIDEO. Unlock audio later; verify no restart or cue reset.
3. Publish the authorized local source while A plays. Expect exactly A -> LIVE after stabilization. Compare Control, Public and OBS.
4. Introduce a brief loss/recovery inside grace. Expect continuous LIVE ownership and no restore TAKE.
5. Disconnect persistently. Expect exactly LIVE -> restored A at its interrupted cue, with no LIVE resurrection. Verify Preview remains the operator selection.
6. Compare the Public promoted revision with the last server SSE revision and Control publish trace. Verify no refresh was needed for any transition.
7. On any failure, export `livezoneRuntimeTrace.exportJSON()` or call `livezoneRuntimeTrace.download()` from each existing localhost page before closing/reloading it. Trace storage is bounded (1000 entries by default), memory-only and allowlisted; no URLs, cookies, credentials or raw error payloads are recorded.

**NEXT_STEP**

MANUAL RETEST AUTOLIVE OSCILLATION + PUBLIC VIEWER

```text
ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none
```

LIVEZONE AUTOLIVE OSCILLATION AND PUBLIC VIEWER AUDIT COMPLETE
