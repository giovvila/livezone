# BUILD 1003.4 — Control HTTP/1.1 socket pool saturation

## Decision and scope

**DECISION: BUILD_1003_4_CONTROL_SOCKET_POOL_MANUALLY_VALIDATED**

Implementation, automated verification and the primary socket-pool manual retest are complete. The operator's final validation below is authoritative. Repository: `C:\Projects\livezone-broadcast-engine-x`, branch `build/1003.4`.

The fix changes connection ownership, not media preparation, seek, Range, preload, timeouts, rendition, URLs of media, AutoLive health or scheduler authority. During implementation no production service restart, TAKE, production media deletion, environment change, staging, commit or push was performed. A subsequently authorized LivezoneNode-only restart loaded the fix; the operator then performed the manual retest. This final documentation update changes no production code or staging.

## Final authoritative manual validation — 2026-09-15

The operator reports PASS after Control socket-pool consolidation for:

- Control + MEDIA B large Program.
- Control + MEDIA B + Public.
- Control + MEDIA B + Public + small VIDEO Preview.
- Control + MEDIA B + Public + OBS software.
- Long audio-12 + Public.
- Normal VIDEO + Public.
- Normal TAKE / continuity.
- Sustained MEDIA B playback.

The primary socket-pool fix is **manually validated**. These results supersede the earlier ready-for-retest status; they are operator-supplied validation, not a new automated run or a newly analyzed NetLog. Shared Control Event Stream architecture remains accepted. No MP4 seek/preload/Range investigation is reopened.

## KNOWN NON-BLOCKING LIMITATIONS

With **audio-12 in Program + MOTION ARTWORK**, the operator reports:

| Consumer | Manual result |
|---|---|
| Control Room | PASS |
| Public | PASS |
| OBS software | PASS |
| OBS web page opened as an additional tab in the same Edge browser | FAIL |

This is an accepted **same-browser connection/resource boundary**, not a blocker for BUILD 1003.4. OBS software is the intended operational consumer of `/output/obs/` and works correctly. The extra Edge tab shares browser resources; the supplied observation does not identify a new precise internal failure mechanism. No production-code change is authorized for this observation in the current checkpoint. Do not weaken the validated shared stream architecture or change MP4 seek/preload/Range to address it.

Staging, commit and push remain pending separate authorization.

## Primary real-world evidence

The three inputs are in `var/diagnostics` (not the originally supplied root-level `diagnostics`):

- `MEDIA-B-CONTROL-PUBLIC-KO-NETLOG.json`: 6,000 events plus constants and pool snapshots.
- `MEDIA-B-CONTROL-NETLOG-KO.txt`: 1,000 runtime events, 512 media-resource events, inventory and 11 media Resource Timing entries.
- `MEDIA-B-PUBLIC-NETLOG-KO.txt`: 93 runtime events and two completed Resource Timing entries.

NetLog clock conversion: `epochMilliseconds = Number(event.time) + 1789314237236`. All capture times in this document are UTC on 2026-09-14. Detailed continuous NetLog coverage is 22:26:50.652–22:27:22.878; earlier REQUEST_ALIVE records summarize preexisting sources, without their original socket-binding history. Control export: 22:28:25.166; Public export: 22:29:36.355. Later Public retries cannot be independently diagnosed from this NetLog.

| Time | Source / event | Interpretation |
|---|---|---|
| 22:27:00.364 | job 7060, SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP | Earliest pool saturation. JS bootstrap request obtains a socket at .366; transient contention alone is not the persistent KO. |
| 22:27:00.464 | Public SSE 7117 → controller 7118 → job 7119 → socket 6928 | Reuses the available local socket; HTTP 200 at .465 and remains open. |
| 22:27:00.467 | Public snapshot accepted | Correct revision 5, session, Media B identity and playback start. |
| 22:27:00.469/.471 | Public src assigned / loadstart | No metadata yet. |
| 22:27:03.084 | PUT 7152 → job 7154, per-group socket stall | First persistent wait observed, before the MP4 request. |
| 22:27:03.708 | Public player-stalled | DOM stall precedes the first recorded MP4 request; its initial 3.65-second dispatch delay is not explained by the capture. |
| 22:27:04.117 | Public MP4 request 7162, Range bytes=0- | Request enters network stack. |
| 22:27:04.124–.125 | cache backend, create entry 7163, add-to-entry | All complete in 0–1 ms. Cache is not the recorded wait. |
| 22:27:04.125 | 7162 → 7164 → 7165, SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP | First internal MP4 divergence: no socket allocation. |
| 22:27:12.474/.475 | Public surface-failed / NetLog CANCELLED | Cancellation follows failure by 1 ms; 8,350 ms spent at the socket pool. |
| 22:27:13.484/.485 | MP4 7205 → 7207 → 7208 | Same cache success and per-group stall; at least 9,393 ms still waiting at capture end. |

Neither recorded Public MP4 request gets a socket, sends HTTP request headers, receives response headers, or reads body bytes. The request preparation headers in CORS/cache events are not evidence of transmission. Connection capacity starvation is demonstrated; cache locking, server Range handling, projected seek and decoder failure do not explain this pre-transmission wait. No ERR_INSUFFICIENT_RESOURCES or ERR_OUT_OF_MEMORY is recorded. The pool snapshot has six active sockets, zero idle, zero connect jobs, two pending, max_sockets_per_group=6. The pool's `is_stalled:false` does not negate per-group exhaustion: Chromium distinguishes it from global pool exhaustion.

Long-lived Media B transfer occupancy explains why the connection topology can become critical while a smaller transfer may finish and release its slot. The separately reported long-audio PASS and Public+OBS-without-Control PASS are useful scenario evidence, not additional NetLogs proving an identical connection timeline.

Control is progressing at 216.565 s at 22:27:00.486 and 220.006 s at 22:27:04.105, while Public remains at readyState=0/currentTime=0. Preexisting MP4 source 5392 delivers 10,485,760 bytes in the detailed window. Control's final inventory has one active video, 69 created/68 released, no pending cleanup. Its 40 resource error events belong to the technical live HLS source, not Media B. Public has 11 surfaces, 11 stalls and 10 failed/retry cycles, without successful metadata or playback events. These are one episode, not independent captures to average together.

## Persistent connection inventory — production topology

Search covered production `public` and `server` EventSource constructors, factories, endpoint strings and streaming wrappers. Browser native media transfers are listed separately from SSE. Before-fix sources were preserved in `var/socket-pool-audit/*.before` to distinguish this patch from the existing checkpoint and unstaged work.

| Endpoint / transport | Creating module and function | Owner and callback consumers | Purpose | Lifetime / Control instances before → after | Reconnect / close | Shareable / background requirement |
|---|---|---|---|---|---|---|
| reference-presence | ReferenceClient.initialize; control-room-app bootstrap | ReferenceClient, server ReferenceClientRegistry; notifyReferenceAuthorityChanged → Media Library UI refresh | Authenticated reference participation, disconnect-driven UNKNOWN and Preview uncertainty | Document; 1 → one lease on canonical stream | Before: native EventSource; ReferenceClient.close at pagehide. After: shared native retry/closed retry; lease close and owner pagehide | Yes, keep continuously. Silence must never prove UNUSED. |
| program-output/events | ControlCrawlObserver constructor/start; explicit call in control-room-app | Program graphics layer; TextCrawlView, SponsorView including fullscreen; effective overlay clock offset | Apply server effective overlays, without constructing Program media | After renderer start; 1 → one lease | NetworkProgramOutputTransport subscriber; observer.destroy releases; idempotent start added | Yes; identical authoritative envelope, required while Control remains open/background |
| program-output/events | NetworkProgramOutputTransport.startPublisherMonitor, called by ProgramOutputManager.start | Publisher transport handleOpen/handleError; queueLatest; ProgramOutputSetupUI status observer | Detect server reconnection and replay latest publisher envelope; does not render Program and did not listen to program payload | After observer starts; 1 → one lease | Before native retry. After canonical shared reconnect; publisher's separate bounded POST retry retained; manager.destroy releases | Yes; connectivity monitoring does not need an independent HTTP response |
| program-output/events (bounded bootstrap) | NetworkProgramOutputTransport.readRetained before StudioRenderer creation | restoreRetainedProgramIdentity, programPlaybackContinuity | Read retained output before publishing/reconstructing initial local context | Temporary, max 2 s; 1 temporary socket → temporary lease | Close on valid retained event/error/deadline; destroy now also cancels pre-start retained reads | Yes; retained cache is cleared on connection error and only server events are replayed |
| studio/schedule/events | ServerScheduleStore → ScheduleApiClient.start | Control summary, read-only embedded ScheduleWorkspaceUI, removal guard | Server schedule projection and revision invalidation followed by bounded GET | Always started in Control, even with Scheduler panel closed; 1 → one lease | Native retry through canonical owner; ScheduleApiClient.destroy removes listener/releases; async start epoch guard added | Yes. Needed for background summary/removal semantics; no browser clock takes authority |
| reference-presence?controlEvents=1 | ControlEventStream.presenceSource after ReferenceClient registration | All four leases above | Single authenticated multiplex response | New steady-state physical stream: 1 | One native EventSource; CONNECTING uses native retry; CLOSED/factory failure uses one 3 s owner timer; last lease/pagehide/destroy closes | Explicit document scope; no singleton shared with Public/OBS |
| Program video/audio/HLS | StudioRenderer and StudioMediaSurface/StudioAudioSurface/StudioHlsSurface | Local Program renderer and ProgramOutputManager's local subscriptions | Media playback, TAKE/BREAK continuity | Media-dependent; no SSE created by renderer | Existing media lifecycle unchanged | Not replaced by SSE; native transfers counted below |
| Preview media | StudioRenderer Preview surface | Local Preview | Preview playback | Media-dependent | Existing media lifecycle unchanged | Independent media transfer, budgeted separately |
| live health | LiveSourceMonitor, SourcePresenceMonitor, shared Technical health factory | Technical Monitor / AutoLive | Live health sampling and existing retry/backoff | Zero additional SSE; configured HLS requests on their own origin unless configured same-origin | Existing validated health ownership unchanged | Existing technical sharing retained; no health disable |
| Preview ownership API | PreviewOwnershipClient.start/report/heartbeat | Preview reference authority | Serialized POST/PUT/DELETE reference acknowledgement | Zero persistent HTTP responses; bounded requests, 8 s heartbeat | Existing generation/sequence, stop and confirmedGone paths | Requires transient API capacity; not an SSE |
| Studio/legacy/Channel Logo authority APIs | StudioReferenceAuthority, LegacyAssetReferenceAuthority, ChannelLogoReferenceClient | Catalog/asset/logo reference protection | Reconcile/confirm/serialized mutations | Zero persistent responses | Existing bounded requests and explicit acknowledgements | No new subscription or authority |
| EffectiveProgramOutput | Server effectiveOutput.subscribe | Server merge owner; ControlEventFeed forwards its envelopes | Merge scheduled overlays with publisher base | In-process subscription, not HTTP | Feed subscriptions removed at server.close | Sole effective authority unchanged; same envelopes reach Public/OBS |
| Public/OBS program-output/events | public-app / PublicProgramBootstrap → transport factory subscriber | PublicProgramController / OBS page renderer | Independently render server output | One per document, before and after | Existing Public lifecycle/retry unchanged | Independent when Control is closed; not removed or redirected |
| Dedicated Scheduler page | schedule-app → ReferenceClient(role SCHEDULER) and ServerScheduleStore | Standalone editor | Authenticated presence and server schedule editing | Zero extra Control instances; standalone document still has two streams | Its existing pagehide cleanup remains | Separate scope; not the embedded Control panel |
| local transport | LocalProgramOutputTransport | Configured local-mode users | BroadcastChannel/storage messaging | Zero HTTP connections | Existing local lifecycle | No HTTP/SSE capacity cost |

### Why 5107 and 5108 exist

The two required logical owners are proven in bootstrap code. After bounded `readRetained()` has finished, `controlCrawlObserver.start()` opens the subscriber stream. Later `programOutputManager.start()` opens the publisher monitor stream. There is exactly one call site for each in normal Control bootstrap.

- **5107: ControlCrawlObserver subscriber**, by the normal sequential construction order.
- **5108: ProgramOutputManager publisher transport's startPublisherMonitor**, by the following construction order.

Both REQUEST_ALIVE records start at 22:22:46.542 and name the same endpoint. Their initial binding events and renderer/call-site tags are absent from the snapshot; the numeric-ID-to-component assignment is therefore a reconstruction from deterministic normal bootstrap order, not a directly recorded JavaScript stack. The fix does not depend on swapping those IDs. There is no evidence that either is a duplicate construction or a surviving bootstrap reader. The monitor consumes open/error, while the observer consumes effective program payloads. Both legitimate needs can use one connection. Program itself is rendered locally, not by another hidden PublicProgramController.

Choice: option B plus C. Merely merging the two Program connections reduces Control from four to three, leaving the Program+Preview+Public case over budget. Therefore reference presence and schedule events also use the same authenticated response. No polling of Program or reference truth is introduced.

## Before/after connection budget

Budget counts outstanding HTTP/1.1 responses in the same Chromium origin/network group. It does not count local JS subscriptions. Idle keep-alive sockets can be reused; active SSE/media responses cannot. Six is a test constraint from the captured browser, never an application limit constant.

| Scenario | Before | After | Capacity interpretation |
|---|---:|---:|---|
| A. Control without active media transfers | 4 | 1 | Five potential transient/media slots after fix |
| B. Control + one long VIDEO Program transfer | 5 | 2 | Four slots remain |
| C. Control + one long AUDIO transfer | 5 | 2 | Same network budget; animated artwork can add another media transfer |
| D. Control + LIVE | 4 + L | 1 + L | L is simultaneous same-origin HLS HTTP requests. External HLS uses its own group; do not invent a universal L. |
| E. Control Program + Preview video | 6 | 3 | Three slots remain before viewers |
| F. Control Program + Public SSE + Public media | 7 | 4 | Original reproduction now has two slots for Preview/API |
| F plus Preview video | 8 | 5 | One slot remains for API mutation; exercised with a six-slot HTTP Agent |
| G. F + actual OBS process | Edge 7; OBS 2 | Edge 4; OBS 2 | OBS tested with an independent Agent/network pool; add Preview to Edge → 5 |
| H. Embedded Control Scheduler open/closed | No change | No change | No extra stream on panel visibility |
| H. Dedicated Scheduler document in same browser group | +2 | +2 | Separate editor still owns presence+schedule. This audit does not claim unlimited same-origin documents fit. |
| I. Bootstrap / retained read | Temporary extra SSE, closed before steady state | No extra physical connection | Temporary retained lease shares presence stream |
| I. Reconnect | Independent per-consumer lifecycles | At most one current Control EventSource; native CONNECTING or one CLOSED retry | Replacement closes old source first; no second SSE to reconnect local listeners |

**Limits:** an OBS-view URL opened as another Edge tab is not an OBS process. Two same-pool viewer documents plus Control video consume six after this fix, and adding Preview consumes seven. Arbitrary tabs or same-origin HLS concurrency cannot be guaranteed with six slots. The supported tested reproduction is one Control document with Program+Preview, one Public document in that pool, transient API work, and OBS in its independent process. A dedicated Scheduler tab plus all those simultaneous transfers can also exceed the pool. This is reported explicitly rather than hiding traffic or claiming a browser-wide capacity guarantee.

## Architecture, lifecycle and reference correctness

`ControlEventStream` is explicitly created once by the Control entry point. ReferenceClient establishes the authenticated URL with current reference identity; the owner opts into `controlEvents=1`. Existing transports receive EventSource-compatible leases through their existing factory injection point. Program observer, publisher monitor, bootstrap read and scheduler client do not own physical sockets.

The server extends the existing protected reference-presence route only for CONTROL clients that opt in. The original operator authorization, principal/client generation checks and presence census remain. `ControlEventFeed` forwards existing EffectiveProgramOutput envelopes and SchedulerServer summaries as named `program` and `schedule-state` events. It has no clock, persistence, revision generator or merge authority. Legacy presence-only and standalone Public/OBS routes retain their behavior.

- Per-event retained payloads let late local listeners receive the current envelope/summary. Consumers retain their own validation/revision gates. A newer event supersedes a queued replay; released leases cannot receive it.
- Error clears retained data. A late schedule subscriber receives the current error rather than becoming writable solely from an earlier successful GET.
- Native CONNECTING is owned by EventSource. CLOSED/factory failure closes the source and schedules a single owner retry. Lease readyState reports CONNECTING while that retry is owned, preventing each NetworkProgramOutputTransport from creating its own retry socket.
- Last lease closes the stream. Document pagehide closes all leases and the retry timer. The existing persisted-pageshow reload policy remains. ENGINE_STOP/pagehide now also destroys ProgramOutputManager, releasing publisher retry ownership. This does not reconstruct media when a subscription is released/reacquired.
- `readRetained` tracks outstanding bounded reads so destroy-before-start cannot leak a lease. `ScheduleApiClient.start` checks its epoch after asynchronous refresh, preventing an old start from opening a stream after destroy/recreate.
- Feed writes respect backpressure by closing a slow response. Server close detaches feed listeners and ends its responses before waiting for HTTP shutdown.

### Server restart and UNKNOWN

A persisted reference client is not automatically confirmed in a new server epoch. On an authenticated, identified CONTROL multiplex reconnect, a missing epoch handshake yields `presence: UNKNOWN`, without marking the client confirmed or the epoch complete. Program monitoring and schedule delivery remain available, allowing the publisher's existing reconnect replay to restore output as it did through the former public monitor. Safe Delete stays non-deletable. A fresh Control handshake and existing catalog/legacy/logo/Preview acknowledgements are still necessary for complete reference authority. Other capability errors and legacy presence-only requests retain rejection behavior.

The real isolated-server restart test checks UNKNOWN, successful Program delivery, unchanged incomplete reference state, then a resumed Control registration and CURRENT_CAPABLE presence without pretending catalog reconciliation is complete. This prevents channel consolidation from coupling publisher recovery to unsafe automatic reference confirmation.

Network silence is never treated as an explicit close. Existing serialized reference recheck, inventory, Preview disconnect uncertainty, journal/quarantine, Channel Logo, Scheduler references and source ownership protection remain server-owned. Reference notifications invalidate the UI projection; they do not assert that an asset is deletable.

## Continuity and regression coverage

No Program/Preview media renderer or media source assignment code is changed by this patch. The observer still updates only effective overlays. Publisher monitor reconnect still queues the latest envelope; the server output merge preserves base playback identity, initial time and startedAt. Existing VIDEO/AUDIO/HLS, TAKE/BREAK, AutoLive ENTRY/loss/recovery, technical sharing, Program identity and Scheduler overlay regression suites are included in the full run.

New tests:

- `test/control-socket-pool.test.js` (12): production injection call sites; actual ReferenceClient/publisher/observer/ScheduleApiClient sharing; retained bootstrap; idempotent observer start; native reconnect; CLOSED replacement and zombie suppression; publisher replay; pagehide/pageshow; last-lease close and recreation; retained replay cancellation; pre-start destroy; async schedule destroy/start race; independent Public/OBS; cross-authority rejection; late disconnected Scheduler listener.
- `test/control-socket-pool-http.test.js` (7): real production Node server, test-only 32 MiB byte fixture and six-slot HTTP/1.1 Agent; VIDEO/AUDIO/Preview response occupancy, Public startup, API completion, independent OBS Agent; live server schedule/Crawl and retained reconnect; missing capability rejection and fail-closed disconnect; legacy endpoint compatibility; real isolated server restart/reference epoch.

The HTTP byte fixture verifies socket allocation and progress, not browser decoding or the real MEDIA B file. Browser media continuity and actual NetLog pool counts remain manual retest items. No service already running on 8080 was restarted by these tests.

### Test results

- First existing focused pass: **179/179**, Program Output network, Crawl and ScheduleApiClient.
- First new client tests: **11/11**.
- First new HTTP run: **5/6**; deterministic test-fixture `INVALID_PAYLOAD` (numeric speed / non-contract direction). Corrected to `speed: medium`, `direction: rtl`, continuous/broadcast-default fields. No production contract was loosened.
- Broader focused first run: **468/469**, same fixture failure; corrected HTTP rerun **6/6**. No unrelated focused regression failed.
- Initial complete `node --test`: **1465/1465**, before the final two additional lifecycle/reference-epoch cases.
- Final new focused tests: **19/19**.
- Final full `node --test`: **1467/1467 PASS**, zero failed/cancelled/skipped, 69.203 s (`full-final.log`).
- Syntax: **PASS**, `node --check` on all 11 JavaScript files added/modified for this fix.
- `git diff --check`: **PASS**, exit 0. Git also printed LF/CRLF conversion advisories, not whitespace errors.
- Final deterministic production failures in automated verification: **none**. The subsequent primary manual retest passed as recorded above; the additional same-Edge OBS-tab failure is an accepted non-blocking limitation.

Raw logs and before-file snapshots: `var/socket-pool-audit/`. First-run failures above are explicitly separated from final verification, not silently replaced with a retry result.

## Historical implementation-phase Git safety and changed files

Staged files before: **117**. Index SHA-256 before:

`30EC624644113BF6546C23334B5806DFFA6FDCBC46C50BA331889982888BAD56`

Staged files after: **117**. Index SHA-256 after:

`30EC624644113BF6546C23334B5806DFFA6FDCBC46C50BA331889982888BAD56`

**STAGING_CHANGED: NO.** The count/hash match exactly. No staging operation was used. Existing staged and unstaged work, including media files, was preserved; the `.before` snapshots record the starting working-tree content for this patch.

Files changed specifically for this fix:

1. `public/js/core/ControlEventStream.js` — new explicit shared Control connection owner.
2. `public/js/entries/control-room-app.js` — inject leases into all Control stream consumers and release manager/owner on teardown.
3. `public/js/studio/ReferenceClient.js` — injectable presence factory; default standalone behavior retained.
4. `public/js/program-output/ControlCrawlObserver.js` — idempotent start/release.
5. `public/js/program-output/NetworkProgramOutputTransport.js` — cancel bounded retained reads on destroy-before-start.
6. `public/js/scheduler/ScheduleApiClient.js` — asynchronous start epoch guard.
7. `server/program-output/ControlEventFeed.js` — forward server program/schedule events without another authority.
8. `server/program-output-server.js` — create/close feed.
9. `server/media-library/MediaLibraryRoutes.js` — opt-in multiplexed presence, reference UNKNOWN across server epochs, disconnect cleanup.
10. `test/control-socket-pool.test.js`.
11. `test/control-socket-pool-http.test.js`.
12. This audit document (unstaged during implementation; included in final consolidation).

## Manual retest procedure

1. In the separately authorized operational window, restart LivezoneNode to load the new server feed. Do not restart MediaMTX. Reload Control to load the matching browser modules and perform the normal reference handshake. Do not mix an old running server with the new browser bundle.
2. Capture a fresh NetLog **before Control bootstrap**, so source creation/binding ownership is recorded rather than only preexisting REQUEST_ALIVE snapshots. Use the existing approved MEDIA B scenario; no production TAKE was performed as part of implementation.
3. Verify Control has exactly one persistent `reference-presence?...&controlEvents=1` response. It carries presence, program and schedule-state. Control must have no separate persistent program-output/events or studio/schedule/events response. Temporary API/media requests are separate.
4. With MEDIA B progressing in Control, open Public. Verify Public retains its own program-output/events SSE; its MP4 obtains a socket, sends Range headers, receives response bytes and reaches loadedmetadata/playing. Verify no sustained SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP on that request. Correlate source IDs/timestamps with Control/Public exports.
5. Repeat with Preview video active and a normal non-destructive API action. Verify capacity remains and Program/Preview identity/currentTime do not reset. Repeat long audio and configured LIVE, noting which origin serves HLS.
6. Open real OBS with its independent browser source. Confirm server-authoritative Sponsor, Crawl and fullscreen Sponsor parity. Close Control and verify Public/OBS remain operational; scheduled Program execution stays SUSPENDED.
7. Test Control reload/reopen, Public reopen, pagehide/back-forward restore and an SSE interruption. Native reconnect or owner replacement must return to one Control stream, without zombie responses or media reconstruction due to subscription changes.
8. In an authorized server-restart check, verify Program publication recovers, reference state stays UNKNOWN until fresh handshake/reconciliation, and no asset becomes deletable from disconnection alone. Retest Safe Delete using disposable fixtures and the usual approval workflow, never production media deletion for this audit.
9. Recheck AutoLive ENTRY 30 s, persistent loss >15 s, automatic recovery, Technical sharing, TAKE/BREAK and playback continuity in the approved manual scenario. Capture PASS/FAIL separately from automated tests.
10. Record additional dedicated Scheduler/viewer tabs explicitly. An extra Edge viewer shares Edge's pool; OBS's independent process does not. Do not interpret unbounded same-origin tabs as covered by the five-connection fixture.

The previously required LivezoneNode restart and primary manual retest have been completed. The procedure above remains a regression reference, not an instruction to repeat production actions. Final consolidation staging is now authorized and recorded in the [runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md) and exact inventory. Next step: review the final staged checkpoint, then authorize commit separately. Commit and push remain unauthorized.
