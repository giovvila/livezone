# LIVEZONE Broadcast Engine — REPORT-001

## Scope
Reviewed the active runtime chain:

`app.js -> Engine -> Player -> HLSAdapter -> StreamMonitor -> StreamHealth -> DebugPanel`

## Confirmed findings

1. `public/js/app.js` creates one active `Engine` instance. The earlier block at the top is inside a block comment.
2. `Player.js` imports `./StreamMonitor.js`, therefore `public/js/player/StreamMonitor.js` is the active monitor. `public/js/services/StreamMonitor.js` is not imported and currently contains only `// TODO`.
3. `Engine.start()` is already `async`.
4. In the original `Engine.js`, `debugPanel.attach(this.player)` ran before `this.player = new Player(...)`. The panel therefore stored `null` and its timer could never reach `getHealth()`.
5. The original Engine called the async `player.init()` without `await`.
6. `Player.init()` starts `StreamMonitor` after `await adapter.connect(...)`.
7. `HLSAdapter.connect()` resolves after HLS listeners are installed (not after playback becomes ready). Awaiting `Player.init()` is nevertheless sufficient to guarantee that `StreamMonitor.start(video)` has executed before the DebugPanel attaches.
8. The original Engine injected fake/static Inspector values (`2.80 s`, `1920×1080`). These have been removed.
9. `StreamHealth.js` contained duplicate object keys (`duration`, `playbackRate`, `seeking`, `muted`, `volume`, `videoWidth`, `videoHeight`, `isLive`). They were consolidated without changing the names used by DebugPanel.
10. `public/js/Debug-player-engine-fixed/` is not imported by the active application and is treated as a development copy.

## Fix

Runtime order is now:

`Config -> UI -> Player creation -> await Player.init() -> DebugPanel render -> attach(real Player) -> show`

DebugPanel now validates the Player, performs an immediate refresh, refreshes every 500 ms, and exposes `detach()` to clear its timer safely.

## Files changed

- `public/js/core/Engine.js`
- `public/js/debug/DebugPanel.js`
- `public/js/player/StreamHealth.js`

## Reviewed but unchanged

- `public/js/player/Player.js`
- `public/js/player/StreamMonitor.js`
- `public/js/player/HLSAdapter.js`
