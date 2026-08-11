# Architecture Decisions

This is a record of decisions visible in the current repository. “Observed”
means the behavior is implemented; it is not a claim that a formal decision
process previously occurred.

## ADR-001: Browser-first static delivery

- **Status:** Observed
- **Decision:** The viewer is delivered from `public/` as static HTML, CSS,
  JavaScript modules, assets, and a bundled hls.js library.
- **Evidence:** `public/index.html` is the runtime entry point and no frontend
  build manifest or package configuration exists.
- **Consequence:** Deployment is simple, but dependency management, repeatable
  builds, test automation, and release metadata are not yet established.

## ADR-002: HTML video is the playback substrate

- **Status:** Observed
- **Decision:** Playback is built around the native `<video>` element, with
  hls.js used as an adapter where supported.
- **Evidence:** `Player`, `HLSAdapter`, `StreamMonitor`, and `StreamHealth` all
  center on `#video`.
- **Consequence:** Native browser media events and health information are
  available. The client remains a playback endpoint rather than a playout or
  media-processing system.

## ADR-003: Native HLS fallback is retained

- **Status:** Observed
- **Decision:** If hls.js/MSE is unavailable and the video element can play
  `application/vnd.apple.mpegurl`, the source is assigned directly to video.
- **Consequence:** Safari/iOS compatibility is considered. Native and hls.js
  startup/error behavior still need a unified lifecycle contract.

## ADR-004: Cross-component signals use a shared EventBus

- **Status:** Observed, incomplete
- **Decision:** UI and lifecycle components react to stream events through
  `EventBus` rather than direct calls.
- **Consequence:** The approach reduces coupling. Multiple competing event
  registries currently prevent it from being a reliable repository-wide
  contract.

## ADR-005: Browser-derived health powers the inspector

- **Status:** Observed
- **Decision:** The debug panel reads Player health derived from the live video
  element instead of static display values.
- **Consequence:** The inspector reflects Engine/adapter state, derived
  playback state, buffer, dimensions, live/VOD classification, media states,
  mute/volume, and audio/video presence. It does not currently report origin,
  CDN, ingest, or broadcast control-plane health. Live/VOD classification is
  not a guarantee of stream semantics.

## ADR-006: Configuration is loaded at startup

- **Status:** Observed, inconsistent storage boundary
- **Decision:** `ConfigService` fetches JSON during Engine startup before
  Player initialization.
- **Consequence:** Stream selection is runtime-configurable. The browser and
  PHP admin endpoint currently use different config files, so there is no
  authoritative management path.

## ADR-007: Monitor visibility is status-bar controlled

- **Status:** Observed
- **Decision:** The monitor is hidden initially. The permanent status-bar
  `MON` button toggles visibility on all devices; F2 does so on desktop.
- **Consequence:** The old floating MON button and collapsed monitor state are
  removed while desktop drag support remains available.

## ADR-008: Layout sizing follows the available container

- **Status:** Observed
- **Decision:** The root uses `100vh` with a `100dvh` capability override and
  does not force `100vw`. `AdaptivePlayer` observes `.main` and fits 16:9
  dimensions within its content box.
- **Consequence:** Layout sizing is separated from playback behavior. Normal
  Safari and Chrome browser use works; the iOS standalone rotation positioning
  issue remains deferred.

## Proposed decisions requiring approval

The following are not implemented decisions. They are recorded only as
decision topics for future work:

1. Adopt one event vocabulary and one canonical state machine.
2. Define an Engine shutdown/destroy contract and lifecycle ownership rules.
3. Select one configuration authority and secure its management interface.
4. Define retry, failure classification, and backup-stream policy.
5. Establish package, build, test, and release standards before adding major
   broadcast-domain features.
