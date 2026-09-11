# AutoLive source routing audit

DECISION: AUTOLIVE_SOURCE_ROUTING_READY_FOR_MANUAL_RETEST

BASELINE: repository `C:/Projects/livezone-broadcast-engine-x`, branch `build/1003.3`. Existing dirty worktree accepted and preserved. Reported preceding suite: 540/540.

REAL_RUNTIME_PROOF: user observed authorized external `testlive` ONLINE in Technical Monitor, while `/api/media-ingest/status?sourceOnly=1` described OFFLINE `local-main` at `http://127.0.0.1:8888/livezone-test/index.m3u8`. These endpoints represent different sources. The external hostname in deterministic tests is a synthetic `.example` address; no real stream is contacted by tests.

CURRENT_SOURCE_PRESENCE_MODEL: SourcePresenceMonitor resolves authority before interpreting health. Managed sources use server publisher presence. Other HLS sources use browser LiveSourceMonitor. Both publish source-specific CHECKING, ONLINE and OFFLINE/retry observations with monotonic generations. Controller transport logic is unchanged.

LIVE_SOURCE_AUTHORITY_CLASSIFICATION: catalog HLS records contain `id`, `url` OR `configRef`, `enabled` and `origin`; catalog snapshots resolve configRef to URL. Neither origin nor configRef identifies MediaMTX ownership. The existing authenticated server descriptor supplies the single explicit `ingestId`/`playbackHlsUrl` mapping. Exact resolved endpoint equality selects managed authority, retaining the existing localhost/127.0.0.1 endpoint alias normalization. A different valid HTTP(S) endpoint selects external HLS regardless of hostname. A remote mapped endpoint remains managed; an unrelated loopback endpoint is external. No new persisted catalog schema is necessary. Multiple managed ingests would require a trusted descriptor registry and corresponding status routing; this change does not pretend the current single-ingest API supports that.

MANAGED_INGEST_HEALTH_PATH: resolve selected endpoint against trusted descriptor, pin matched ingestId for this lifecycle, continue existing authenticated sourceOnly polling. Both endpoint and pinned ingestId must match every result. Publisher presence, retained-buffer handling, uncertainty, 2000ms complete-request deadline and 1000ms polling remain intact. API errors or changed mapping never trigger HLS fallback for a mapped managed source.

EXTERNAL_HLS_HEALTH_PATH: after descriptor classification, stop local status polling and monitor exactly the authorized source URL with LiveSourceMonitor and the shared muted HLS consumer. Local publisher state is not consulted to determine external health. Initial descriptor lookup remains an authenticated, bounded dependency; missing/failed mapping produces diagnosed retry instead of guessing authority.

TECHNICAL_MONITOR_REUSE: extracted the existing advancing-playback consumer into `LiveHlsHealthConsumer.js`. TechnicalLiveMonitorUI and AutoLive use this implementation plus LiveSourceMonitor, with independent instances and selections. The old DominantLiveHealthConsumer export delegates for compatibility. Technical Monitor now also requires advancing playback after decoded readiness and detects stalled/ended playback; a frozen cached frame cannot recover either monitor. Existing readiness deadline is 12000ms and progress watchdog is 5000ms.

SOURCE_IDENTITY_ROUTING: each lifecycle invalidates old requests, unsubscribes and destroys the previous HLS monitor, and cancels timers. Normalized observations use a strictly increasing generation across backend and HLS events. Late source responses/events cannot authorize the replacement source. No automatic source selection or UI-selection dependency was introduced.

SSRF_SECURITY_REVIEW: no server code or fetch endpoint changed. The browser calls only the existing authenticated same-origin descriptor/status route; external HLS requests are performed by the existing browser playback primitive using catalog URLs. No browser-provided URL is sent for server-side fetching. Added trace events contain source ID, state, reason and generation, not raw endpoints.

ROOT_CAUSE: the previous single-ingest monitor rejected every external source as ENDPOINT_MISMATCH even when its own HLS was healthy.

FIX: classify against existing trusted mapping, route external health to the shared browser HLS primitive, normalize identity/generation/loss and retain managed publisher authority.

REAL_TESTLIVE_CASE: deterministic integration with production SourcePresenceMonitor, LiveSourceMonitor, DominantLiveController, StudioProgramCommand and StudioTransitionCoordinator. Backend local-main OFFLINE plus testlive HLS ONLINE reaches ONLINE, unchanged 3000ms stabilization and Program acquisition. Transport/video readiness is simulated. The exact test failed before the fix (ERROR versus ONLINE) and passes after; see `var/autolive-source-routing-before.log`.

REVERSE_LOCAL_INGEST_CASE: managed publisher absent remains OFFLINE with no acquisition while unrelated Technical HLS is ONLINE; no external consumer is created for the managed source.

MULTIPLE_EXTERNAL_SOURCE_CASE: testlive ONLINE, primecast OFFLINE; observations and acquisition follow the authorized ID only.

SOURCE_CHANGE_CASE: switch while armed cancels testlive stabilization, destroys its monitor, and ignores late ONLINE. Returning authorization to testlive requires fresh health and stabilization. Late descriptor replies and external-to-managed switches are covered.

LOSS_BEHAVIOR: routed managed and external losses retain the existing 5000ms controller grace and end one interruption. Once external loss is confirmed, a retry's CHECKING does not erase that loss; only fresh ONLINE clears it. Publisher API uncertainty retains its existing semantics. Stabilization and controller grace constants are unchanged.

RETURN_CUE_REGRESSION: existing production controller/Program command tests for Program identity, cue, Preview restoration, operator override, repeated transient loss and stale generations pass. Controller, scheduler, Program command, renderer and output protocol were not edited in this fix.

TESTS_ADDED: 15 deterministic routing/shared-consumer tests in `test/autolive-source-routing.test.js`. Two existing source-inspection tests now follow the extracted shared consumer. New coverage includes the exact reported failure, reverse case, multiple external sources, stale events, both routed losses, configRef and endpoint classification, pinned ingest identity, lifecycle cleanup, deadline failure and Technical/AutoLive readiness/loss parity.

REGRESSION_RESULTS: focused source presence, Technical/live sources, DominantLive, authorization, checking, Program Output/Public, OBS, scheduler continuity, Control Room and unified sources: 378/378. Full `node --test`: 555/555, zero failures/skips/cancellations. Syntax checks on all eight changed/new JavaScript files and `git diff --check` pass. Logs: `var/autolive-source-routing-focused.log`, `var/autolive-source-routing-all.log`.

FILES_CHANGED_FOR_THIS_FIX:

- `public/js/entries/control-room-app.js`: wire independent external consumer into presence routing.
- `public/js/studio/SourcePresenceMonitor.js`: classification, handoff, normalized identity and lifecycle handling.
- `public/js/studio/LiveHlsHealthConsumer.js`: shared existing HLS health implementation, new file.
- `public/js/studio/DominantLiveHealthConsumer.js`: compatibility export.
- `public/js/ui/TechnicalLiveMonitorUI.js`: delegate to shared implementation.
- `test/autolive-source-routing.test.js`: new integration and parity tests.
- `test/dominant-live.test.js`, `test/live-sources.test.js`: follow shared implementation in existing source assertions.
- This audit and the three routing test logs listed above.

EXISTING_UNSTAGED_WORK_STATUS: preserved; no reset, restore, clean, stash, stage, commit or push. Thirteen relevant baseline hashes verified unchanged, including controller/config, catalog, LiveSourceMonitor, StudioHlsSurface, scheduler/command, output transport/manager, Control Desk and server ingest implementation.

PROTECTED_FILES_STATUS: no edits to .env, MediaMTX configuration, authentication, Program Output protocol, P0-C1B2, Scene Composition or Safe Delete. Existing modifications in protected neighboring areas remain baseline work.

GIT_STATUS: branch build/1003.3; worktree remains dirty with prior work plus this fix; index remains empty.

BLOCKERS: none for manual retest. No new real-browser result is claimed; validation here is deterministic automated testing against the user-provided runtime evidence. Initial authority resolution requires the existing authenticated descriptor response.

MANUAL_RETEST:

1. Refresh the authenticated Control Room, authorize external testlive, arm AutoLive and enable Scheduler. Keep local-main OFFLINE.
2. Verify testlive progresses through HLS CHECKING, ONLINE/STABILIZING, then normal Program acquisition; Public/OBS follow normal output. After classification, local ingest polling should stop for this AutoLive lifecycle.
3. Authorize OFFLINE primecast while armed. Confirm no late testlive event acquires Program. Select testlive again and verify fresh stabilization.
4. Interrupt external HLS and verify loss grace and restoration of interrupted Program/cue/Preview. Restore HLS and verify fresh stable acquisition.
5. Authorize the mapped managed endpoint with no publisher while an unrelated Technical HLS is ONLINE: no acquisition. Start/stop its publisher and verify managed acquisition/loss/return.
6. Refresh and verify authorized source/armed persistence, Control Desk collapse and Scheduler continuity.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST AUTOLIVE WITH AUTHORIZED EXTERNAL HLS SOURCE

LIVEZONE AUTOLIVE SOURCE ROUTING AUDIT COMPLETE
