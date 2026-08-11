# LIVEZONE Broadcast Engine Architecture

## Scope and status

This document describes the repository as it exists today. It does not treat
aspirational items in older roadmaps as implemented functionality.

**Implemented:** a static browser application that plays one configured HLS
stream, presents basic broadcast UI, automatically retries after fatal hls.js
errors, and exposes browser-side playback health through a BASIC operational
monitor.

**Not implemented:** server-side broadcast control, schedules, playlists,
multi-channel management, VOD, playout, ingest, transcoding, analytics, or a
production operations dashboard.

## Runtime topology

```text
public/index.html
  -> public/js/app.js
       -> core/Engine
            -> services/ConfigService -> public/config/config.json
            -> ui/BroadcastUI, OverlayController, NotificationCenter
            -> player/Player
                 -> player/HLSAdapter -> bundled hls.js or native HLS
                 -> player/StreamMonitor -> player/StreamHealth
            -> debug/DebugPanel <- Player.getHealth()
       -> core/AdaptivePlayer
```

`index.html` supplies the DOM shell and loads `lib/hls.min.js` before the ES
module application. `app.js` starts one Engine instance and starts the
responsive 16:9 `AdaptivePlayer` independently. The temporary viewport
diagnostics currently present in an uncommitted `app.js` working-tree change
are not part of this production architecture.

## Engine lifecycle

`Engine.start()` is the active startup coordinator:

1. Initializes `LifecycleManager` and emits `engine:start`.
2. Loads `public/config/config.json` through `ConfigService` and emits
   `config:loaded`.
3. Starts the broadcast UI and creates overlay and notification UI.
4. Emits `ui:ready`.
5. Creates and awaits `Player.init()`.
6. Renders and attaches `DebugPanel` to that initialized Player.

`LifecycleManager` maps selected events into `StateManager` states: `BOOT`,
`INIT`, `CONNECTING`, `ONLINE`, `BUFFERING`, `OFFLINE`, and `ERROR`.

There is currently no Engine-level stop or destroy lifecycle. The Player,
debug panel, clock, and UI subscriptions therefore do not have a single
coordinated cleanup owner.

## Player and stream lifecycle

`Player` validates the video element and the configured `stream.primary` URL,
then asks `HLSAdapter` to connect and starts `StreamMonitor`.

`HLSAdapter` uses hls.js where Media Source Extensions are supported. On
browsers that advertise native HLS support, it assigns the URL directly to the
video element. It enables hls.js low-latency mode and keeps a 90-second back
buffer. Fatal media errors receive a recovery attempt; other fatal errors mark
the stream offline, destroy the hls.js instance, and retry after five seconds.

`StreamMonitor` listens to HTML video `playing`, `waiting`, `stalled`, and
`error` events and emits stream events. It polls every five seconds;
`StreamHealth` derives current playback, buffer, media, and resolution data
from the video element.

## Event and state model

The active engine imports `core/Events.js` and uses the singleton
`core/EventBus.js`. The principal active stream events are:

- `stream:ready`
- `stream:buffering`
- `stream:reconnect`
- `stream:offline`
- `stream:error`

The repository also contains `CoreEvents.js` and `EventTypes.js`, plus several
additional state definitions. They are not the active authority and should not
be used for new work until the event/state model is consolidated.

## Presentation layer

- `BroadcastUI` updates the visible connection status, LIVE badge, and clock.
- `OverlayController` shows a local reconnect/offline/error overlay.
- `NotificationCenter` shows one transient notification at a time.
- `DebugPanel` polls real Player health every 500 ms. Its BASIC fields include
  Engine state, Player adapter state, derived playback state, buffer,
  resolution, live/VOD classification, media ready/network states, mute,
  volume, and audio/video presence. Live/VOD remains a browser-derived
  classification; it is not a verified stream-semantic indicator.
- The monitor starts hidden. The permanent status-bar `MON` control toggles it
  on desktop and mobile; desktop F2 also toggles it. There is no floating MON
  button and no collapsed monitor state.
- `layout.css` owns `--header-height` and `--status-height`; `ticker.css` owns
  `--ticker-height` and all active ticker styles.

## Responsive layout and player sizing

`#app` keeps `height:100vh` as a fallback and uses `height:100dvh` where the
browser supports it. Its content row uses `minmax(0, 1fr)` and `.main` can
shrink with `min-height:0`. The root does not force `width:100vw`.

`AdaptivePlayer` observes the `.main` container with `ResizeObserver` and
retains `window.resize` as a fallback. It subtracts computed `.main` padding
from the client dimensions before fitting a 16:9 wrapper. These changes only
size the presentation wrapper; they do not play, pause, reconnect, reload, or
otherwise change Player playback behavior.

Normal Safari and Chrome browser use is working with this layout. iOS Home
Screen/standalone portrait-to-landscape rotation can still produce a
viewport-position issue. That issue is deferred and is not represented as
resolved here.

## Configuration and admin boundary

The active browser client fetches `public/config/config.json`. A separate PHP
endpoint at `admin/api/config.php` reads and writes `config/config.json`.
These are distinct files; changing the admin-managed file does not change the
configuration fetched by the browser application.

The current config declares channel metadata, one primary stream, an unused
backup field, player flags, and UI flags. The active runtime consumes the
primary stream; not every declared field is currently applied.

## Repository boundaries

- `public/` contains the browser application and static assets.
- `admin/` contains a minimal PHP admin/API proof of concept.
- `config/` contains the separately managed JSON file.
- `docs/` contains project documentation and historical notes.
- `public/js/Debug-player-engine-fixed/` is an unreferenced development copy,
  not an active runtime module.

## Planned architecture direction

The existing code supports evolving the browser client toward a clearer
engine/player/UI separation. That work must begin by defining one event
registry, one lifecycle state model, one configuration authority, and explicit
cleanup semantics. Server-side broadcast capabilities remain future work and
must not be represented as present in the client architecture.
