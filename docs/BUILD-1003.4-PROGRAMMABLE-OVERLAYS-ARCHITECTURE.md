# Build 1003.4 — programmable overlays architecture audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

DECISION: BUILD_1003_4_PROGRAMMABLE_OVERLAYS_ARCHITECTURE_READY

BASELINE: `build/1003.4`, HEAD `e249fa040b3ff5a94f00dd7efdcc978cd656d8f3`. Build 1003.3 is the protected, manually accepted checkpoint (803/803 previously passing). This audit changes documentation only. No feature, scaffolding, source changes, staging, commit or push. Recommendations below are proposed contracts, not existing functionality.

## Existing implementation and reuse findings

| Area | Evidence | Current capability / disposition |
|---|---|---|
| Crawl | `public/js/ui/StudioTextCrawlUI.js`, `studio/StudioGraphicsManager.js`, `studio/renderers/StudioGraphicsLayer.js` | Functional manual Program SHOW/HIDE/UPDATE; 500-character plain text, crawl/fixed, rtl/ltr, slow/medium/fast, top/bottom, background boolean. Reuse validation and controls, but route future scheduled/manual arbitration through one owner. No schedule or prefix field. |
| Channel logo | `ui/StudioGraphicsUI.js`, `StudioGraphicsManager.js` | Functional image graphic `channel-logo`; Preview apply, copy to Program, hide and reset. Uses legacy asset-library kind `logo` or HTTP(S) URL draft. Preserve its identity; never use this ID for a sponsor. |
| Lower third | `ui/StudioGraphicsUI.js`, `renderers/StudioLowerThirdGraphic.js` | Functional manual Preview/Program graphic; title 80 and subtitle 120 characters; bottom-left. Already published. Keep manual controls; scheduled lower thirds are follow-up scope. |
| Storage | `StudioTextCrawlUI.js`, `StudioAssetLibrary.js`, `StudioGraphicsManager.js` | Crawl preferences persist at `livezone.studio.textCrawl.v1`. Asset catalog overrides persist at `livezone.studio.assetLibrary.overlay.v1`; that is asset metadata, not an overlay schedule. GraphicsManager visibility/payload maps are in memory; channel-logo/lower-third selections have no general persisted graphics-state store. |
| Control rendering | `StudioGraphicsLayer.js` | Real per-consumer graphics layer, independent from media scene; redraw replaces all children, restarting crawl animations. Extend carefully with stable keyed reconciliation; do not copy this destructive redraw pattern into scheduled animation. |
| Output | `program-output/ProgramOutputManager.js`, `ProgramOutputContract.js` | Images/lower thirds in `graphics.items` (maximum 8); one crawl in `overlays.textCrawl`. Graphics publications preserve scene/source/playback activation. No scheduling metadata, image size/opacity or crawl phase. |
| Public / OBS | `public/PublicProgramController.js`, `entries/obs-output-app.js` | Shared subscriber rendering and transport, with different audio policies. Crawl uses textContent and CSS; every render currently recreates its DOM. Reuse both outputs' common controller and transport. |
| Other Overlay files | `ui/Overlay.js`, `ui/OverlayController.js` | TODO stub and stream readiness/countdown UI respectively. Not a programmable broadcast compositor; do not reuse as schedule runtime. |
| Assets | `StudioAssetResolver.js`, `server/media-library/MediaAssetRepository.js` | Managed image assets resolve through assetId to HTTP(S). PNG/WebP supported by signature-checked upload. SVG upload is not supported. Legacy static SVG logos do not establish a safe uploaded-SVG policy. |

EXISTING_PROGRAM_OUTPUT_SUPPORT: Useful for manually controlled overlays, insufficient for the full proposed timed contract. Current validators strip unrecognized image/crawl fields and reject new keys inside overlays. Adding fields is not automatically backward-compatible. ProgramOutputStore retains one envelope in memory, not on disk. No second SSE is warranted.

## Scheduler current model and runtime authority

SCHEDULER_CURRENT_MODEL: `scheduler/ScheduleContract.js` supports ABSOLUTE and AFTER_PREVIOUS starts, NORMAL/INTERRUPT behavior, durations, timezone conversion and deterministic computed boundaries. `scheduler/ScheduleClock.js` additionally computes interruption shifts and hard-clock constraints: the model is hybrid, not pure absolute timing. `SchedulerEngine` uses an injected Date.now clock and timers. `ui/ScheduleClock.js` is a shared aligned one-second UI clock, not a server clock.

`ScheduleStore` persists browser-local data under `livezone.scheduler.schedule.v1`, with storage events for other same-origin tabs. `entries/schedule-app.js` is an editor, not a second SchedulerEngine authority. Control owns the running scheduler. No existing durable server schedule engine was found. Do not claim browser-local persistence is server-side scheduling.

TARGET PIPELINE: Scheduler editor → dedicated OverlayScheduleStore → one OverlayRuntimeEngine in the existing Control publisher lifecycle → resolved overlay composite → existing ProgramOutputManager/envelope/SSE → shared Public/OBS renderer. OverlayRuntimeEngine must never call StudioProgramCommand, mutate StudioStateManager, acquire AutoLive ownership, manipulate media players, or write Preview.

The runtime evaluates immutable events against absolute wall time. It emits only changed resolved state. Reuse the injected clock/timezone conversion functions, not media schedule shifts or AFTER_PREVIOUS behavior. Subscribe once to store changes, one next-boundary timer plus clock/focus reconciliation, dispose all listeners/timers and guard async asset completion by event/store generation. Timer delay is only a wake-up hint; recompute from current time after throttling or clock changes. Cap long timer delays and re-arm rather than overflowing browser timers.

## Target overlay model and schema versioning

New independent persisted key: `livezone.scheduler.overlays.v1`. Do not append items to the current scene schedule; its serializer explicitly projects known fields. Proposed schema:

```json
{
  "version": 1,
  "timezone": "Europe/Rome",
  "events": [{
    "id": "overlay-example",
    "name": "Evening news crawl",
    "type": "crawl",
    "enabled": true,
    "startAt": "2026-09-12T18:00:00.000Z",
    "endAt": "2026-09-12T18:10:00.000Z",
    "priority": 0,
    "policy": {"entry": "suppress", "loss": "suppress", "break": "show"},
    "payload": {
      "text": "Evening programme information",
      "position": "bottom",
      "direction": "rtl",
      "speed": "medium",
      "repeat": "continuous",
      "styleId": "broadcast-default",
      "background": true
    }
  }]
}
```

TIME_MODEL: Half-open intervals `startAt <= now < endAt`. Persist canonical UTC timestamps with explicit offset; timezone is for editing/display. UI accepts end time OR positive duration and normalizes to one endAt, never contradictory persisted values. Reject nonexistent local DST times; require explicit offset selection for ambiguous times. Independent of scene pause, shift and AutoLive takeover. Validate unique IDs, bounded names/text, finite integer priority (proposed -100..100), end after start and a bounded event count (proposed 500). Invalid/unknown-version data returns diagnostics without rewriting or deleting the saved object. Missing key yields an empty schedule; no boot save. Existing schedule and manual crawl storage remain unchanged. Multi-tab edits should use revision checking and surface conflicts rather than silently overwrite.

CRAWL_MODEL: Plain text max 500 characters; enabled/time belong to event. Reuse top/bottom, rtl/ltr, slow/medium/fast (current cycle durations 24/16/9 seconds), background boolean, fixed approved typography through styleId. Core repeat is continuous until endAt. Single-pass is a small explicit follow-up: phase and completion must be defined before exposing it. No arbitrary CSS, markup or script. No separate prefix in core because the current system has none; operators may include a prefix in text.

SPONSOR_MODEL: Payload `{assetId, position, sizePercent, opacity}`. Managed PNG/WebP only in core; resolve with expectedKind image. Proposed sizePercent 5..30 of the video viewport width, aspect ratio preserved with max-height constraint, opacity 0..1. Position is one of four corners. No filesystem paths or arbitrary URL entry. Static images only: no video/audio consumer. Rotation is a follow-up subphase; a future ordered assetId/dwellSeconds list can derive index from `(now-startAt)` and preload the next image with bounded memory. It does not require another authority, but deletion, slot switching and late-join tests make it nontrivial.

CHANNEL_LOGO_RELATIONSHIP: Persistent channel identity keeps its existing manager/ID; sponsor occupies a separate reserved scheduled ID. Never hide/replace the channel logo merely to show a sponsor. LOWER_THIRD_FUTURE_FIT: add a validated payload union member later; do not expose it in 1003.4 core.

## Concurrency, manual controls and slate policy

CONCURRENCY_MODEL: One effective crawl, one effective scheduled sponsor, plus channel logo. Keep a candidate set; suppressing a winner does not erase the losing events. Recompute winners when an event expires, is disabled or is edited.

PRIORITY_MODEL: Among eligible same-type candidates, higher priority wins; then later startAt; then lexicographically smaller stable ID. Policy suppression is eligibility filtering before priority resolution. Exact endAt removes a candidate before selecting its successor. No dependence on array insertion order.

Spatial collision: channel-logo corner is reserved. If sponsor requests that corner, select the first free corner in fixed order top-right, top-left, bottom-right, bottom-left; publish the resolved position so every renderer agrees. Show a placement warning in the operator UI. Reserve a safe top/bottom band for active crawl and inset corner images inside the remaining safe area. Lower thirds retain their existing layer; warn on overlapping manual lower-third/crawl combinations rather than silently change their semantics. Use video-composite-relative geometry, not browser-window dimensions.

MANUAL CONTROL: Existing manual channel-logo controls remain separate. Scheduled SHOW NOW/HIDE NOW should call the overlay owner, not graphicsManager directly. Recommend follow-up controls with explicit timed overrides: SHOW starts the selected event for its original duration from now, HIDE suppresses that event through its effective end, and CLEAR OVERRIDE returns to schedule. Persist overrides separately with expiry and generation. Do not ship ambiguous sticky state. For the first scheduled crawl increment, scheduled winner takes precedence over existing manual crawl; when none is eligible the saved manual crawl is restored. UI must show that scheduling currently owns the slot; existing manual edits remain a draft, not a competing writer.

AUTOLIVE_POLICY: Events and clocks survive AutoLive TAKE, loss, recovery and return. No overlay engine dependency on ENTRY/LOSS timers or health callbacks. The compositor receives a presentation classification only.

ENTRY_SLATE_POLICY: Recommend suppress scheduled sponsor and scheduled crawl by default, preserving the preparation slate's readability. LOSS_SLATE_POLICY: recommend the same suppression, avoiding commercial content over a technical interruption. BREAK_POLICY: show scheduled overlays by default. Per-event show/suppress overrides may explicitly opt into technical slate display. Suppression changes only compositing eligibility; time continues and an event that expires while suppressed must not reappear. Existing channel logo/manual lower-third behavior stays unchanged; do not automatically add channel-logo graphics over technical slates.

Evidence requiring an adapter: `publishEntrySlate()` currently emits empty graphics/overlays; `createGraphics()` during LOSS returns only the reserved loss graphic. Thus retained visibility and Control z-order must be handled in one shared presentation projection. Do not alter AutoLive state transitions. Reserved ENTRY/LOSS IDs cannot be supplied by events. A dedicated scheduled DOM layer above the slate, below operator controls, permits explicit show overrides consistently without changing the slate itself.

## Program Output impact, Public, OBS and retained state

PROGRAM_OUTPUT_IMPACT: Full capabilities require an explicit contract extension. Recommend snapshot version 2 with a bounded optional `overlays.scheduled` resolved-state member; keep existing envelope identity/revision mechanics and the same SSE route. Update validators to accept legacy snapshot v1 and the new v2 form, preserving version instead of coercing it. The transport envelope can remain version 1 because its identity semantics do not change. This is nevertheless a protocol/schema change requiring review before implementation. Old readers reject v2: deploy publisher/server/subscribers together or add explicit capability negotiation; do not advertise mixed-version compatibility.

Resolved scheduled item fields: eventId, type, startAt, endAt, animationEpoch=startAt, validated effective payload (including resolved public image URL), effective position, and visibility policy result. Do not send full stored schedules, filesystem paths, private asset metadata or secrets to viewers. Preserve the existing manual crawl fallback and legacy graphics in the same snapshot. Changing overlays must preserve source, committedAt, playback/cue, publisherSessionId and media activation identity. Publish once per effective change, including an empty state at stop, never per animation frame.

PUBLIC_MODEL / OBS_MODEL: Use a shared scheduled DOM renderer and pure projection/animation helpers with Control. Key nodes by eventId and payload revision, so unrelated graphics revisions and Program TAKE do not reset crawl phase or reload logos. Derive normalized crawl phase from animationEpoch and the preset cycle duration; set local CSS/WAAPI phase on mount/resume/resize. Match logical phase across different viewport sizes using normalized composite geometry. Network delay and unsynchronized host clocks preclude a hard simultaneous-frame guarantee; use the existing wall-clock authority and report clock skew in operator diagnostics, not public output. A server-synchronized clock would be an explicitly separate enhancement.

RETAINED_STATE_MODEL: The existing server store retains the newest complete envelope and subscribers already bootstrap through it. New subscribers render active items immediately using current time and reject expired items even if no stop revision arrived. Subscriber expiration timers are presentation-only and cannot publish state or choose an unpublished next event. Reject stale/reordered revisions using the existing session guards. Clear scheduled DOM on empty/offline output as defined by the existing unavailable-output presentation.

RELOAD_RECOVERY_MODEL:
- Control reload / return from Scheduler: load persisted overlay events, initialize assets, recompute current winners at now and republish through the existing publisher session lifecycle. Never replay elapsed events or restart animation epoch.
- Scheduler reload: reload the editor store; never instantiate a second overlay publishing authority. Same-origin storage notifications update an already-open Control publisher.
- Public / OBS reload: retained complete snapshot, expiry check, immediate current visibility and phase; no refresh required for later updates.
- Server restart: retained ProgramOutputStore is empty. The connected/reconnected Control publisher must republish its current recomputed snapshot through existing transport recovery. The browser schedule survives a server restart in the same profile/origin; it is not server-persisted data.
- No Control publisher running: an already published event may display until its own endAt, but a future event cannot start until Control returns. This is an existing browser-authority limitation and must be shown in Scheduler. Navigation back recomputes correctly; uninterrupted autonomous overlay scheduling during closed-Control navigation is NOT guaranteed by this minimal architecture. If that is a mandatory acceptance criterion, add a durable server overlay authority and integrated output composition first; do not silently launch a second browser scheduler or claim support. This is an explicit scope decision before implementation, not a reason to weaken the accepted Program runtime.

## Asset lifecycle, security and performance

ASSET_LIFECYCLE: Reuse MediaLibraryManager/StudioAssetResolver; select managed image IDs. The legacy logo library's `logo` kind does not pass resolver expectedKind image; do not expand compatibility blindly. Resolve only at activation/catalog change with generation guards. Missing/deleted/unavailable assets hide only the sponsor and expose an operator-only status; never crash Program or modify saved events. Retry on library refresh, with no per-frame fetching. Decode failure removes broken-image UI and leaves crawl/Program intact. Include overlay references in deletion guards in both Control and Scheduler; server cannot enforce browser-only references without receiving them, so runtime missing-asset handling remains mandatory.

SECURITY_FINDINGS: Managed upload formats/signatures are enforced; SVG is absent, so no SVG sanitization guarantee exists. Use img, not object/iframe or injected SVG markup. Text uses textContent; enum styles and bounded numbers only. Current general HTTP(S) URL acceptance is broader than sponsor input needs: sponsor editor accepts assetId only, publisher resolves through managed media routes. Extend existing authenticated operator boundaries for any future server write endpoint. Bound counts, text, image dimensions and output payload; do not bypass existing HTTP payload limits to carry whole schedules.

PERFORMANCE_MODEL: At most one scheduled image plus one crawl node set; no new media decoders. Local transform animation, stable DOM, finite boundary timers, event-driven asset resolution and output publication. Distinct teardown ownership for store listener, image load/error callbacks, animation and expiry timer. Stale callbacks cannot revive an expired or overridden item.

## Implementation phases and expected files

IMPLEMENTATION_PHASES:
1. Contract/runtime foundation: validate store/time/collision rules, independent owner and manual arbitration; settle closed-Control execution requirement and v2 deployment. Pure fake-clock tests first. No visible feature enabled yet.
2. One end-to-end crawl slice: editor → runtime → Control → versioned output → Public/OBS including retained expiry and slate policy. Synchronization is part of this slice, not a later optional phase.
3. Managed sponsor slice: picker, asset lifecycle, geometry, size/opacity and coexistence; then integrated UX and all baseline regressions/manual matrix. Rotation and scheduled lower-third remain follow-up.

FILES_EXPECTED_TO_CHANGE (proposal only): new `scheduler/OverlayScheduleContract.js`, `OverlayScheduleStore.js`, `OverlayRuntimeEngine.js`, `ui/OverlayScheduleUI.js`, shared overlay projection/DOM renderer; `entries/control-room-app.js`, `entries/schedule-app.js`, Scheduler HTML/UI integration, `ui/StudioTextCrawlUI.js` arbitration; `studio/StudioGraphicsManager.js`/`renderers/StudioGraphicsLayer.js` narrow adapter and keyed updates; `program-output/ProgramOutputContract.js`, `ProgramOutputEnvelope.js` validation compatibility, `ProgramOutputManager.js`; shared `public/PublicProgramController.js`; relevant Control/Public CSS; media deletion-guard call sites and new tests. Avoid changes to AutoLive controllers, media surfaces, handoff, Scheduler scene engine, .env or runtime state. Server output validation uses the shared contract; any new server authority needs its own separately approved design.

Scheduler UX: separate PALINSESTO EVENTS and OVERLAY EVENTS panels with Add Overlay → TEXT CRAWL / LOGO-SPONSOR. Show name/preview, type, localized start/end, enabled and computed status: scheduled/active/suppressed/conflict/expired/missing asset. Reuse timezone editing and managed asset picker. No overlay rows masquerading as scenes. Distinguish saved from currently published and warn when the Control publisher is absent.

## Test plan

All proposed; no new executable tests or full-suite rerun is needed for this documentation-only audit. Existing 803-test result is historical baseline, not a new run.

| # | Scenario | Required assertion |
|---|---|---|
| 1 | Crawl start | Hidden at start-1 ms; visible at start |
| 2 | Crawl stop | Hidden at endAt, one state publication |
| 3 | Sponsor start | Resolve asset and show correct bounded geometry |
| 4 | Sponsor stop | Remove node and callbacks at endAt |
| 5 | Crawl + sponsor | Both rendered without extra media elements |
| 6 | Channel logo + sponsor | Distinct IDs; deterministic free-corner placement |
| 7 | AutoLive TAKE | Event identity/epoch/endAt unchanged |
| 8 | AutoLive return | Valid events remain; expired ones do not return |
| 9 | ENTRY | Default suppression and explicit show match all outputs |
| 10 | LOSS | Same policy without resetting grace/session/cue |
| 11 | BREAK | Default show and configured suppression |
| 12 | Public update | Same effective state, no refresh/player recreation |
| 13 | OBS update | Same state and geometry, audio policy unchanged |
| 14 | Late Public | Active retained state and phase; expired state hidden |
| 15 | Late OBS | Same late-join behavior |
| 16 | Control reload | Recompute at now; no elapsed replay or boot rewrite |
| 17 | Scheduler reload | Editor-only authority; persisted schedule intact |
| 18 | Disable active event | Immediate removal and eligible successor |
| 19 | Missing/deleted asset | Sponsor-only failure, safe diagnostic, event unmodified |
| 20 | Same-type overlap | One winner independent of insertion order |
| 21 | Priority ties | Priority, latest start, stable ID ordering |
| 22 | Exact expiry | Half-open intervals, simultaneous end/start deterministic |
| 23 | No Program mutation | Command/state spies see no scene or playback writes |
| 24 | Preview | No graphic/media/selection mutations |
| 25 | Normal TAKE | Existing five heavy-media/BREAK cases, CUT/DISSOLVE |
| 26 | AutoLive regression | 30s accumulation, debounce, 15s grace, same-session HLS recovery |

Additional gates: DST ambiguity/gap, midnight, invalid schema/no destructive writes, timer throttling/clock jumps, duplicate startup/teardown, stale asset callbacks, conflicting editor revisions, reserved IDs, unsafe URL/CSS/text, size/count limits, manual fallback arbitration, unchanged graphics revisions not restarting crawl, server reconnect republish, closed-Control limitation, v1→v2 compatibility/deployment, real retained SSE tests, same output geometry at different aspect ratios, offline expiration without a stop revision. Run the full existing suite, syntax/diff checks and manual Control/Public/OBS matrix before accepting implementation.

RISKS: browser-owned authority during navigation/outage; clock skew; mixed-version readers; animation resets from existing full-layer redraw; slate z-order differences; asset deletion races; manual/scheduled writer collisions. These are explicit implementation gates, not reasons to refactor accepted media behavior.

BLOCKERS: None for delivering this architecture audit. Before implementation, approve the proposed snapshot extension, slate defaults and browser-authority availability limitation (or scope a server authority). No permission to implement is inferred from this audit.

NEXT_STEP: REVIEW BUILD 1003.4 PROGRAMMABLE OVERLAY ARCHITECTURE BEFORE IMPLEMENTATION

LIVEZONE BUILD 1003.4 PROGRAMMABLE OVERLAYS ARCHITECTURE AUDIT COMPLETE
