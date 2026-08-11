# LIVEZONE Repository Rules for AI-Assisted Changes

## Source of truth

- Treat the active browser path as `public/index.html -> public/js/app.js ->
  public/js/core/Engine.js`.
- Confirm imports before changing a module. Files under
  `public/js/Debug-player-engine-fixed/` are not part of the active runtime.
- Do not infer that a feature exists because it appears in a roadmap,
  architecture vision, TODO file, or unused module.
- Describe current behavior as **implemented** and future work as **planned**.

## Architectural guardrails

- Preserve the separation between Engine startup, Player coordination,
  HLS adaptation, stream monitoring, and UI presentation.
- Use the existing EventBus mechanism for cross-component stream signals;
  do not introduce another event bus or state registry.
- Before expanding events or states, reconcile the existing competing
  registries (`Events`, `CoreEvents`, and `EventTypes`) as a deliberate,
  scoped architectural change.
- Do not add broadcast-control, scheduling, VOD, multichannel, or playout
  claims to runtime documentation unless the implementation is added.
- Every timer, DOM listener, EventBus subscription, or media resource added by
  a change must have a defined cleanup owner.
- Keep monitor values tied to real runtime data. Do not add placeholder FPS,
  bitrate, latency, retry, or dropped-frame values.
- Keep monitor visibility separate from monitor telemetry: the status-bar
  `MON` button controls visibility, and F2 is desktop-only. Do not restore a
  floating MON button or collapsed-state behavior without explicit approval.

## Configuration and security

- The active browser fetches `public/config/config.json`.
- `admin/api/config.php` currently writes the separate root
  `config/config.json`; do not assume admin updates reach the browser.
- Do not add unauthenticated state-changing endpoints or expose secrets in
  browser configuration.
- Validate configuration and external input at boundaries. Do not insert
  dynamic values with `innerHTML`.

## Change discipline

- Do not modify `public/lib/hls.min.js` by hand.
- Preserve native-HLS fallback, `playsinline`, and responsive behavior unless a
  request explicitly changes them.
- Keep `layout.css` as the owner of header/status height tokens and
  `ticker.css` as the owner of ticker height and active ticker styles.
- Treat viewport diagnostics in `app.js` as temporary investigation code; do
  not document or commit them as production behavior without approval.
- Prefer small, focused changes and avoid mixing refactors with feature work.
- Do not overwrite unrelated uncommitted user changes.
- Update relevant documentation when lifecycle, configuration authority, or
  public behavior changes.
- Verify changes proportionally to risk and report checks performed.
