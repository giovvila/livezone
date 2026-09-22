# 1003.8A1 Phase 2 — Headless evidence and recovery atomicity

Baseline `3cfe1886486e9a6a00d99e3ea4d98d80c38ebf3c`, continuing the uncommitted
Phase-1 worktree. Isolated models, evidence probing and test repositories only.
No production bootstrap imports, routes, executor, grants, Program commands,
Scheduler activation, live storage access, service restart, commit or push.

## Evidence available and capability gaps

The executable vocabulary is TRANSPORT_PRESENCE, PLAYLIST_PROGRESS,
SEGMENT_PROGRESS, TIMESTAMP_PROGRESS, MEDIA_DECODE_PROGRESS,
ACTIVE_PROGRAM_PROGRESS and LOSS_CONFIRMATION. Capabilities describe actual
observations, not labels such as ONLINE. All results retain executionAllowed=false,
serverTake=false and headlessDecoderEquivalent=false.

| Source/evidence | Proven or observable | Not established |
|---|---|---|
| External HLS | Bounded manifest/variant read, media sequence and segment identity progression, bounded segment reachability; optional declared timestamp progression | Decoding, decoded-frame/audio progress, full segment integrity, true presentation timestamp continuity, decoder-equivalent loss |
| Managed ingest | Existing ManagedIngestHealthProducer maps MediaMTX publisher/tracks to presence/absence, with source mapping checks | Playlist/segment progress and decoding |
| Durable retained LIVE | Accepted Program/source identity, generation and playback anchor through DP1 | Present health, decoder state or inherited healthy-time credit |
| Active browser Program | Existing bound AutoLiveActiveHealth progress/uncertainty/confirmed-loss decisions | Transferable headless decoder ownership |
| Non-LIVE media metadata | Source/asset identity, declared duration/cue; browser can observe actual playback separately | Decoder readiness from metadata, automatic headless ended/seek confirmation |

HeadlessHlsProbe reuses the production AutoLiveHlsObserver and default
AutoLiveSafeHttp. It does not weaken URL/DNS/redirect/SSRF/resource restrictions.
Effective URL rotation and forward discontinuity use the already implemented
progression rules. VOD/ENDLIST, malformed playlists, stalled HTTP-200 media and
timeouts do not become decoder proof. A source/epoch change resets observation;
superseded requests abort and late completions are discarded. No background poller
is installed. Raw endpoints never enter the returned evidence object.

Existing segment reads request Range bytes=0-0 and stop at the first chunk,
retaining only a reachability indication. This cannot inspect MPEG-TS PTS/PCR or
fMP4 sample timing. PROGRAM-DATE-TIME plus EXTINF is playlist-declared timing,
not container timestamp validation. The new TIMESTAMP_PROGRESS capability is
explicitly labeled MANIFEST_DECLARED. No segment/container parser was added:
fetching initialization/encryption/media structures requires a separately bounded
policy, and even valid container timestamps cannot prove successful decoding.
No ffmpeg/ffprobe command was found on this session's PATH; none was installed or
invoked. That PATH observation is not a claim about every executable on the host.

Conclusion: stronger transport/declared-time evidence can be described honestly,
but **headless decoder equivalence was not achieved**. A real bounded decoder or
another independently proven playback-equivalent backend is still required.

## Comparison harness and advisory timing

Evidence requires matching source/fingerprint, authority epoch/process and a
maximum ten-second freshness window. Browser Program observations additionally
bind current Program identity and ownership revision. Expired, future, mismatched
or missing samples are insufficient. Retained LIVE identity alone never qualifies.

| Server / browser observation | Classification |
|---|---|
| ONLINE transport / actual progressing Program | MATCH_HEALTHY (agreement, not equivalence) |
| OFFLINE presence / confirmed browser loss | MATCH_LOSS (agreement, not equivalent loss detectors) |
| Uncertain server / progressing Program | SERVER_WEAKER |
| ONLINE transport / browser CHECKING | BROWSER_WEAKER (less definite observation, not a claim transport is a stronger capability) |
| ONLINE / confirmed failed decoding, or OFFLINE / progressing Program | DISAGREEMENT |
| Both uncertain, browser closed, stale or wrong identity | INSUFFICIENT_EVIDENCE |

Tests compare the real HLS observer with production AutoLiveActiveHealth and
synthetic media progress events, plus the complete false-positive/negative matrix.
Network timeout, corrupt input and undecodable content must remain distinguishable
from decoder-confirmed loss. No actual headless decoding is claimed by the fixtures.

AdvisoryHealthTiming feeds qualified samples to the existing AutoLiveDecisionShadow.
Presence-only managed ONLINE cannot accumulate ENTRY. Proven transport progression
can mature advisory ENTRY but never executable readiness. Identity, owner or epoch
changes reset credit. Browser/real source policy is unchanged: 30-second ENTRY,
15-second confirmed loss; the existing shadow strict >15,000-ms boundary remains
explicit. No timing state is persisted or resurrected after restart.

## Durable transaction schema and state model

The action journal is version 1, explicitly marked NON_EXECUTING_MODEL, at most
32 KiB, with SHA-256 over canonical content. It stores no Program envelope, URLs,
lease secret, auth token or browser import. There is no default live pathname.
Tests exclusively use temporary private paths.

Fields: monotonically increasing journal actionRevision; immutable Phase-1 action
descriptor (action ID/type, originating CAS including epoch/process/ownership and
manual intent, config/source fingerprint, decision evidence digest/summary,
interrupted target/cue/state and return eligibility); reservedAt; transaction state;
commitIntent and returnIntent (expected/target DP1 CAS); observed Program digest
and generation; bounded completion/abort reason. The descriptor's original
actionRevision is a captured fencing-domain value; the journal actionRevision is
the optimistic-write version of this transaction, not a second Program revision.

NONE -> RESERVED -> COMMITTING -> PROGRAM_COMMITTED -> ACTIVE -> RETURN_PENDING
-> COMPLETED. A nonterminal state can become ABORTED or RECOVERY_BLOCKED. The
repository enforces legal edges, immutable action identity/reservation time and
write-once intent/receipt fields. Terminal records cannot progress. An action
without a captured return target cannot prepare RETURN; nothing is manufactured.
This conservative single-transaction journal does not implement journal rotation,
unattended release with no return target, or an executable recovery reader.

Reservation retries with the identical descriptor are observations, not new
reservations; they do not change reservedAt or revision. Stale mutation revisions
fail. Duplicate commit observations cannot apply a second transition. Every
inspection/candidate result has executionAllowed=false, serverTake=false,
replayAllowed=false and returnAllowed=false where applicable.

## Atomic boundary and DP1 integration

1. Explicit ownership fencing precedes reservation; Phase-1 SERVER_CANDIDATE
   remains non-executing. No grant is created by either model.
2. Durable reservation and commit intent bind the exact expected base and exact
   target DP1 digest/generation. Configuration, source, manual intent and ownership
   fields cannot change across that intended Program edge.
3. A future executor would need the shared authoritative mutation queue and DP1's
   final CAS check, after staging and immediately before synchronous replacement.
   The tests drive the real DP1 coordinator directly in isolated storage; the
   transaction model has no Program writer callback and cannot perform this step.
4. Logical Program commitment occurs at DP1 durable commit, before acknowledgement;
   the later action-state marker does not become a competing Program authority.
5. If the caller dies or loses its ACK between DP1 commit and the marker, inspection
   compares the durable intended target with current DP1. A match reports
   PROGRAM_COMMITTED_DO_NOT_REPLAY or RETURN_COMMITTED_DO_NOT_REPLAY. No match,
   uncertainty, unavailable Program or changed authority requires reconciliation.

This is **not a distributed atomic commit across action, Program and ownership**.
The model demonstrates safe reservation/intent ordering, final fence validation and
non-replay classification across the gap. It does not claim exactly-once physical
playout. Automatic recovery would still require separately approved integration of
ownership, the shared mutation queue, durable action provenance and recovery policy.
An observed Program identity is evidence of a commit, never permission to replay.

Newer manual intent dominates even when an earlier automatic commit is observable.
The existing commit may remain historical evidence, but no subsequent automatic
progress/RETURN may overwrite the operator. Old epoch/process or browser reconnect
ownership revision invalidates old assumptions. Restart does not silently rebase
action CAS to the new epoch.

## Storage and crash results

One exclusive wx lock per journal prevents concurrent writers, including separate
OS processes. Abandoned locks are not broken automatically. Canonical loading is
bounded, checksummed and schema-validated; corruption fails closed without rewriting
or selecting backups/temporary files. Public-root paths and existing symlink files
are rejected. The default public-root guard assumes the repository working directory;
any future deployment adapter must provide its trusted static root explicitly.

Writes use a unique same-directory temporary file, bounded full write, flush/close,
final CAS and synchronous rename/canonical flush. A replacement uncertainty blocks
further writes. Graceful close drains/rejects pending work then releases its own
lock. Windows directory ACLs remain a deployment responsibility; no sudden-power-loss
or directory-metadata persistence guarantee is claimed.

Crash coverage includes every requested boundary: before/after reservation, after
final CAS before Program commit, during DP1 staging, after DP1 commit before marker,
after marker, during ACTIVE/loss, before RETURN, after RETURN commit and before
completion. Inspections are repeatable and never execute. Real child processes exit
at journal staging/replacement and after TAKE/RETURN DP1 commits before markers.
The abandoned isolated lock stays fail-closed; tests remove it only after verifying
that their child exited, simulating an explicit operator step. Live authority files
are never used. Two-process writer contention, checksum/schema/size corruption,
storage failures, duplicate/lost ACK, config/source/manual/epoch/ownership/generation
races and return invalidation are also exercised.

## Phase-2 file scope

- server/autolive/HeadlessHealthEvidence.js
- server/autolive/ActionTransactionModel.js
- server/autolive/ActionTransactionRepository.js
- test-support/Phase2ActionFixture.js
- test/headless-health-equivalence.test.js
- test/action-recovery-atomicity.test.js
- docs/BUILD-1003.8A1-PHASE2-HEALTH-RECOVERY.md

All are new Phase-2 files. Uncommitted Phase-1 files are retained unchanged. Existing
runtime modules and live state are unchanged. No static/public diagnostic surface or
API was introduced.

Validation on Windows / Node v24.15.0:

| Run | Tests | Pass | Fail | Cancelled | Skipped | Duration ms |
|---|---:|---:|---:|---:|---:|---:|
| New Phase-2 suites | 67 | 67 | 0 | 0 | 0 | 2462.3756 |
| Focused 60-file matrix, including Phase 1 | 1432 | 1432 | 0 | 0 | 0 | 88290.4848 |
| Full regression | 2006 | 2006 | 0 | 0 | 0 | 125381.0582 |

Full command: `node --test --test-timeout=60000 --test-concurrency=2`, exit 0.
Syntax checks: 6/6 new JavaScript files passed. Test logs are in the OS temporary
directory as `livezone-phase2-new.log`, `livezone-phase2-focused.log` and
`livezone-phase2-full.log`, not production runtime storage. Final whitespace/diff
verification is performed after this documentation update.

## Recommendation

Stop advancement toward SERVER_OWNER until a real bounded headless decoder or
other independently proven playback-equivalent capability is selected and validated.
Additional contract review is possible, but transport health is not an acceptable
substitute. The action model supplies non-executing durability/race evidence, not
permission for an executor. SERVER_OWNER remains impossible, serverTake=false,
no server ENTRY/TAKE/RETURN or Control-closed Program execution, and Scheduler
Program execution remains suspended.
