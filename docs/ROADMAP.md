# LIVEZONE Broadcast Engine Roadmap

## Status key

- **Implemented:** present in the active repository.
- **Planned:** intended work; not present as a supported capability.
- **Decision required:** work that must not begin until an architectural choice
  is approved.

## Current implemented baseline

- Static browser viewer with an HTML video element and bundled hls.js.
- One primary HLS stream loaded from `public/config/config.json`.
- Native HLS fallback where the browser supports it.
- Browser-side stream monitoring, reconnect after fatal hls.js failures,
  status UI, overlay, notifications, viewport-safe responsive player sizing,
  and a real-data BASIC operational monitor.
- Hidden monitor controlled by the status-bar `MON` button on all devices and
  F2 on desktop; no floating MON button.
- Ticker styles and `--ticker-height` are owned by `ticker.css`; header and
  status height tokens are owned by `layout.css`.
- Minimal PHP status/config endpoints, separate from the browser’s active
  configuration file.

## Priority 1 — Stabilize the existing client

**Status: Planned**

- Consolidate event registries and state models into one supported contract.
- Define Engine, Player, UI, and debug-monitor startup/shutdown ownership.
- Remove or formally retire duplicate and unreferenced runtime copies.
- Apply and validate the existing configuration fields consistently.
- Define native-HLS and hls.js readiness/error/reconnect behavior as one
  lifecycle.
- Resolve the deferred iOS Home Screen/standalone portrait-to-landscape
  viewport-position issue. Normal Safari and Chrome browser use is working.

## Priority 2 — Establish engineering and configuration foundations

**Status: Planned**

- Select one authoritative configuration location and management flow.
- Define configuration schema validation, revisioning, and safe updates.
- Establish dependency, build, linting, test, and release practices.
- Secure state-changing admin operations before treating them as production
  capabilities.
- Define operational logging and browser playback telemetry requirements.

## Priority 3 — Improve the channel experience

**Status: Planned**

- Make UI behavior consistently driven by the canonical engine state.
- Extend the BASIC monitor only with additional real, capability-checked
  telemetry; do not invent FPS, bitrate, latency, retry, or dropped-frame
  values.
- Define accessible and capability-aware mobile presentation behavior.
- Decide the supported player-control, fullscreen, audio, and fallback policy.

## Priority 4 — Define broadcast-domain scope

**Status: Decision required**

- Define the domain model for channels, sources, schedules, playlists,
  overlays/scenes, and operator actions.
- Decide which functions belong in the browser client versus server-side
  services.
- Define the required media delivery capabilities: ingest, packaging, origin,
  CDN, recording/DVR, redundancy, and observability.

None of these capabilities are implemented in the current repository.

## Priority 5 — Deliver approved broadcast capabilities incrementally

**Status: Planned after Priority 4 decisions**

- Add only approved, server-backed domain capabilities with a documented API,
  lifecycle model, operational ownership, tests, and monitoring.
- Sequence future channel/scheduling/playlist/overlay/dashboard work by
  operational value rather than by UI availability.
