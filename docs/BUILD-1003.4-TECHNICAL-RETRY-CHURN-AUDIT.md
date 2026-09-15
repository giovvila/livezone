# Technical Monitor retry churn — 1003.4

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

2026-09-14, branch `build/1003.4`.

Decision: retry fix ready for manual retest; exact chronological capture analysis
remains incomplete because the three raw JSON exports were not attached or
located. The user was asked for their paths. No synthetic timeline is presented
as an operator capture.

## Real evidence supplied in the message

| Metric | SMALL VIDEO | LARGE VIDEO | LONG AUDIO |
| --- | ---: | ---: | --- |
| created.video | 9 | 44 | Not supplied |
| released.video | 8 | 43 | Not supplied |
| Active video | 1 | 1 | Not supplied |
| cleanupPending | 0 | 0 | Not supplied |
| JS heap | approximately 9.4 MB | approximately 10.5 MB | Not supplied |
| Resource Timing entries | 187 | 250 | Not supplied |
| Media resource entries | 13 | 36 | Not supplied |
| Control + Public | Operator PASS | Operator FAIL | Operator FAIL |

The LARGE Program is `media-demo-2`, readyState 4, networkState 1, active playback,
duration 6914.139955 seconds, approximately 0–111 seconds initially buffered and
the full duration seekable. This is an active, ready Program snapshot, not a
Program element that failed to initialize. The approximately 1.1 MB JS heap
difference does not measure decoder, native media or network/cache memory.

The supplied LARGE description explicitly reports repeated Technical cycles for
`live-178c0f16-a202-4917-baa4-8d45367f98a3`:

created -> play-request -> play -> waiting/loadstart -> error -> readiness-failed
-> released -> retry, approximately every five seconds.

Created/released totals track closely; the evidence does not support simple
accumulation of live DOM media elements. It does support repeated allocation
and teardown of Technical media pipelines in that capture. The 35 additional
video creations/releases and 23 additional media resource entries between
summaries are historical-count differences, not simultaneous resources or exact
Technical cycle counts. Capture durations, resets and individual events are
missing. SMALL may also contain Technical retries; that cannot be excluded from
its nine creations. No LONG AUDIO Technical event sequence was actually supplied.

FIRST_DIVERGENCE: the exact first difference from SMALL cannot be established
without the timestamped exports. The meaningful supplied LARGE observation is
repeated failed Technical allocation while Program is already healthy.
TECHNICAL_RETRY_RATE: approximately 5 seconds per reported cycle, roughly 12
cycles/minute for immediate failures. Exact count, median/min/max interval and
per-capture rate remain unavailable. Counters must not be divided without an
observed time window. The bounded event ring can also truncate early cycles.

## Mechanism verified in production code

TechnicalLiveMonitorUI restores the selected enabled HLS source independently of
Program kind. Its LiveSourceMonitor uses a real LiveHlsHealthConsumer, which
constructs StudioHlsSurface and a video element on every attempt. It may also
construct an HLS.js instance; native HLS still allocates a media element/pipeline.
Failure releases the consumer and schedules another attempt. Before this fix,
recoverable failures always waited five seconds, with no failure-history backoff.
Thus release correctness does not eliminate media/network allocation churn.

This can plausibly contribute to heavy local MP4/MP3 pressure. It is not proof
that churn alone causes the observed second-tab or Preview failures. Confidence
is high for the retry mechanism, moderate for a contributing-pressure hypothesis,
and insufficient to declare the full operator failure resolved. Browser-native
memory, decoder initialization and request scheduling were not measured here.

An enabled selected source that repeatedly fails can keep retrying even when it
currently provides no useful video. Automatic recovery is intentional; dropping
all retries would break it. An HTTP HEAD, status 200 or manifest response alone
cannot replace the current decoded/advancing playback health contract for an
external LIVE source. No cheap HTTP-only health replacement was introduced.

## Small resource fix

The Control Technical monitor opts into capped backoff through
`maxRetryDelayMs: TECHNICAL_RETRY_MAX_DELAY_MS` (30,000 ms).

- First two failed passive attempts retain five-second retries.
- Subsequent failed passive attempts wait 10, 20, then at most 30 seconds.
- A real ONLINE observation or explicit source selection resets failure history.
- Source replacement/stop still cancels pending retries and rejects stale events.
- Readiness timeout stays 12 seconds; uncertainty recovery stays unchanged.
- Resources are destroyed before the retry delay; only one attempt owns a player.
- No Program/Preview, Public/OBS, media URL, preload, Range, Sponsor or Crawl change.

Only the Control Technical monitor opts in. Other LiveSourceMonitor users retain
the default fixed five-second retry cadence.

### AutoLive health demand

SourcePresenceMonitor now retains a source-specific health demand while its
external health monitor exists. SharedLiveHealthConsumer forwards this demand
to the Technical monitor. The demand survives failed consumer attempts and the
gaps between retries, and is released on source-monitor stop/replacement.

When the exact source ID and endpoint match a retained demand, Technical keeps
the original five-second cadence. Newly acquired demand expedites an existing
long backoff to the original deadline (immediately if that deadline has passed).
Multiple demands are reference counted; unrelated sources do not disable backoff.
Managed ingest remains server-polled. The shared/fallback player selection and
decoded-progress health criteria are unchanged.

This preserves AutoLive's observation cadence rather than merely leaving its
numeric thresholds unchanged. ENTRY remains 30 seconds; existing persistent-loss
and recovery policies are untouched. No new play command or monitor selection is
issued against Program or Preview. Active AutoLive health may therefore still
produce five-second failed probes: that is an explicit protection, not an
unreported exception to the passive allocation bound.

Tradeoff: a passive, repeatedly unavailable Technical source may wait up to
30 seconds before the next attempt once it recovers, plus the existing readiness
work. It is never declared ONLINE by the delay or by an HTTP-only probe. AutoLive
dependent sources keep their original cadence.

## Tests and resource bound

Ten-minute deterministic immediate-failure run:

| Mode | Created attempts, including initial | Peak active | Active after failure |
| --- | ---: | ---: | ---: |
| Previous/default five-second retry | 121 | 1 | 0 |
| Passive Technical capped backoff | 23 | 1 | 0 |
| AutoLive-demanded Technical | 121 | 1 | 0 |

Passive attempt starts are 0, 5, 10, 20, 40, 70, 100… seconds. In steady
failure, starts are at most once every 30 seconds (about two/minute), plus the
finite fast startup sequence. Actual attempt duration can lengthen intervals.
This bounds allocation rate, not browser-native bytes or decoder residency.

Ten new tests cover cadence, one-consumer ownership, automatic healthy recovery
and reset, unchanged default cadence, source-specific/ref-counted demands,
expedited demand, stale callbacks/source replacement, SourcePresenceMonitor's
shared-demand lifetime, and unchanged heavy VIDEO/AUDIO Program plus independent
Preview identity/play calls during retries. The existing real-surface Technical
no-signal simulation now uses the production backoff option and verifies HLS
release before retry. Full existing ENTRY/loss/recovery and output regressions
remain required.

Tests use deterministic media/consumer events and jsdom where applicable. They
do not reproduce browser-native resource pressure or prove that the operator
multi-tab failure is fixed.

FOCUSED_TEST_RESULT: 117/117 PASS (`var/technical-retry-focused.log`).
FULL_TEST_RESULT: 1431/1431 PASS, zero failures/skips (`var/technical-retry-full.log`).
SYNTAX_RESULT: six changed/new JavaScript files PASS.
DIFF_CHECK_RESULT: PASS (`var/technical-retry-diff.log`, empty).
STAGING_STATUS: 117 files; unchanged SHA-256 of `git ls-files --stage -z`:
`6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a`.

## Manual retest and remaining evidence

No service restart, browser reload, TAKE, state mutation, stage/unstage, commit or
push was performed. The updated client is available on the next normal Control
load. Keep the selected Technical source and AutoLive configuration recorded.

Repeat SMALL, MEDIA B and audio-12 with Preview BREAK, then small Preview VIDEO
and Public. Export Control inventory/events. For passive repeated failures,
verify 5/5/10/20/30-second retry spacing, zero resources during backoff, one
Technical consumer during an attempt and automatic recovery. If AutoLive depends
on that source, expect the protected five-second cadence and verify ENTRY/loss/
recovery as before. Compare outcome and native-resource/network evidence; do not
claim a cause from lower JS heap alone.

BLOCKERS: raw SMALL/LARGE/LONG AUDIO exports and timestamped reproduction are
missing; exact cycle counts and first cross-capture divergence remain unresolved.
NEXT_STEP: MANUAL RETEST TECHNICAL BACKOFF + HEAVY VIDEO/AUDIO + PREVIEW/PUBLIC;
provide the three raw exports for exact chronological analysis.
