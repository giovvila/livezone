# Build 1003.3 — validated runtime checkpoint

The operator's final manual validation is the accepted baseline. This document supersedes earlier audit decisions and pending manual-retest statements; historical audits remain evidence of the investigation, not current product policy.

## Accepted runtime

Normal VIDEO, AUDIO and IMAGE TAKE work. Heavy VIDEO → VIDEO and VIDEO → AUDIO with heavy motion artwork work. Prepared Preview → Program handoff preserves the incoming surface, cue and ownership; Program continues after Preview changes. Control → Scheduler → Control preserves playback continuity. Control Desk collapse/expansion and persistence are accepted.

The handoff removes a demonstrable duplicate incoming media consumer. Eligible VIDEO → VIDEO uses two video elements during transition, rather than three. Audio/motion transfers its prepared surface and leaves optional artwork non-blocking. CUT and DISSOLVE, BREAK control cases and AUDIO+MOTION → VIDEO are covered by automated regressions. The operator's final list does not separately identify every transition variant. Browser decoder exhaustion was a hypothesis, not a proven hardware diagnosis. No global Preview playback restriction or media-size limit is introduced.

AutoLive starts a new session with the broadcast-safe ENTRY slate and **30 accumulated healthy seconds**. Short uncertainty pauses/resumes accumulation under the existing policy. Active LIVE uses a **2-second visual loss debounce**. Recoverable loss displays the semantically separate LOSS slate without altering Preview, the return cue or ownership. **15 seconds of continuous confirmed absence** precede return to interrupted MEDIA A. A genuine later return starts a fresh 30-second ENTRY.

The operator validated stable long-run LIVE without periodic slate flashes, stable audio, same-session LOSS → LIVE after 3–5-second and 10-second interruptions in Control/Public/OBS, and persistent-loss return to A in all three outputs. Public and OBS recover without refresh. MEDIA A resumes correctly.

## Locked architecture and policy

- New-entry timing: `AutoLiveEntryPolicy.js`, `AUTO_LIVE_ENTRY_STABILITY_MS = 30000`; existing healthy-time accumulation and 22-second entry abandonment remain intact.
- Active loss: `AutoLiveActiveHealth.js` owns active external Program health, 2-second presentation debounce and the confirmed-loss deadline from `AutoLivePostTakePolicy.js` (15000 ms).
- Program HLS recovery: one active owner, native in-place reload or retained HLS.js attempt first, then bounded replacement at the shared 5000-ms retry cadence. Player replacement never starts a new AutoLive session. Presentation's legacy fallback is disabled while this owner is current.
- Subscriber recovery: shared `PublicProgramController` verifies progress on same-activation LOSS clear, reuses advancing media, or performs one rebuild after 5000 ms without progress. Existing renderer retry owns subsequent preparation failures. Generation/identity checks protect operator override and teardown. Public muted/audio-enable and OBS audible policies are retained.
- Preview handoff, cue preservation, Scheduler interruption/restore guards, authorization hydration/routing, ENTRY/LOSS output semantics, Control Desk behavior and output contract are locked. No protocol or runtime configuration change was made during consolidation.

## Consolidation checks

No production code or test logic was changed in this consolidation. Full `node --test`: **803 passed, 0 failed, 0 skipped**. Syntax: **78 changed/new JavaScript files passed**. Relative source imports: no missing dependencies. Full worktree and staged diff whitespace checks are recorded with the checkpoint evidence.

Coverage includes the five BREAK/heavy-media transition cases, eligible CUT/DISSOLVE handoff without a third incoming player, normal Public/OBS output, ENTRY, LOSS, same-session recovery, persistent return, stale callbacks, Scheduler continuity and Control Desk migration/collapse. Runtime acceptance is operator-reported; automated tests were rerun here.

KEEP diagnostics: bounded local `RuntimeTrace` (1000 entries by default, capped at 2000, allowlisted fields), bounded/deduplicated authorization diagnostics (100 records), and their source-health, handoff, ownership, player and output events. Tests depend on these observations. REMOVE: none; no demonstrably safe temporary-only production deletion was identified. Generated logs, traces and diagnostic exports are excluded and preserved locally.

Non-blocking limitations: platform-specific playback remains subject to browser audio policy; a stalled subscriber can show the last frame during its bounded five-second verification. Large-file HTTP tests use local media fixtures, which are deliberately not part of this checkpoint. Earlier audits contain superseded 60-second policy/history and are retained as history. No newly identified runtime blocker.

## Reviewable checkpoint scope

Base HEAD: `2ad3fc1ea361022bf0ed5c78f0e91d0fd42d5c19`; branch `build/1003.3`; local remote-tracking divergence `0 ahead / 0 behind` (no remote fetch performed). Initial staging was empty.

The proposed set is 51 source/UI files, 30 test files and 27 documents including this checkpoint. Every dirty/untracked path is classified in `var/checkpoint-classification.json`; the exact proposed paths are in `var/checkpoint-proposed-files.txt`, and the actual staged list is in `var/checkpoint-staged-files.txt`. Categories A/B/C are eligible; D/E are excluded. No unrelated or uncertain source files were identified.

Excluded media: modified `public/media/demo2.mp4`, untracked `public/media/demo3.mp4`, `public/media/imm.jpg`, `public/media/test-audio.mp3`, and unused local `public/assets/logo/logo-test.svg`. Also excluded: all generated `var` evidence, `.env`, ignored media-library contents, logs, MediaMTX and WinSW runtime files. Nothing was deleted. Commit and push are not authorized by this checkpoint and were not performed.

Next step: REVIEW STAGED BUILD 1003.3 CHECKPOINT BEFORE COMMIT.
