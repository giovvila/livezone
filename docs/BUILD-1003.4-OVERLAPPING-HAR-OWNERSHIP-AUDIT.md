# MEDIA B overlapping HAR and health-demand audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Decision: BLOCKED for causal playback fix. All four supplied files in
`var/diagnostics` were parsed in full; conclusions below derive from their data,
not the preceding operator summary. Times are UTC on 2026-09-14.

## Overlap and first divergence

Control HAR: 88 entries, comprising 87 external Wowza playlist requests returning
404 and one successful local Media Library API request. No demo2.mp4 request is
included: the original Control request/cache transaction is not captured.
Playlist starts span 21:46:01.138–21:53:19.233. Intervals are 5083–5241 ms,
mean 5094.128 ms. Responses complete promptly; this is churn, not evidence of
many simultaneously pending Wowza requests.

Public HAR: five GET /media/demo2.mp4 requests, each Range bytes=0-, status 0,
empty serverIPAddress and response headers, send/wait/receive 0, and all elapsed
time classified as blocked. All terminate with net::ERR_ABORTED.

| Public request start | Duration ms | Technical HAR requests inside window |
| --- | ---: | ---: |
| 21:47:40.264 | 12008.218 | 2 |
| 21:47:53.278 | 12013.575 | 3 |
| 21:48:06.294 | 12759.133 | 3 |
| 21:54:25.856 | 11999.882 | outside Control HAR window |
| 21:54:38.871 | 12014.766 | outside Control HAR window |

All five HAR starts match Public loadstart timestamps. Each request end matches
surface-failed within approximately one millisecond. Stalled offsets are
3278,3256,3273,3270,3258 ms. The observed abort is therefore consistent with
surface timeout/cleanup, not an HTTP error returned by LivezoneNode.

Public runtime spans 21:47:01.180–21:56:23.056 with 292 entries: one bootstrap,
SSE open and accepted snapshot; 36 surface/loadstart attempts, 35 stalled,
35 surface-failed events. No metadata/data/canplay or seek event occurs.
The first divergence is browser-side request progress before metadata and
before an observable HTTP response/send phase. HAR cannot identify the exact
internal wait reason or independently prove that no socket bytes existed.

The last two Public HAR requests overlap Control's retained resource events
(21:53:59.496–21:57:22.830). Technical creations are at 21:54:30.481/.35.572
for the first window, and 21:54:40.669/.45.759/.50.853 for the second.
Program surface 1 has 12 timeupdate samples in each window, all readyState 4;
its time advances 3981.968836–3993.676539 and 3994.753665–4006.470850 seconds.
Thus actual overlapping data confirms Program continuity while Public is blocked.

Control's final inventory is 239 video creations / 238 releases, one active
Program video, zero active HLS and zero cleanup pending. Program time is
4158.960795, duration 6914.139955, buffered [2958.204,4193.340], seekable full.
Do not interpret the 239 cumulative creations as 239 active native players.
The runtime ring is limited to 1000 entries and resource events to 512; this
is the full exported data, not the entire lifetime history.

## Demand ownership, acquisition and release

1. Control constructs Technical LiveSourceMonitor with maximum delay 30000 ms.
2. Control constructs dominantHealthMonitor (SourcePresenceMonitor), passing
   shareTechnicalLiveHealth(Technical, fallback consumer factory).
3. AutoLiveEntryController inherits DominantLiveController configuration handling.
   A resolved authorized source fingerprint selects the presence monitor.
4. SourcePresenceMonitor classifies the endpoint as external, then startExternal
   calls factory.retainSource -> Technical.retainHealthDemand for [id,url].
5. Its separate external LiveSourceMonitor subscribes to shared observations.
   Destroying one failed shared consumer only removes that subscription; it does
   not release the source-lifetime demand. There is no second media allocation
   while Technical's source matches.
6. SourcePresenceMonitor.stop releases the demand and destroys/unsubscribes the
   external observer. selectSource first calls stop. Source invalidation/removal
   or controller destruction reaches this path. Releases are idempotent.

CLOSED means no AutoLive session; it does not mean disarmed or no recovery duty.
The controller must see ONLINE before it can begin ENTRY when armed. Monitoring
is currently keyed to authorized source identity, not session phase, scheduler
enabled state or armed state. Closing a session therefore does not release it;
even disarming alone does not change that source fingerprint.

The new capture explicitly verifies the loaded decision: 31 Technical retry
records show delay 5000, maximum 30000, failure count 8, demand count 1,
reason health-demand. The 31 paired external observer records show maximum
5000, demand count 0, reason passive. They are two logical monitors sharing
one physical Technical surface, not a duplicate native-player leak.

No stale lease accumulation is demonstrated. The demand has a valid source
owner and intentionally spans consumer failures. Whether unnecessary monitoring
while disarmed should be reduced is a separate policy issue; CLOSED alone does
not authorize removing recovery observation in this capture.

## Causality and Chromium investigation

The files establish temporal coexistence of native Technical churn and Public
blocking, not that one causes the other. Wowza and localhost are different
origins, and the Wowza requests complete rapidly; these files do not show a
same-origin socket pool filled by those requests. Native/browser memory and
player-internal queues are not measured by the exported JS inventory.

An alternative worth distinguishing is the HTTP cache transaction for the same
large MP4. Chromium's current source explicitly handles concurrent media range
requests waiting on a cache entry, including a conditional short bypass. This
is a supported hypothesis, not evidence that the capturing browser took that
branch. Its actual version is absent from these HARs.
Source: https://raw.githubusercontent.com/chromium/chromium/main/net/http/http_cache_transaction.cc
(DoAddToEntry / DoAddToEntryComplete).

A NetLog covering Control's original MP4 opening through the Public failure is
needed to distinguish cache-entry wait, connection-pool wait, and other request
scheduling. Inspect HTTP_CACHE_ADD_TO_ENTRY and related cache events, request
dependencies and socket activity. Pair it with browser Media panel diagnostics
for actual player creation/destruction and the exact browser version. Do not
extend Public timeouts or change seek/preload as a diagnostic substitute.

## Fix decision and regression limits

No production behavior fix is retained. A fetch-based manifest gate cannot be
assumed equivalent to the native video request: native StudioHlsSurface sets no
crossOrigin, whereas fetch requires CORS to read status. Credential omission
can turn an authenticated source into a false negative; credentialed fetch can
be rejected by the captured wildcard Access-Control-Allow-Origin. Opaque results
cannot establish absence. A safe fallback preserves native retries, so it does
not guarantee eliminating this churn. A source-health endpoint with equivalent
authorization or an independently validated probe contract would be required.

Three production-controller/monitor fixture tests were added: repeated stop/start
does not accumulate leases/listeners; source replacement releases old identity;
and CLOSED AutoLive demonstrably retains one lease until source removal/destroy.
The latter is explicitly characterization, not a test claiming the desired
allocation fix. It reproduces 121 immediate-failure attempts in ten simulated
minutes, peak one consumer. Total allocations remain unbounded over time under
health demand. The requested bounded-allocation acceptance criterion remains
UNMET; existing recovery/ENTRY/loss behavior is preserved, not weakened to pass it.

No Public/OBS playback, Program/Preview, Sponsor/Crawl, safe-delete authority,
environment, schedule, media data or service was changed. No staging or publishing.

Validation: focused 133/133 PASS; full node --test 1448/1448 PASS; syntax PASS;
git diff --check PASS. Staging remains 117 files, raw staged-entry SHA-256
6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a unchanged.
