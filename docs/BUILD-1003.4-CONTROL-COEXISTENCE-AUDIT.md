# Control coexistence audit — 1003.4

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

2026-09-14, branch `build/1003.4`.

CONTROL_COMMON_FACTOR = yes (operator evidence).
FIRST_DIVERGING_SUBSYSTEM = UNCONFIRMED.
Decision: BUILD_1003_4_PUBLIC_VIEWER_INTERMITTENT_STARTUP_BLOCKED.

Public + OBS succeeds; either opening order of Control + Public fails. This
supersedes treating the Public-only startup defects as an explanation of the
reported incident. No evidence attributes this incident to Sponsor or Crawl.

## Evidence limits

Browser discovery returned no attached browsers. Consequently no operator-tab
decoder, request-queue, CPU, visibility or BroadcastChannel measurements were
available. Counts below are source-derived allocations, not measured active
hardware decoders. No production Program/Preview selection, TAKE, event creation,
DELETE, data change or service restart was performed. The previous Public
startup fixes and Fullscreen Sponsor changes remain unstaged and unaltered by
this investigation. This turn adds a test and this audit only.

## First priority: Control's persistent HTTP connections

In network mode, after successful initialization:

| Owner | Persistent SSE |
| --- | ---: |
| Control reference-client presence | 1 |
| Control ScheduleApiClient (shared schedule store) | 1 |
| Control Program Output publisher recovery monitor | 1 |
| Control effective-overlay observer | 1 |
| Public | 1 |
| OBS standalone page | 1 |

Thus Public + OBS uses 2 streams; Control + Public or Control + OBS uses 5;
all three use 6. Control also opens a temporary retained-read stream during
bootstrap, closed on receipt or after two seconds; it precedes the two steady
Program Output streams and must not be blindly added to the steady total.
An additional Scheduler workspace tab has its own connections.

Source: `entries/control-room-app.js`, `studio/ReferenceClient.js`,
`scheduler/ScheduleApiClient.js`, `program-output/ControlCrawlObserver.js`,
`program-output/NetworkProgramOutputTransport.js`.

The application server uses `node:http.createServer`. Browser-facing HTTP/2
through a reverse proxy has not been established. MDN documents the six
browser/domain connection limitation for SSE without HTTP/2:
https://developer.mozilla.org/en-US/docs/Web/API/EventSource

**Hypothesis, not incident proof:** Control leaves much less HTTP/1 connection
capacity for module/config downloads, same-origin media ranges, health polls,
and ownership writes. With five persistent streams plus a held media request,
a new request may queue before Public reaches bootstrap or retained state.
Actual host/port, browser profile, negotiated protocol and media request duration
must be captured. HLS on a different origin need not share the same pool.
This also means AUDIO can exercise connection pressure without video decoding.

Candidate classification: OTHER — HTTP connection pressure, involving
PROGRAM_OUTPUT_PUBLISHER and ASSET_AUTHORITY connections. It is not yet the
confirmed first divergence. Do not remove presence or recovery authority to
reduce the count without preserving their semantics.

## Media consumer inventory

| Control owner | Allocation and lifetime |
| --- | --- |
| Program | One current source surface |
| Preview | One separate current source surface |
| Technical Monitor | One selected HLS surface; none when deselected |
| AutoLive health | Managed ingest: API polling, no player. External source: reuses matching Technical observations or owns one fallback HLS surface |
| Prepared Program | May add one source surface; Preview handoff can reuse the existing one |
| Prepared Preview | No separate permanent candidate slot; Preview source preparation occurs in its current slot |
| Transition outgoing Program | Retained during transition, released on completion/cancellation |
| AUDIO artwork | One additional video per AUDIO surface with motionUrl; still artwork has no video |
| Recovery | Surface-specific recovery/replacement, not a permanent extra independent Program player |
| Media Library duration probes | Detached metadata-only audio/video, sequential during initialization for unknown durations, 12-second timeout and source cleanup |
| Legacy PlaybackRuntime Player | Disabled: Control calls startPlayer:false |

At stable state, with BOTH Control buses of the indicated kind, no preparation
or transition, and Technical/AutoLive disabled:

| Kind | Control video / audio / HLS.js | Public + OBS video / audio / HLS.js | Control + Public video / audio / HLS.js |
| --- | --- | --- | --- |
| BREAK | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| VIDEO | 2 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 |
| AUDIO, no motion | 0 / 2 / 0 | 0 / 2 / 0 | 0 / 3 / 0 |
| LIVE | 2 / 0 / 2 | 2 / 0 / 2 | 3 / 0 / 3 |

LIVE HLS.js counts assume the hls.js path; native HLS has the same video elements
but no HLS.js instances. Add one video/HLS for Technical, and one for an external
AutoLive fallback only when it cannot share Technical. Add transient candidate
and outgoing surfaces as applicable. These are element/surface counts, not a
promise that a paused/prepared video owns a hardware decoder. Actual selected
Program and Preview can differ and must be counted separately.

Technical Monitor has no visibility suspension. Selection is restored and remains
owned while the Control tab is hidden; browser throttling may independently alter
playback. `SharedLiveHealthConsumer` can use its progress for external AutoLive
health. Suspending it on visibility alone can therefore change health decisions.
No suspension was implemented; causality and a safe authority handoff are unproven.

## Visibility and authority traffic

The explicit Control `visibilitychange` callback records trace snapshots only:
zero explicit renderer rebuilds, play/pause calls, publications, ownership writes,
catalog reconciliation, HLS destroy/create or BroadcastChannel sends in that
handler. This is a source finding, not a measurement of browser-induced media
events. `ProgramOutputManager` ignores an incidental hidden pause of the same
playing source. Focus can refresh Media Library once; backgrounding does not
stop ongoing health checks or ownership reporting.

Expected settled, static traffic is independent of output subscriber count:

| Traffic | Source-derived trigger/rate |
| --- | --- |
| Capability registration | At initialization/resume; no client interval heartbeat |
| Presence keepalive | Server SSE comment every 15 seconds, not an authority mutation |
| Preview ownership | Initial report, changes, then 8 seconds after each completed periodic report |
| Catalog reconciliation | Initialization or operator catalog changes |
| Alias acknowledgement | Adoption/application changes; no periodic timer |
| Logo authority | Initialization and explicit assignment/application, no periodic timer |
| Library invalidation | Each relevant authority mutation response, presence event/error, focus |
| Library BroadcastChannel | One `changed` notification per invalidation; receiving it refreshes, does not rebroadcast |
| AutoLive managed health | Selected-source polling, nominal 1 second after completion; bounded request timeout |

`operatorFetch` notifies after authority writes, including failed writes.
`MediaLibraryUI.refreshAuthority` coalesces overlapping refreshes. GET refreshes
do not trigger another authority mutation notification. Public and OBS do not
instantiate the Media Library channel in network mode. No feedback loop from
merely opening either output was found on this path. Counts in foreground versus
background still need browser capture; timer throttling and failures matter.

Control also owns UI timers (shared schedule clock, remaining-time updates and
optional debug/overlay UI), plus conditional media watchdogs. An exact active
timer total cannot be inferred from a source-wide count of timer calls. Public
and OBS have conditional bootstrap, playback/readiness, recovery and overlay
timers. No measured total is claimed for any combination.

## Isolated production-path experiment

Added to `test/public-startup-reconnect.test.js`: actual ephemeral application
HTTP/SSE server, production publisher recovery transport, Control overlay
observer, Public controller and OBS subscriber transport. Static retained BREAK;
three real 10-second windows:

| Phase | Additional publisher sends | Additional overlay updates |
| --- | ---: | ---: |
| Control output transports | 0 | 0 |
| Add Public | 0 | 0 |
| Add OBS subscriber transport | 0 | 0 |

One initial publication; retained base revision stays 2. Four output SSE streams
at the end. Test passed. Log: `var/control-coexistence-network.log`.
The complete startup/reconnect test file passes 21/21, including the new test;
log: `var/control-coexistence-startup.log`. No production code changed in this
audit, so the previously reported full-suite count was not re-claimed as a new
run. Scoped whitespace verification passed.

Scope: publication ingress is replaced by the real store boundary to avoid
registering an operator writer; this does not exercise auth or Preview/catalog
clients. It does not launch the entire Control page, exercise browser HTTP pool
limits, or prove decoder capacity. The OBS leg here tests its transport, not
browser rendering. Existing Public/OBS retained-kind tests cover rendering with
simulated media readiness. No fixture result is presented as an operator-browser
coexistence measurement.

## Required next capture

For the same browser/profile and origin, record a network waterfall and runtime
trace for Public + OBS, Control alone, Control + Public in both opening orders,
and Control + OBS. Record 10 seconds per stable phase. Identify the first request
or event that stops advancing: GET /, module, config, SSE open, retained envelope,
accepted revision, readiness, first frame. Pending-before-request differs from
connected-SSE-with-no-envelope and from decoded-frame starvation.

Repeat with operator-prepared BREAK/BREAK and idle Technical, then AUDIO without
motion, then VIDEO/LIVE. Do not issue TAKE or alter production buses solely to
collect these measurements. Count source/consumer identities, HLS instances,
requests by origin/protocol, EventSources, timers, publisher sends, revisions,
authority writes and BroadcastChannel notifications. Retain visibility edges.

If requests queue while the main thread and media are healthy, investigate
connection sharing with authority/reconnect semantics preserved. If BREAK also
stalls with available connection capacity, capture the event/long-task cascade.
If only video workloads fail, inspect decoder/player allocation and release.
No subsystem is declared causal until this first divergence is observed.

Staging remains the provisional 117-file checkpoint; no stage, unstage, commit
or push. Manual browser reproduction remains blocked by the absent browser
connection; the coexistence problem is not declared fixed.
The final SHA-256 of `git ls-files --stage -z` matches the prior checkpoint:
`6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a`.
