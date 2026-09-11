# Preview → Program handoff audit

DECISION: PREVIEW_PROGRAM_HANDOFF_READY_FOR_MANUAL_RETEST

REAL_MANUAL_MATRIX: Operator-reported A BREAK→VIDEO PASS; B VIDEO→BREAK PASS; C VIDEO→VIDEO FAIL; D VIDEO→AUDIO+motion FAIL, before this change. E/F have no new real-browser result. Automated results below are not a replacement for that matrix.

CURRENT_RESOURCE_OWNERSHIP: Previously Preview B and Program A each owned a surface, while preparation allocated a separate Program B. The new normal operator TAKE reserves the ready Preview surface without owning it, revalidates its scene/generation/health/cue, transfers its SourceManager consumer and transport subscription, then commits state synchronously. Only its media content root moves; Preview graphics remain Preview-owned.

VIDEO_VIDEO_RESOURCE_COUNT: Old ready-Preview preparation peaked at 3 VIDEO elements (A, Preview B, candidate B). The new eligible handoff peaks at 2; no new B element or source assignment is needed.

VIDEO_AUDIO_MOTION_RESOURCE_COUNT: Previously 3 VIDEO + 2 AUDIO elements could be allocated, including the unstarted candidate motion. New eligible handoff retains A video plus B motion plus B primary audio: 2 VIDEO + 1 AUDIO.

FIRST_DUAL_HEAVY_FAILURE_BOUNDARY: The previous architecture introduced a third cold incoming consumer between accepted TAKE and required-media readiness. This allocation boundary is demonstrated by the retained cold-fallback tests. The exact native decoder, HTTP request, or browser operation causing the reported timeout has not been captured in this session.

PROMOTION_FEASIBILITY: Demonstrated with the real renderer, source manager, coordinator, state manager and output manager under a deterministic DOM/media harness. Incoming surface, primary element and optional motion retain object identity. Native browser reparenting/playback still requires manual validation.

HANDOFF_ARCHITECTURE: Reserve → revalidate → stage ownership → synchronous state commit → activate same surface → retire outgoing → rebuild latest selected Preview. Reservation cancellation never destroys borrowed Preview. Staging failure or rejected state commit restores Preview ownership and generation. Stale Preview startup cannot release a surface now owned by Program. Automatic/scheduled transitions and explicit cue preparation retain the existing path.

CUT_MODEL: Transfer B, commit, activate B, release A, then construct the new Preview. No cold B preparation.

DISSOLVE_MODEL: A and B remain present through the animation. Preview rendering is deferred while these two surfaces exist. After A is released, the latest Preview selection is rendered. The incoming root is retained during dissolve cleanup. Maximum 2 VIDEO elements for eligible VIDEO→VIDEO handoff.

AUDIO_MOTION_MODEL: Transfer the whole ready audio surface: primary audio, still, motion and listeners. Optional artwork remains non-blocking. Motion stays muted. No second B audio element is created. Program activation uses the existing audio recovery behavior. Outgoing audio deactivates before incoming activation; rebuilt outgoing Preview starts paused at its captured cue.

RESOURCE_PRIORITY_MODEL: The current Program and transferred incoming Program have priority during transition. Preview reconstruction waits only for that transition's outgoing cleanup (400ms in the tests). Preview playback is not globally disabled, and no media-size limit is introduced. The 12-second bounded cold preparation remains available when Preview cannot be reused.

HARDWARE_FINDING: The reported CPU 4%, RAM 38%, disk 0%, GPU 12% does not establish insufficient hardware. No hardware insufficiency conclusion is made.

ROOT_CAUSE: Proven architectural duplication of incoming media consumers; the browser-level cause of the observed failure remains unproven. This change removes that duplication for a ready Preview instead of altering Range delivery, media files or readiness timeouts.

FIX: Added PreviewProgramHandoff; added validated SourceManager consumer transfer; integrated reservation, stage, completion and stale-start protection into renderer/coordinator. Old cold-preparation tests explicitly disable reuse so they continue testing their original bounded fallback contracts.

RESOURCE_COUNTS_AFTER_FIX: Deterministic live surface elements, including optional motion VIDEO. During CUT the peak is the pre-commit pair; during DISSOLVE the pair lasts until outgoing cleanup. After counts include the normal outgoing-scene Preview reconstruction.

| Case | Program → Preview | Before V/A | Transition peak V/A | After V/A |
|---|---|---:|---:|---:|
| A | BREAK → VIDEO | 1/0 | 1/0 | 1/0 |
| B | VIDEO → BREAK | 1/0 | 1/0 | 1/0 |
| C | VIDEO A → VIDEO B | 2/0 | 2/0 | 2/0 |
| D | VIDEO → AUDIO+motion | 2/1 | 2/1 | 2/1 |
| E | AUDIO+motion → VIDEO | 2/1 | 2/1 | 2/1 |
| F | AUDIO+motion A → AUDIO+motion B | 2/2 | 2/2 | 2/2 |

For A–F there are no HLS instances. Transport ownership follows the existing surface: Preview subscription is removed and Program subscription installed. Reuse requires primary readyState ≥2 and no pending native seek/ended/error state; handoff issues no preparation seek or load. Deterministic preparation latency is 0ms (activation/animation excluded), with no timeout consumer. Existing activation may call play on the same primary element. Native pending play promises, HTTP Range concurrency, networkState and decoder counts cannot be inferred from element identity: they were not measured in a real browser. The generated `var/surface-handoff-resource-matrix.json` is explicitly a deterministic surface census. Public/OBS clients have their own consumers and are not included in these Control Room counts.

CUE_REGRESSION: Incoming VIDEO and primary AUDIO retain 518 seconds (08:38), with no resetting source or new cue seek. Outgoing VIDEO Preview retains its captured 37-second cue. Explicit 42-second cue commands use cold preparation and retain that cue.

PREVIEW_INDEPENDENCE: Selecting C after CUT or during DISSOLVE cannot destroy or control transferred B. During DISSOLVE only the latest selected Preview is constructed after outgoing cleanup. No second ownership remains in Preview.

AUDIO_REGRESSION: At most one playing unmuted primary AUDIO in the completed matrix; incoming primary is unmuted and motion muted. Existing autoplay failure/recovery contracts remain in the full suite.

MOTION_REGRESSION: Same motion object transfers with the audio surface. Existing non-blocking optional still/motion and pending-play/coalescing tests remain passing through the explicitly exercised cold fallback.

PROGRAM_OUTPUT_REGRESSION: Shared output snapshots carry the incoming 518-second cue. Full network output, Public/OBS and continuity unit/integration coverage passes. No real OBS screenshot or playback observation was obtained.

FAILURE_RECOVERY: Covered Preview replacement between reservation and stage, a seek beginning before commit, DOM move failure, rejected state commit, destruction during dissolve, late Preview startup after successful promotion, and late startup after rollback. A remains safe for pre-commit failures; coordinator busy clears; subsequent TAKE succeeds where tested.

TESTS_ADDED: 23 tests in `test/preview-program-handoff.test.js`: 12 A–F CUT/DISSOLVE rows and 11 ownership, cancellation, scope, cue and stale-callback cases. New incoming consumers are prohibited by assertions during the matrix. Prior cold tests retain their original assertions with explicit reusePreview:false.

REGRESSION_RESULTS: Full `node --test`: 728/728 PASS, versus the reported 705 baseline. Focused renderer/TAKE/unified-source/output suites pass. Syntax checks and `git diff --check` pass; Git emits existing CRLF normalization warnings.

FILES_CHANGED_FOR_THIS_FIX: Production: `public/js/studio/PreviewProgramHandoff.js` (new), `StudioRenderer.js`, `StudioSourceManager.js`, `StudioTransitionCoordinator.js`. Tests: `test/preview-program-handoff.test.js` (new), `test/generic-prepared-take.test.js`, `test/prepared-preview-video.test.js`. This audit and local `var/surface-handoff-*` evidence files are added. Baseline hash comparison is recorded in `var/surface-handoff-changed-files.json`.

EXISTING_UNSTAGED_WORK_STATUS: Preserved the authorized dirty baseline. No reset, restore, clean, stash, stage, commit or push performed.

PROTECTED_FILES_STATUS: No edits to AutoLive controllers/gates/slates/routing, output clients, Scheduler, Control Desk, auth, MediaMTX, .env, media assets or P0-C1B.2. Shared renderer/coordinator changes are limited to normal operator handoff or guarded lifecycle handling; existing preparation remains exercised. Baseline hashes across existing public/js, server and test files identify only the five existing files listed above as changed by this task.

GIT_STATUS: Remains dirty with earlier work plus this change. Raw status: `var/surface-handoff-status.txt`. Nothing staged, committed or pushed by this task.

BLOCKERS: No implementation/test blocker. In-app browser enumeration returned an empty list. Native heavy-media reparenting, pending browser operations, actual Range concurrency and Control/Public/OBS visual playback need manual retest. READY means ready for that retest, not proven live-runtime resolution.

MANUAL_RETEST: Repeat A–F with the actual large files, CUT and DISSOLVE, including VIDEO 08:38 and nonzero AUDIO cue. Inspect element/decoder/Range counts, seeking, pending play promises and transition latency; identify any exact timed-out consumer. Verify no third incoming Control Room consumer, no duplicate audio, muted motion, cue continuity, Preview C independence during transition, failure recovery and matching output in Control, Public and OBS.

NEXT_STEP = MANUAL RETEST DUAL-HEAVY PREVIEW → PROGRAM TAKE

LIVEZONE PREVIEW PROGRAM HANDOFF AUDIT COMPLETE
