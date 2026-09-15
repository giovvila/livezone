# BUILD 1003.4 — Runtime checkpoint

Final consolidated state, 2026-09-15. Branch: `build/1003.4`. Source baseline and pre-checkpoint HEAD: `e249fa040b3ff5a94f00dd7efdcc978cd656d8f3` (build 1003.3). Feature development for 1003.4 is closed. This checkpoint consolidates the validated implementation; it does not start the next build.

The operator's final manual validation is authoritative and supersedes intermediate BLOCKED decisions in the retained A–D3 audits, including safe DELETE and Scheduler Media Library expansion. Those documents remain engineering evidence, not current release status.

## Final socket-pool validation addendum — 2026-09-15

The operator's subsequent authoritative retest validates the primary Control socket-pool fix. Control now owns one authenticated shared SSE instead of four persistent streams; Program Output consumers, reference presence and Scheduler state share that document-scoped connection. Public and OBS remain independent consumers. See the [socket-pool audit](BUILD-1003.4-CONTROL-SOCKET-POOL-SATURATION-AUDIT.md) for ownership, implementation, restart and verification details.

Manual PASS: Control + MEDIA B large Program; Control + MEDIA B + Public; the same with small VIDEO Preview; Control + MEDIA B + Public + OBS software; long audio-12 + Public; normal VIDEO + Public; normal TAKE / continuity; sustained MEDIA B playback.

Socket-fix implementation verification previously passed 19/19 new tests and 1467/1467 full-suite tests. Final consolidation staging is now explicitly authorized; commit and push remain unauthorized. The historical 117-file index is superseded by the exact final inventory below.

## KNOWN NON-BLOCKING LIMITATIONS

With **audio-12 in Program + MOTION ARTWORK**, Control Room, Public and **OBS software PASS**. The **OBS web page as an additional tab in the same Edge browser FAILS**.

Record this as an accepted same-browser connection/resource boundary, **not a BUILD 1003.4 blocker**. OBS software is the intended operational consumer of `/output/obs/` and works correctly. No new precise internal mechanism is established by this observation alone. Do not modify production code for it in the current checkpoint, reopen MP4 seek/preload/Range investigation, or weaken the validated shared Control Event Stream architecture. The primary socket-pool fix is manually validated.

## Scheduler and Program execution

The sole timing authority is server `SchedulerServer` / `ScheduleAuthority`, backed by server `ScheduleStore`. The server clock resolves active events, deterministic per-type winners and deadlines; one bounded timer reconciles at deadlines and at most a one-second interval. Persisted revisions and atomic replacement protect schedule updates. Startup hydrates and reconciles without a browser. The single-owner guard is process-local, not a distributed scheduler lock.

Authenticated `/api/studio/schedule` and its event/Program-plan routes provide revision-checked mutations; private `/api/studio/schedule/events` SSE provides server session/generation and active-state updates. Both browser entry points import `ServerScheduleStore`, using `ScheduleApiClient` for API/SSE. Legacy local schedule import is limited to a pristine server domain and preserves the original local data. Storage events do not execute the production schedule. UI clocks and overlay expiry guards render state; they do not create scheduling authority.

**PROGRAM EXECUTION SUSPENDED.** Server summaries can mark Program items ACTIVE but never execute autonomous TAKE. Control explicitly constructs the compatibility `SchedulerEngine` with `programExecution:false`; its reconciliation returns before scheduled commands/timers. The engine remains for existing AutoLive/interruption interfaces and regression coverage. Production scheduling requires a future executor independent of browser renderers; this build is not autonomous Program playout.

## Overlays and output

`EffectiveProgramOutput` is the sole server merge owner. It combines the retained accepted Program with scheduled crawl and Sponsor in separate fields. Manual crawl remains operator-owned and takes precedence when enabled; scheduled crawl resumes under its original interval. Sponsor has independent state, image identity and timing, with CORNER/FULLSCREEN layouts and CONTAIN/COVER fullscreen fit. Channel Logo and existing lower third remain separate graphics.

Control observes the effective output; Public and OBS consume the same composite. Each crawl/Sponsor view retains its own node and expiry timer, preserving crawl animation phase when the other layer changes. ENTRY/LOSS suppress scheduled layers; BREAK allows them. Recovery restores only still-scheduled overlays. Layer order is base, channel graphics (1), lower third (2), Sponsor (3), crawl (4); technical loss presentation remains above them (100).

The merge preserves base scene/source/playback identity and does not command Program or Preview. Missing base does not invent a Program publisher. Missing/invalid Sponsor removes only that optional layer; invalid optional output falls back to accepted base. Control publication cannot write server-owned scheduled fields or silently erase active overlays. Server composite ordering is distinct from publisher ordering, with stale-session/revision gates. Public/OBS retain the media instance for unchanged activation/source, so overlay-only changes do not restart playback.

Program Output retains version 1 with validated optional composite ordering, schedule metadata and Sponsor fields introduced by this build. These are intentional build extensions, not an assertion that the protocol file is unchanged from 1003.3. No protocol redesign was made during consolidation.

## Operator workspace and shared library

Scheduler uses the existing PROGRAMMA editor plus TEXT CRAWL and SPONSOR modes. Sponsor selection uses canonical shared Media Library asset IDs and supports transparent images. Configured Sources, Live Sources and Media Library are independently collapsible. `ScheduleWorkspacePanels` binds before authentication/network bootstrap; MediaLibraryUI has no second Scheduler collapse owner. Existing preference keys, filters, uploads and selection survive rerenders/SSE updates.

Control and Scheduler use one `MediaLibraryClient`/backend repository. Upload, metadata refresh, gallery, Sponsor picker and delete synchronization share asset identity and BroadcastChannel invalidation. There is no Scheduler-only media repository.

## Safe DELETE and reference authority

Final manual acceptance: UNUSED asset deletion succeeds; Sponsor- and Program/Preview-referenced assets are USED and blocked; Control/Scheduler synchronize after deletion. UNKNOWN remains blocked. No force-delete exists.

`AssetReferenceInventory` includes server Studio sources/scenes, all retained schedule references, legacy aliases, configuration, retained/effective Program, Channel Logo and independent Preview ownership. Current reference writes validate asset existence/type through the shared `AssetMutationCoordinator`. DELETE repeats its audit inside that same boundary; a prior UI audit cannot authorize a raced deletion. Asset IDs, owned file paths and links are checked. Journal/quarantine recovery protects interrupted metadata/file operations; recovery uncertainty blocks further deletion. Runtime journals and quarantine contents are excluded from this checkpoint.

Current supported v3 clients with server-proven invalidated credentials are classified `HISTORICAL / NON-AUTHORITATIVE` and do not permanently veto unrelated unused assets. Their submitted/pending references are retained. Silence, age or shared login alone is insufficient. Valid unreconciled clients and unsupported legacy implementations remain conservative vetoes. Reauthentication/resume re-enters current reconciliation. Preview/Program/logo ownership remains independent and conservative; historical classification never erases runtime ownership.

Safety assumes the existing single server owner and coordinated mutation paths, not arbitrary external file edits. A global unresolved authority can still yield UNKNOWN; the implementation does not promise per-asset certainty when a real writer can reference arbitrary assets.

## Protected behavior and manual acceptance

The operator confirms VIDEO and AUDIO Program continuity across Control → Scheduler → Control, cue/playback continuity, preserved Preview, and ARMED AutoLive not replacing retained Program. Retained identity restoration precedes cue reconstruction and validates source identity; navigation-induced hidden pauses do not overwrite the retained playback clock.

Accepted AutoLive baseline remains ENTRY 30 seconds, short LOSS recovery to LIVE, and persistent loss over 15 seconds returning to previous Program. Public/OBS and bounded HLS recovery pass without periodic slate flashes. Normal VIDEO/AUDIO TAKE, heavy VIDEO transitions, AUDIO with motion artwork, Preview→Program handoff, covered CUT/DISSOLVE behavior and cues remain protected.

The final manual baseline also validates server scheduling with Control closed, Control/Public/OBS crawl and Sponsor, Sponsor+crawl+logo coexistence, independent timing, suppression/BREAK behavior, editor modes, shared uploads/gallery/picker, panel expansion and safe deletion. No browser DELETE or other production mutation was repeated during consolidation.

## Diagnostics and compatibility review

KEEP: bounded payload-free ScheduleDiagnostics (100 by default, maximum 1000), AssetAuthorityDiagnostics (production default 100, allowlisted counters/status), and local bounded RuntimeTrace hooks for continuity/identity/overlay acceptance. Tests cover diagnostic bounds and omission of secrets/payloads. No demonstrably obsolete one-off production diagnostic required removal; runtime exports/logs are preserved but excluded.

KEEP compatibility: old browser ScheduleStore is not imported by production entry points; disabled scheduled-execution branches remain covered for AutoLive/legacy interfaces. CrawlScheduleUI and MediaReferenceAudit are retained test-covered compatibility/reconstruction artifacts, not active production owners. Legacy import, retained-identity rejection/fallback and node expiry guards remain necessary. Old 60-second diagnostic filenames are excluded runtime history; production ENTRY policy is 30 seconds. No temporary permissive production delete guard or duplicate active Sponsor/crawl merger was found.

## Verification and checkpoint contents

Final selection: **149 files** (80 production/dependencies, 37 tests, 32 documents). Exact classification, exclusions and staging additions are recorded in [checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json). All intermediate documents retain useful design, test or capture provenance and are explicitly marked historical; their previous BLOCKED outcomes do not override final operator acceptance.

After staging the exact accepted source/test set:

- Focused suites: **990/990 PASS**, zero failures/cancelled/skipped (73.907 s).
- Full `node --test`: **1467/1467 PASS**, zero failures/cancelled/skipped (70.008 s).
- All **111 staged JavaScript files**: `node --check` PASS.
- `git diff --check` and `git diff --cached --check`: PASS.
- Exact index/inventory equality and staged/worktree blob equality are final integrity gates; consolidation changes documentation only, with source/test/.env hashes preserved.
- Excluded classification: **342 runtime/generated files**, **5 operator media files**, no unrelated or uncertain files. Exact paths are in the inventory.
- Evidence logs: `var/final-consolidation/{focused,full,syntax,diff-check,cached-diff-check}.log`; final count/hash and equality results: `var/final-consolidation/final-integrity.json`. These generated artifacts are excluded from staging.

The original 117-file checkpoint and index SHA-256 `30EC624644113BF6546C23334B5806DFFA6FDCBC46C50BA331889982888BAD56` are historical references. Only exact A/B/C paths are staged. Runtime captures/logs/state, secrets, .env and the five explicit operator-media paths are preserved and excluded. No production code changes or runtime actions are part of this consolidation. jsdom is a test-only dependency.

KEEP: ControlMediaResources is disabled by default, loopback diagnostic only, with bounded resource/event collections, explicit release and rate-limited observations. RuntimeTrace retains bounded local events and exports a bounded Resource Timing snapshot without adding requests or observers. Technical passive retry backoff is bounded while authoritative health demand preserves the validated recovery cadence. Public BFCache/terminal reconnect/failed-bootstrap cleanup remains included.

Shared-stream consolidation does not obsolete native Public/OBS transports, standalone Scheduler transport, publisher writes, or test-covered compatibility paths. No proven unreachable implementation requires removal.

Locked for the next build: server schedule ownership and revision rules; suspended Program execution; effective-output merge/order; independent overlay layers; coordinated reference/delete safety; Preview ownership; shared library identity; retained Program continuity; accepted AutoLive timings and TAKE/handoff behavior. Any future change needs an explicit new scope and regression evidence.

Next step: REVIEW FINAL STAGED BUILD 1003.4 THEN AUTHORIZE COMMIT.
