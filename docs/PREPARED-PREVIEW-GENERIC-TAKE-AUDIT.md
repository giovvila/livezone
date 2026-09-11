# Prepared Preview generic TAKE / dual-heavy-media audit

DECISION: PREPARED_PREVIEW_GENERIC_TAKE_READY_FOR_MANUAL_RETEST

REAL_RUNTIME_EVIDENCE: User reports reliable TAKE with BREAK on one side and less reliable TAKE with heavy media on both sides, especially AUDIO + large motion. No browser is connected (browser discovery returned []). The actual failing native consumer and GPU/decoder pressure therefore remain unmeasured. This fix addresses reproduced readiness/lifecycle defects and reduces optional candidate loading; it does not claim to prove or solve every dual-VIDEO resource failure.

COMMON_PREVIEW_TAKE_PATH: Normal TAKE snapshots the primary Preview cue, creates a separate Program surface, waits for required readiness under the existing 12-second limit, then commits and swaps the outgoing Program into Preview. VIDEO, AUDIO, AUDIO+STILL, AUDIO+MOTION, IMAGE and normal LIVE use this preparation path. BREAK uses a slate: no VIDEO/AUDIO decoder or media Range request. AutoLive's separate accepted pre-roll/handoff path is untouched.

AUDIO_PRIMARY_READINESS: Primary AUDIO metadata, playable readiness and completed initial cue are required. Optional artwork is not. A repeated readiness/transport notification cannot reissue a seek already in flight. Missing primary audio still times out at 12 seconds; Program remains unchanged, busy clears and another TAKE can succeed.

MOTION_READINESS: The prior readiness barrier did not directly require motionReady. This hypothesis is refuted by the code. Motion nevertheless previously loaded a second large video eagerly during candidate preparation. Repeated audio/visual events could also call play() repeatedly while an earlier motion play promise was pending.

MOTION_OPTIONALITY: Motion remains optional. A normal Program candidate defers assigning its motion URL/loading until activation. Preview motion remains enabled. At activation, motion loads independently; a decoded frame can be displayed without making primary acquisition await the motion play promise. One pending motion play is shared; failures, replacement and late callbacks cannot leak a rejection or revive retired resources.

AUDIO_MOTION_LIFECYCLE: Before TAKE, Preview owns its primary AUDIO and its optional motion VIDEO. Candidate preparation creates another AUDIO and, where configured, a VIDEO element for motion. The candidate VIDEO is allocated but has no URL/load during preparation. Primary AUDIO is muted with autoplay disabled during preparation; activation starts its normal playback and enables its audio, then loads the optional motion. The Preview-to-outgoing-Program swap keeps ownership independent. No new motion seek is required to match the primary audio cue.

SECOND_CONSUMER_FINDING: Duplicate elements/transports are real. They are not proof of three hardware decoders: browser caching, software/hardware decode allocation and resource contention were not observed. Deferring optional motion removes one loaded VIDEO from the pre-commit workload in the VIDEO → AUDIO+MOTION case. VIDEO → VIDEO still creates a separate required candidate.

FIRST_BLOCKING_COMPONENT: Reproduced before the change: primary AUDIO metadata/readiness/cue are ready, optional still is pending, and markReady remains pending solely because imageReady was required. The failing reproduction is saved in var/generic-take-before.log. Motion need not be the blocking component even when the source is labeled AUDIO+MOTION. An independent repeated-seek path was also corrected and covered. These are demonstrated code paths, not identification of the exact component in the user's unconnected real session.

ROOT_CAUSE: Optional still artwork was treated as a required acquisition dependency. Eager duplicate motion loading added avoidable pre-commit work. Repeated in-flight audio seeks and duplicate optional play requests could add further churn. Candidate autoplay and automatic pause recovery also needed explicit preparation/deactivation guards to prevent premature or revived primary audio.

FIX:
- Remove optional still readiness from the primary AUDIO gate.
- Defer candidate motion loading until Program activation.
- Keep candidate primary AUDIO muted/non-autoplay until activation.
- Keep one initial audio seek in flight and one pending motion play request per element.
- Prevent deactivated outgoing audio or a late play resolution from resuming it.
- Add safe normal-preparation diagnostics for primary AUDIO, motion, element counts, pending audio/motion play, readiness, buffering and preparation latency/failing consumer identity.
- Preserve all 12-second primary failure recovery, cue capture and existing fallback behavior.

PREVIEW_RESOURCE_REUSE_FINDING: No broad ownership transfer was introduced. VIDEO/AUDIO transports and artwork elements remain independently owned by Preview and Program; still/image URLs can benefit from browser cache without sharing element ownership. IMAGE remains required. LIVE remains required. A safe direct Preview promotion would also need to address transport controls, audio routing, outgoing Preview replacement, CUT/DISSOLVE and stale cleanup across all source types. Actual dual-decoder saturation has not been proven sufficiently to justify that redesign. Optional candidate work is deferred instead.

FALLBACK_MODEL: Ready motion → configured ready still → AUDIO placeholder. Pending/failed motion and pending/failed still cannot fail an otherwise ready primary AUDIO TAKE. Motion becoming available later replaces the fallback without restarting or seeking primary audio. Artwork configurations remain in the existing Program Output descriptor; per-subscriber fallback is handled by existing subscriber code. No new protocol readiness fields.

## Five-case resource comparison

The census below uses real production source/surface/renderer/coordinator objects with deterministic media events. Counts cover Program, Preview and candidate elements managed by StudioSourceManager, not every browser tab or the separate Technical Monitor. V/A means VIDEO/AUDIO element counts. A loaded VIDEO is not asserted to be an active hardware decoder.

| Case | Program → Preview | Before V/A | During V/A | Loaded VIDEO during | After V/A | Simulated preparation latency |
| --- | --- | --- | --- | ---: | --- | ---: |
| A | BREAK → large VIDEO | 1/0 | 2/0 | 2 | 1/0 | 100 ms |
| B | large VIDEO → BREAK | 1/0 | 1/0 | 1 | 1/0 | 0 ms |
| C | large VIDEO → large VIDEO | 2/0 | 3/0 | 3 | 2/0 | 100 ms |
| D | large VIDEO → AUDIO+motion | 2/1 | 3/2 | 2 | 2/1 | 100 ms |
| E | AUDIO+motion → large VIDEO | 2/1 | 3/1 | 3 | 2/1 | 100 ms |

Required media in these fixtures is deliberately made ready after 100ms; these are controlled test timings, not performance measurements on the user's machine. BREAK completes without that media delay. Per-element readyState/networkState, currentTime, seeking, paused and pending-play flags are retained in var/generic-take-resource-matrix.json. None of the five ready fixtures times out. A separately unavailable primary AUDIO fixture identifies its candidate as the 12-second timeout consumer. Separate tests keep motion play pending, keep artwork unavailable beyond 12 seconds, and delay an audio seek under repeated readiness events.

HTTP RANGE COMPARISON: Real ephemeral production-server requests use the protected demo2.mp4 and test-audio.mp3 as representative media. Cases A–E dispatch respectively 2, 1, 3, 4 and 4 concurrent client Range requests (64 KiB each); all return complete 206 responses. Case D represents the mitigated two loaded videos plus two primary audio loads. Measured HTTP timings and byte counts are in var/generic-take-http-matrix.json. This demonstrates successful simultaneous reads, not sustained large-file throughput, actual browser request scheduling, or decoder capacity. Server delivery was not changed.

LARGE MOTION ASSET: The actual selected motion URL/asset was not supplied and cannot be identified from the text. Previous read-only findings for the representative local demo2.mp4 remain accepted: 2,242,262,600 bytes, 6914.138s, MP4 avc1/mp4a entries and front-loaded moov. They must not be mistaken for fresh measurements of the operator's selected motion. Real motion metadata/first-frame latency remains a manual-trace item. Protected media was not modified or transcoded.

RESOURCE-PRESSURE CONCLUSION: Element amplification and avoidable optional loading are demonstrated. GPU/decoder saturation is neither proven nor refuted. Heavy VIDEO → VIDEO still has three VIDEO elements during preparation, and case E likewise has three including motion. No universal dual-heavy-media reliability claim is made. No arbitrary size limit or global Preview playback disable was introduced.

CUE_REGRESSION: Primary audio cue 18 is preserved through CUT/DISSOLVE, optional failure and late motion readiness. Motion time does not determine the audio cue. One audio seek remains in flight despite repeated metadata/frame/transport notifications.

AUDIO_DUPLICATION_REGRESSION: Candidate primary audio cannot autoplay audibly before commit. After the real Preview swap, tests observe one audible AUDIO source for VIDEO → AUDIO. Deactivation and late pending-play tests prevent the outgoing audio from reviving. Preview remains independently usable; its normal playback is not globally disabled.

CUT_REGRESSION / DISSOLVE_REGRESSION: AUDIO, AUDIO+STILL, ready motion, delayed motion, pending motion play and missing artwork all pass both paths. Tests use real production coordinator/renderer logic; dissolve also retains the existing animation-fallback contract. Previously accepted VIDEO CUT/DISSOLVE tests remain in focused/full regression.

PROGRAM_OUTPUT_REGRESSION: Correct AUDIO source, captured initialTime, stillUrl and motionUrl are published after TAKE. Late motion visibility changes do not restart primary audio or create another Program TAKE. Public Viewer, OBS and protocol code remain untouched.

TESTS_ADDED: 26 grouped cases in test/generic-prepared-take.test.js cover the pre-fix optional-still failure, all AUDIO variants × CUT/DISSOLVE, late/never-ready motion, still/placeholder fallback, cue retention, muted motion, one audible audio, independent subsequent Preview, required-audio timeout/recovery, A–E element census, optional play coalescing, deactivation/late rejection guards, IMAGE and LIVE required-media paths, A–E actual HTTP Range concurrency and one audio seek under repeated readiness events.

REGRESSION_RESULTS: Focused Unified Sources/renderer/normal TAKE/Program Output suites 210/210 PASS. Dedicated generic tests 26/26 PASS. Full node --test 705/705 PASS (baseline 679). Syntax checks PASS. git diff --check PASS.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/studio/renderers/StudioAudioSurface.js
- public/js/studio/StudioRenderer.js (normal preparation and diagnostics only)
- public/js/core/RuntimeTrace.js (safe diagnostic fields)
- test/generic-prepared-take.test.js (new)
- docs/PREPARED-PREVIEW-GENERIC-TAKE-AUDIT.md (new)
- var/generic-take-* (baseline, census, HTTP comparison and validation evidence)

Existing dirty work is preserved. Baseline hashes confirm only the three listed existing source files changed. AutoLive gate/counter/post-TAKE files, Public/OBS, Scheduler, Control Desk, auth, MediaMTX, .env and P0-C1B.2 are untouched. Branch build/1003.3; index empty. No reset, restore, clean, stash, stage, commit or push.

BLOCKERS: No implementation/test blocker for these bounded changes. No connected browser means native request traces, actual pending native promises, first-frame timing and GPU/decoder pressure for the real five cases remain unverified. In particular, persistent pure VIDEO→VIDEO failure would require further runtime evidence; this fix does not claim to remove its required third consumer.

MANUAL_RETEST: Refresh Control. Run A–E with the actual heavy assets, then AUDIO, AUDIO+STILL and AUDIO+MOTION using CUT and DISSOLVE. In D, confirm TAKE succeeds from the primary audio cue even if motion is delayed; still or AUDIO placeholder should be visible until motion is ready. Confirm motion stays muted, no repeated primary audio, Preview remains usable and genuinely missing primary media still releases TAKE after 12 seconds. Export livezoneRuntimeTrace.download() for any remaining failure, especially C/E, to capture required-media-failed identity and readiness/resource snapshots.

NEXT_STEP = MANUAL RETEST PREPARED PREVIEW ACROSS VIDEO / AUDIO / AUDIO+MOTION

LIVEZONE PREPARED PREVIEW GENERIC TAKE AUDIT COMPLETE
