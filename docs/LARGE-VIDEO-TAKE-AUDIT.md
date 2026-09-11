# Large VIDEO normal TAKE audit

DECISION: LARGE_VIDEO_TAKE_READY_FOR_MANUAL_RETEST

BASELINE: build/1003.3; dirty worktree explicitly authorized. The user's last completed report was 648/648. The preserved, interrupted post-TAKE work had subsequently passed 658/658 before this task; this fix adds 13 tests. AutoLive tuning is paused as requested.

REAL_RUNTIME_OBSERVATION: User reports normal TAKE unavailable or incomplete for a roughly two-hour, >2 GB VIDEO. No browser connection was available and no screenshot/trace was included in this attachment. The permanent-busy code path is reproduced with production renderer/coordinator/UI and a controlled pending native play promise. This is not a claim of physically reproducing decoding of the user's video in their running browser.

TAKE_DISABLED_ROOT_CAUSE: StudioUI disables TAKE exactly when Preview is absent, Preview equals Program, or StudioTransitionCoordinator.isBusy() is true. No file-size, duration, metadata, or Program-publication condition directly disables TAKE. The demonstrated failure is transition-busy remaining true: normal prepareProgramScene awaited renderer.start(), which can await video.play() indefinitely, before calling waitUntilReady() and installing its 12-second timeout. This applies when start performs initial playback (notably cue zero). Thus the intended timeout was never armed. A different real guard cannot be excluded without the new runtime trace.

TAKE_GUARD_TRACE: Bounded localhost livezoneRuntimeTrace now includes normal-take/ui-guard and ui-click. Guard records Preview and Program IDs as sceneId/previousSceneId, exact reason, preparation state, source kind, transport state, transition busy, metadata readiness, known duration, playback readiness, pending transition and pending publication, readyState/networkState/currentTime. Program publication is diagnostic only, not an enablement guard. No URLs, tokens, raw errors or file contents are logged.

TRANSITION_TRACE: ui-click → accepted → prepare-start → metadata/frame/seek events → prepare-ready → state-commit → existing ProgramOutput publication trace. Failure records program-prepare-readiness-timeout and the coordinator's existing finally returns to idle. Invalid pre-acceptance guards remain unchanged.

VIDEO_READINESS_TRACE: loadedmetadata, loadeddata, canplay, seeked, waiting and error are observed for the prepared normal surface, with safe media time/duration/readiness state. Listeners are removed on success or failure. The surface still requires readyState >= 2 and completed initial cue. Metadata alone cannot commit.

HTTP_RANGE_SUPPORT: PASS on production createProgramOutputServer with an ephemeral loopback port. Both /media/<file> and /media-library/files/video/<file> exercised with the actual protected files; the Media Library test supplies a read-only repository mapping to those files. Each of three assets passes HEAD full Content-Length, Accept-Ranges: bytes, beginning/middle/near-end 128-byte GET requests with 206, exact Content-Range and Content-Length, byte-for-byte disk comparison, and invalid start returning 416 plus bytes */size. Large end offsets exceed 2^31. This verifies production route behavior, not the configuration of an unconnected installed server. No server-delivery changes were necessary.

LARGE_FILE_FINDINGS / MP4_METADATA_FINDINGS:

| Local asset | Bytes | Duration (seconds) | Container/sample entries | moov offset | Approx. average total bitrate |
| --- | ---: | ---: | --- | ---: | ---: |
| demo.mp4 | 10,320,286 | 34 | MP4 / avc1, mp4a | 10,301,619 (end) | 2.43 Mb/s |
| demo3.mp4 | 47,060,770 | 33.8 | MP4 / avc1, mp4a | 47,048,846 (end) | 11.14 Mb/s |
| demo2.mp4 | 2,242,262,600 | 6914.138 | MP4 / avc1, mp4a, mp4a | 20 (beginning) | 2.59 Mb/s |

The large local asset matching the description already has front-loaded moov (6,253,038 bytes). It does not suffer from end-of-file moov placement. Its video sync-sample table lists 6914 keyframes spaced 25 samples apart; the smaller assets use gaps of 100 and 58 samples respectively. This is a read-only atom/sample-table inspection, not a full codec/decoder probe: ffprobe was unavailable, and browser codec compatibility was not physically tested. File size is not itself the proven failure condition. Existing upload quotas are independent of playback and were not changed. No protected media was rewritten, transcoded or copied.

PREVIEW_PROMOTION_FINDING: Normal TAKE deliberately creates a separate Program instance. Preview owns independent transport controls; normal TAKE swaps the outgoing Program back into Preview with its captured transport state. getPreviewPreparationContext snapshots the current Preview cue, and the Program instance seeks to that cue before readiness. The new test verifies a 456-second Preview cue remains 456 seconds at Program activation; no reset to zero and no redesign of media ownership. HLS/AutoLive prepared-surface reuse remains unchanged.

BOUNDED_FAILURE_MODEL: renderer.start() and its readiness deadline now run concurrently. Successful readiness can complete despite an unresolved play promise. Startup rejection remains observed; missing metadata/frame/seek readiness fails after the existing 12000ms deadline. The coordinator discards only the failed preparation and clears busy in its existing finally block. Program and Preview selection remain unchanged on failure; a different subsequent TAKE works without reload. A Control-only message identifies the unavailable preparation and invites retry or another scene. A playable Preview is not falsely marked as a failed decoder just because the separate Program instance failed.

FIX: Activate the already intended readiness deadline before waiting on native play. Add bounded diagnostics and controlled Control UI feedback. No file-size restriction, longer arbitrary timeout, forced transcode, HTTP rewrite or Preview ownership change.

TESTS_ADDED: 13 grouped behavioral tests in large-video-take.test.js and large-video-range.test.js cover normal VIDEO TAKE; delayed metadata, canplay and seek; pending play with ready frames; metadata/frame/seek timeout; busy release; TAKE re-enablement and controlled feedback; unchanged Program after failure; successful subsequent TAKE; late-event isolation; current Preview cue in a separate Program instance; successful Program Output publication; all three actual assets on both production byte-range routes including beginning/middle/end/invalid ranges and >2 GB Content-Length. Playback readiness tests use controlled video events; actual-file comparison uses HTTP and MP4 inspection, not a simulated claim of decoding those files.

REGRESSION_RESULTS: Focused Control/media/Program Output/source suites 203/203 PASS. Dedicated tests 13/13 PASS. Full node --test 671/671 PASS. Changed JavaScript syntax PASS. git diff --check PASS.

FILES_CHANGED_FOR_THIS_FIX:
- public/js/studio/StudioRenderer.js — normal readiness deadline and scoped media trace.
- public/js/studio/StudioTransitionCoordinator.js — accepted/commit/failure trace only; transition semantics unchanged.
- public/js/ui/StudioUI.js — safe guard trace and controlled TAKE failure feedback.
- public/js/core/RuntimeTrace.js — additional sanitized diagnostic fields.
- public/js/entries/control-room-app.js — read-only pending-publication diagnostic provider for StudioUI.
- test/large-video-take.test.js (new).
- test/large-video-range.test.js (new).
- docs/LARGE-VIDEO-TAKE-AUDIT.md (new).
- var/large-take-* and var/large-video-* — baseline hashes, logs and read-only inspection evidence.

EXISTING_UNSTAGED_WORK_STATUS: Preserved, including the unfinished post-TAKE handoff changes from the interrupted prior task. No further AutoLive tuning in this task.

PROTECTED_FILES_STATUS: Baseline SHA-256 comparison across public/js, server, test and docs shows only the five existing JavaScript files listed above changed. AutoLive entry policy/counter/controller/presentation, authorization, external routing, LOSS behavior, Public/OBS, Scheduler, auth, MediaMTX, server delivery and all pre-existing tests are unchanged relative to this task's baseline. The protected media files were only opened for reads.

GIT_STATUS: Branch build/1003.3. Existing dirty baseline retained; new tests/audit remain unstaged. Index empty. Detailed status stored in var/large-take-final-status.txt. No reset/restore/clean/stash/stage/commit/push.

BLOCKERS: No implementation/test blocker. Real-browser decoding, installed-server response headers and the exact observed disabled guard still require manual confirmation. This readiness result does not assert the entire reported real-video symptom is conclusively resolved before that retest.

MANUAL_RETEST: Refresh Control to load the fix. Put an ordinary source B in Program; select the large VIDEO in Preview. Test TAKE at cue zero, after several seconds of Preview playback, and after a seek. Confirm Program takes the captured cue and output subscribers follow. If readiness fails, confirm the controlled message appears, TAKE is re-enabled within the existing 12-second deadline, B remains safe, and another scene can TAKE without reload. Repeat with demo.mp4 and demo3.mp4. Export livezoneRuntimeTrace.download() if the real large asset still fails; inspect normal-take guard, metadata, frame, seek and failure entries. Resume AutoLive interpretation only after normal TAKE is manually accepted.

ENV_CHANGED no
SERVICES_CHANGED no
MEDIAMTX_CHANGED no
AUTH_CHANGED no
PROGRAM_OUTPUT_PROTOCOL_CHANGED no
P0_C1B2_STARTED no
STAGING_CHANGED no
COMMIT none
PUSH none

NEXT_STEP = MANUAL RETEST NORMAL TAKE WITH LARGE VIDEO

LIVEZONE LARGE VIDEO TAKE AUDIT COMPLETE
