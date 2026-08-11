# Code Style and Repository Conventions

## Scope

These conventions apply to future changes. They describe the repository’s
current browser-module architecture and deliberately do not claim that all
existing files already conform.

## JavaScript

- Use ES modules and one default export for component classes where that is the
  established local pattern.
- Keep one responsibility per module. The active code separates engine
  startup, player coordination, HLS adaptation, stream monitoring, and UI.
- Use descriptive class names and file names that match the exported class.
- Validate DOM elements and required configuration at component boundaries.
- Bind event handlers that need instance state, and remove them during the
  component’s cleanup lifecycle.
- Make lifecycle starts idempotent when a component owns listeners or
  observers. Disconnect `ResizeObserver` instances during cleanup.
- Keep asynchronous startup explicit: callers that depend on initialization
  must await it.
- Prefer `Logger` for application diagnostics. Do not add temporary console
  output to committed code.
- Do not add a second event registry, state model, or player abstraction.
  Extend the canonical ones only after they are formally consolidated.
- Do not use `innerHTML` with dynamic/external values. Create DOM elements and
  assign user-controlled text through text properties.

## Events and state

- Event names use lowercase, colon-separated strings, for example
  `stream:ready`.
- Event payloads must be documented at their definition and remain stable for
  subscribers.
- State changes must have an identified owner. UI components consume state;
  they must not independently redefine engine or player state.
- Every recurring timer, EventBus subscription, DOM listener, and media
  resource requires a corresponding cleanup path.

## CSS and markup

- Keep layout, player, branding, status, ticker, overlay, notification, and
  debug styles in their dedicated CSS modules.
- `layout.css` owns `--header-height` and `--status-height`; `ticker.css` owns
  `--ticker-height` and active ticker styling. Responsive declarations within
  those owner files are intentional.
- Reuse theme custom properties rather than creating duplicate literals for
  established colors, dimensions, z-index levels, or transitions.
- Build responsive behavior with layout rules and capability-aware behavior,
  not JavaScript user-agent detection.
- Preserve `playsinline`, touch target sizing, viewport safety, and safe-area
  support when changing mobile-facing markup or CSS.
- Keep `100vh` fallbacks when using `100dvh`, and ensure flexible grid/flex
  children can shrink before adding component-level mobile workarounds.
- Size the player from the usable container content box; do not change media
  playback behavior to solve layout problems.
- Avoid introducing styles for selectors absent from the active HTML unless
  they are added in the same scoped change.

## Configuration and PHP

- Treat JSON configuration as data with a defined schema; validate required
  fields before consuming or persisting it.
- Do not create another configuration location. Changes must identify the
  single intended authority.
- PHP endpoints must return an explicit content type and validate request
  methods and payloads. Any endpoint that changes configuration requires an
  approved authentication, authorization, and audit design before production
  use.

## Documentation and change scope

- Document implemented behavior as implemented and future work as planned.
- Update `ARCHITECTURE.md` when runtime boundaries or lifecycle ownership
  change; update `DECISIONS.md` when a significant technical direction is
  approved.
- Keep commits focused. Runtime code, generated/vendor files, configuration,
  and documentation should not be mixed without a clear reason.
- Treat temporary diagnostics as local investigation tooling. Do not describe
  them as production architecture or commit them without explicit approval.
- Do not edit `public/lib/hls.min.js` manually; update the upstream dependency
  through an agreed dependency-management process.
