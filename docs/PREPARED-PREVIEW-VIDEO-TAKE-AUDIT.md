# Prepared Preview VIDEO normal TAKE audit

DECISION: PREPARED_PREVIEW_VIDEO_TAKE_READY_FOR_MANUAL_RETEST

REAL_BROWSER_RESULT: The user's bounded-failure recovery is manually accepted; actual TAKE still timed out despite Preview playing around 00:18 / 12:58. Browser discovery returned no connected browser. This fix reproduces and removes a concrete second-consumer readiness deadlock, but the exact first event in the user's browser remains unobserved. The 12:58 screenshot duration does not identify it as the earlier local demo2.mp4 asset; no such identity is assumed.

PREVIEW_MEDIA_STATE: In the deterministic reproduction Preview is a distinct ready, unpaused media surface which advances to cue 18. Its source ID, endpoint identity, currentTime/duration, readyState/networkState, paused/ended/seeking, video dimensions, surface readiness and instance identity can now be compared with Program in bounded normal-take trace entries. Buffered ranges are recorded separately, capped at eight. sourceId + endpointMatch verifies equality of source URLs without exporting URL queries or credentials. Actual runtime IDs and source URL cannot be recovered from the supplied text alone.

TAKE_ARCHITECTURE: B. Normal TAKE creates a second StudioMediaSurface and VIDEO element for the selected source. getPreviewPreparationContext snapshots Preview currentTime at command acceptance. Source identity/catalog information is shared; media transport/decoder/element ownership is not. StudioStateManager changes Program only after prepared readiness succeeds.

PROGRAM_MEDIA_INSTANCE: Separate Program consumer, initially muted, hidden while awaiting its cue/readiness. The existing Program surface remains active during preparation. A successful CUT/DISSOLVE activates the prepared Program surface; the old Program's captured context becomes Preview. This architecture is retained.

PREVIEW_VS_PROGRAM_LIFECYCLE: Reproduction before the fix: Preview already decoded at 18s; new Program starts at zero with a pending initial cue; metadata arrives at simulated t=1s; seekable is empty; loadeddata/canplay arrive at t=2s but cue remains pending; no currentTime assignment is ever made; TAKE fails at the existing t=12s deadline. After the fix metadata at t=1s initiates the seek to 18s, one seek completes at t=4s, and readiness permits TAKE. The unresolved native play promise does not block readiness. The failing pre-fix test is retained in var/preview-take-before.log; passing results are in var/preview-take-final-focused.log.

CONCURRENT_CONSUMER_FINDING: Production renderer tests keep Preview playing while a second VIDEO prepares. Cue capture remains the acceptance-time value 18 even when Preview advances to 19 during preparation. Small (34s) and long (6914s) simulated media follow the same corrected event ordering. No browser-specific resource/decoder contention was measured because no real browser was connected.

RANGE_REQUEST_COMPARISON: Existing Range and moov findings are accepted unchanged. A new targeted test uses the production HTTP server and actual protected large MP4: Preview-only, Program-only and both range requests concurrently all return 206 with exact ranges and identical 64 KiB bodies within a bounded request timeout. This refutes an unconditional server inability to serve two consumers; it does not claim to measure native browser requests or decode scheduling. Server code and protected media are unchanged.

SEEK_ORDER_FINDING: src assignment → loadedmetadata → derive/clamp finite cue → request seek → seeked at target + decoded frame → ready → commit. Previously an extra seekable-membership guard blocked the seek request itself. For a finite-duration Program VIDEO, metadata provides a valid timeline; assigning currentTime initiates retrieval of the target. Pending seek is not reissued on loadeddata/canplay. A ready frame before seek completion cannot authorize TAKE. Unknown/infinite timelines retain the existing range-based check. Preview's existing transferred-cue initialization contract is unchanged.

PLAY_PROMISE_FINDING: The previous race between startup and bounded readiness is preserved. For nonzero cue, startPlayback runs after cue positioning; its promise is not the visual-readiness authority. Tests deliberately leave play() pending while valid decoded/cued frames permit TAKE. Native play/autoplay audio handling remains in the existing activation path.

FIRST_READINESS_DIVERGENCE: In the proven reproduction, metadata is available but Program.initialCueState remains pending solely because seekable.length is zero. Preview does not encounter this guard because it is already initialized and advancing. This is the first demonstrated code divergence; attribution of the exact real screenshot's failure requires the new runtime trace.

ROOT_CAUSE: Circular prerequisite in the cold Program consumer: require target to be seekable before requesting the seek that can cause retrieval of that target. No evidence requires a file-size limit, a larger timeout, server rewrite, or transcode.

FIX:
- Program finite-VOD initial cue may seek after metadata even if seekable is still empty or excludes the target.
- Program does not reissue an in-progress initial seek and does not mark visual readiness while still seeking.
- Normal preparation traces compare both surface identities and readiness events. No AutoLive lifecycle changes.
- Existing effective 12-second deadline, cleanup, busy release, safe current Program and controlled failure message are unchanged.

PREVIEW_PROMOTION_DECISION: Do not transfer ownership of the existing Preview surface for this fix. The demonstrated deadlock is removable without changing consumer roles, independent Preview controls, outgoing Program handoff, audio activation, or transition cleanup. Shared decoder/transport adoption would require broader ownership changes not justified by this finding.

CUE_REGRESSION: Acceptance-time Preview cue retained (18s; no zero restart). A later Preview change does not redirect the prepared Program. Delayed metadata and delayed seek tests verify ordering and one seek assignment.

CUT_REGRESSION: Small/long ready Preview → separately prepared Program CUT passes.

DISSOLVE_REGRESSION: Small/long ready Preview → DISSOLVE passes using the production transition path and controlled animation completion. Both roots coexist until transition completion; cleanup preserves active Program.

PROGRAM_OUTPUT_REGRESSION: Published source is media and initialTime is 18 after successful TAKE. Program audio becomes unmuted through existing activation; Preview remains muted. Selecting another Preview source leaves Program identity and cue unchanged. Public/OBS code and Program Output protocol are untouched.

TESTS_ADDED: Eight grouped tests cover the previously failing playing-Preview/empty-seekable reproduction; small and long media × CUT/DISSOLVE; delayed metadata + nonzero cue; delayed seek; pending play with visual readiness; concurrent independent media surfaces; safe timeout, busy release and successful subsequent TAKE; one seek in flight; cue/source publication; audio/Preview independence; actual concurrent HTTP range delivery. Previous 13 large-video tests continue to cover controlled UI recovery and ordinary preparation failures.

REGRESSION_RESULTS: Focused renderer/media/Control/Program Output/source suites 211/211 PASS. New tests 8/8 PASS. Full node --test 679/679 PASS (baseline 671). Syntax checks PASS. git diff --check PASS.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/studio/renderers/StudioMediaSurface.js — Program-only initial seek eligibility and in-flight seek readiness guards.
- public/js/studio/StudioRenderer.js — normal preparation comparison/event diagnostics only.
- public/js/core/RuntimeTrace.js — safe seeking, dimensions and buffered-range fields.
- test/prepared-preview-video.test.js — new deterministic and concurrent HTTP tests.
- docs/PREPARED-PREVIEW-VIDEO-TAKE-AUDIT.md — this audit.
- var/preview-take-* and var/preview-program-concurrent-range.json — baseline/validation evidence.

Baseline SHA-256 comparison shows only the three existing JavaScript files listed above changed. Existing dirty work, all prior tests, AutoLive gate/counter/ENTRY/LOSS/routing/authorization, Public/OBS, Scheduler code, Control layout, auth, MediaMTX and environment remain preserved. Branch build/1003.3. Index empty. No stage, commit, push, reset, restore, clean or stash. Protected media only read; no server-delivery changes.

BLOCKERS: No implementation/test blocker. The precise real-browser source identity, simultaneous native range timing and codec/decoder state remain manual-validation items. Ready for retest is not a claim of an observed successful TAKE in the user's browser.

MANUAL_RETEST: Refresh Control. Let the target VIDEO play in Preview past 18s; TAKE with CUT, then repeat with DISSOLVE. Confirm Program takes the captured current Preview cue, audio activates, and Preview can be changed independently. Repeat with a small clip. If TAKE still fails, export livezoneRuntimeTrace.download() and compare normal-take preview-before-prepare, program-created, loadedmetadata, seeking/seeked, canplay, prepare-ready or failed. A genuinely unavailable preparation must still fail within 12 seconds and release TAKE without changing Program.

NEXT_STEP = MANUAL RETEST LARGE VIDEO ALREADY PLAYING IN PREVIEW → TAKE

LIVEZONE PREPARED PREVIEW VIDEO TAKE AUDIT COMPLETE
