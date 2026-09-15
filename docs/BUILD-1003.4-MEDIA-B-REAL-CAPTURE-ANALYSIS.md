# MEDIA B: real Control/Public capture analysis

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Primary evidence: `var/diagnostics/MEDIA-B-CONTROL-KO.txt` and
`var/diagnostics/MEDIA-B-PUBLIC-KO.txt`, parsed in full. Times below are UTC,
2026-09-14. No simulated event is used as evidence of the operator failure.

## Critical correlation limit

Control resource events span 21:13:52.238–21:17:09.539, with inventory at
21:17:10.031. Its runtime ring retains 1,000 events, sequences 280–1279,
21:14:28.224–21:17:06.382: the early runtime history was evicted.
Public records 61 events from 21:18:10.550–21:19:37.321, exported at
21:19:42.192. Public begins 60.519 seconds AFTER the Control inventory.
There is no overlapping observation window. These files cannot establish that
Control remained healthy, or correlate Technical allocations with individual
Public stalls, during the Public recording.

## Control's actual media lifecycle

Program surface 1 is created at 21:13:52.239. Loadstart is at .340,
loadedmetadata at .521 (181 ms later), seeking at .521 to 1549.452390 s,
seeked at .545, loadeddata/canplay at .547, playing at .548.
The same Program surface progresses to 1746.915079 s at export; readyState 4,
networkState 1, playing, preload metadata. Duration 6914.139955 s,
seekable [0,6914.139955], buffered [1564.735,1788.037].
One video remains active, no active HLS instance and no cleanup pending.
The inventory records 204 Resource Timing entries, 42 classified as media;
these are counts, not HTTP lifecycle records.

All 39 other created videos are Technical surfaces; all 39 are released.
The 38 creation intervals range 5091–5236 ms, mean 5105.474 ms
(approximately 11.75 new surfaces/minute). Create-to-error takes 87–232 ms,
mean 97.821 ms; create-to-release mean 98.487 ms. No accumulation of live
elements is demonstrated, but real repeated native media allocation is.

The retained runtime ring contains 62 attempt-start records in 31 paired
generations and 63 retry-scheduled records, ALL with delay 5000 ms.
These paired monitor records must not be counted as two physical players:
the physical resource inventory and technical consumer instance IDs show one
Technical allocation per cycle. Events include external-hls-observation and
technical-health-reused, together with AutoLive phase CLOSED/sessionActive false.

## Why the passive backoff does not reduce this observed cadence

Current Control constructs Technical with maxRetryDelayMs 30000.
SourcePresenceMonitor.startExternal acquires a source-health demand lease through
shareTechnicalLiveHealth.retainSource -> retainHealthDemand. That lease lasts
for external monitoring, not merely an active AutoLive session or consumer attempt.
LiveSourceMonitor.retryDelay returns 5000 whenever the same source has a lease.
The external observer also uses a separate LiveSourceMonitor with default 5000 ms
cadence, explaining the paired attempt records while reusing one physical player.

Thus a CLOSED AutoLive session does not imply passive monitoring in this code.
The observed reuse path is consistent with the protected five-second branch,
not the passive 5/5/10/20/30 branch. The original trace lacks lease counts and
loaded module identity; it cannot independently prove which code revision was
loaded in the capturing tab. New retry diagnostics expose delay, configured cap,
failure count, demand count and reason. No lease or retry policy was changed.

## Public's first divergence

Bootstrap starts 21:18:10.550, completes .577, SSE opens .586, revision arrives
.587 and snapshot is accepted .588. The source is MEDIA B, revision 2.
The element is created and src assigned at .589, preload auto.
Loadstart occurs .591 with currentTime 0, readyState 0, networkState 2,
paused true and muted true. Stalled occurs 21:18:13.823, 3232 ms later.
Surface-failed follows at 21:18:23.043, 12452 ms after loadstart.

Seven attempts (generations 2,4,6,8,10,12,14) all reach loadstart/stalled.
Stalled delays: 3232,3233,3248,3259,3232,3258,3262 ms.
Six attempts reach surface-failed; the seventh is still outstanding in the file.
Failure delays from loadstart: 12452,13000,12589,11999,12387,12009 ms.
No loadedmetadata, loadeddata, canplay, seek-target, seek-request or player-error
event appears. ExpectedTime values are projections in diagnostic fields, not
proof that currentTime was assigned. This failure precedes the projected seek.

## What the files cannot establish

Neither file contains requested byte ranges, response headers/status, pending or
canceled requests, transferred bytes, connection occupancy, Chromium native
memory, or a concurrent Public+OBS comparison. NetworkState 2/stalled alone does
not distinguish browser scheduling, cache, transport, server or MP4 demuxing.
No causal claim about preload auto, GPU saturation or Technical churn is proven.

Static server inspection shows an independent createReadStream for each ranged
request, 206 Content-Range/Content-Length, and 200 for a non-range request.
There is no explicit same-file serialization. The route does not explicitly
destroy the file stream on response close; this warrants aborted-request
observation, but does not prove that canceled streams caused this failure.
No server behavior was changed and no service was restarted.

## Minimal added diagnostics and next capture

Existing runtime JSON export now includes up to 128 same-origin /media/ Resource
Timing entries: timing phases, response status where available, sizes and
protocol. Query strings, credentials, unrelated requests and raw error messages
are omitted. Reading occurs only on export; no observer, timer, fetch or buffer
configuration is added. Public media event traces include numeric MediaError code.
Retry logs include the decision fields listed above. Playback ordering is unchanged.

Resource Timing does NOT enumerate pending requests or expose Range headers;
missing entries cannot prove no request was issued. Capture a DevTools Network
HAR for each tab, with recording started before Public opens, preserving the
existing cache setting. Export BOTH runtime JSONs after the same observed KO.
Compare demo2.mp4 request Range/Content-Range, status, queue/stall time, request
start, first byte, sizes and cancellation. Sanitize HAR credentials before sharing.
This distinguishes request not dispatched, dispatched without response, and
bytes delivered without metadata. No TAKE, media deletion or state mutation is needed.

Root cause remains unproven. First observed failure boundary is firmly
loadstart -> metadata, not projected seek. Existing playback/AutoLive policy,
Program/Preview, Public/OBS behavior, overlays and Safe Delete remain unchanged.

Validation: 24/24 focused tests PASS; syntax checks PASS; git diff --check PASS.
First full run had a file-level failure in media-library.test.js without a named
assertion failure; isolated rerun passed 27/27. Complete rerun passed 1445/1445.
Staged checkpoint remains 117 files; staged-entry SHA-256 unchanged:
6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a.
No stage/unstage, commit, push, environment change or service restart.
