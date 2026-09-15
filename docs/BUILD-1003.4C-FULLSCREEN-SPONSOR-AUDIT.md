# Fullscreen Sponsor extension

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Decision: BUILD_1003_4C_FULLSCREEN_SPONSOR_READY_FOR_MANUAL_RETEST

The explicitly requested extension adds layout to the existing overlay.sponsor event, merge and SponsorView. It supersedes the previous feature freeze only for this scope. The previously staged 117-file checkpoint is unchanged; this extension is unstaged. No commit, push, production schedule edit, production DELETE, TAKE or service restart was performed.

## Contract and editor

Sponsor layout is CORNER or FULLSCREEN. Missing layout normalizes to CORNER without rewriting stored events at boot. CORNER retains position, sizePercent (5–30) and opacity (0–1); stale fit is removed. FULLSCREEN retains fit (CONTAIN or COVER) and opacity; stale position/sizePercent are removed. Unknown layout/fit, arbitrary fields and invalid opacity are rejected. The existing assetId/image-library policy is unchanged: PNG/WebP/JPEG, no Sponsor audio or added SVG support.

The existing Scheduler Sponsor editor exposes layout and conditionally hides/disables incompatible fields, including excluding them from FormData. Fullscreen defaults to CONTAIN. Edit/hydration and switching back to CORNER preserve safe defaults. Shared asset selection, title, interval, enabled flag and priority retain their existing behavior.

## Rendering and policy

The same SponsorView renders a single image, 100% width/height with inset 0 in the Program composition. CONTAIN preserves the whole image; uncovered/transparent regions reveal underlying composition. COVER preserves aspect ratio and crops to fill. Opacity remains bounded and does not change Program audio. No decoder, polling or additional player is created.

One Sponsor winner is selected by the existing priority/tie-break policy across both layouts. Fullscreen is not a second slot or overlay type. Z-order: base < channel graphics (1) < lower third (2) < corner Sponsor (3) < crawl (4) < fullscreen Sponsor (5). Technical loss presentation remains above these; ENTRY/LOSS suppression also applies to fullscreen. Channel Logo policy is a clean Sponsor frame: fullscreen is above the logo, not below it. Transparent pixels, contain margins and partial opacity intentionally reveal underlying layers.

Crawl stays scheduled and animated underneath. Fullscreen activation/expiration neither removes its node nor resets its timer/phase. The existing server merge preserves Program identity and playback, and does not issue Preview or TAKE commands. Control renders only on its Program graphics surface. Public/OBS use the same SponsorView and raise the existing Sponsor container to layer 5 for fullscreen, restoring layer 3 for corner. Retained SSE includes the fullscreen state for late joins. Server activation does not require Control/Scheduler pages.

ENTRY and LOSS hide Sponsor; LIVE recovery restores it only within the original schedule interval. BREAK allows it. Asset failure omits the Sponsor layer without breaking Program or crawl. Future, active and expired persisted fullscreen Sponsor events keep their ordinary asset references in the existing safe-delete inventory.

## Verification

Added 38 cases across fullscreen-sponsor.test.js, sponsor-runtime-workspace.test.js and schedule-overlay-editor.test.js. Coverage includes old payload normalization, four corner positions, fit/opacity validation, stale-field removal, real editor create/edit/mode switching, actual CSS hidden state, real server scheduling and retained SSE, Control/Public/OBS rendering, fresh overlay rendering on late join, VIDEO/AUDIO/HLS player identity and absence of playback commands, crawl node/timer preservation, ENTRY/LOSS recovery, BREAK, cross-layout priority, bad/missing assets, and retained safe-delete references.

Continuity tests exercise the production controller and reject player recreation/playback reconciliation during overlay changes. They do not claim an observed real browser cue or an actual running OBS session; visual/cue/audio acceptance remains manual. Existing full regression covers normal TAKE, AutoLive, crawl, shared Media Library, reference races/recovery and Control navigation continuity.

- Focused: 282/282 PASS, var/fullscreen-focused.log.
- Full node --test: 1372/1372 PASS, var/fullscreen-full.log (baseline 1334).
- Syntax: 10 changed/new JavaScript files PASS.
- git diff --check PASS.
- Existing staged set remains 117 files, 9629 additions / 150 deletions.

Changed for this extension:

- public/control/schedule/index.html
- public/css/schedule-workspace.css
- public/js/scheduler/ScheduleEventEditorAdapter.js
- public/js/ui/ScheduleOverlayEditorUI.js
- server/scheduler/ScheduleContract.js
- server/program-output/EffectiveProgramOutput.js
- public/js/program-output/ProgramOutputContract.js
- public/js/studio/renderers/SponsorView.js
- public/js/public/PublicProgramController.js
- test/fullscreen-sponsor.test.js
- test/sponsor-runtime-workspace.test.js
- test/schedule-overlay-editor.test.js
- this document

## Manual retest

Backend loading requires a separately authorized LivezoneNode restart; none was performed. After loading and normal client reload, create a fullscreen image Sponsor, verify CONTAIN/COVER and partial opacity on Control/Public/OBS, then verify underlying VIDEO/AUDIO/LIVE cue and audio advance uninterrupted. Exercise late joins, crawl continuation after fullscreen expiry, clean-frame logo policy, priority collision, ENTRY/LOSS recovery and BREAK. Confirm referenced assets remain non-deletable. The old staged checkpoint does not include this extension and must not be mistaken for the full current worktree.

NEXT_STEP = MANUAL RETEST FULLSCREEN SPONSOR ON CONTROL/PUBLIC/OBS
