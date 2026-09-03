# LIVEZONE Network Program Output v1

Sprint 6L distributes Program state, not media bytes. Public devices load the
HLS, MEDIA, AUDIO, Still and logo URLs contained in the validated snapshot.

## Development

Static servers continue to serve `public/config/program-output.json` in
`local` mode. For cross-device network mode, run the native Node server:

```powershell
$env:LIVEZONE_PROGRAM_OUTPUT_TOKEN="replace-with-a-long-random-secret"
npm run serve
```

Open Control and Public from the server address, for example
`http://192.168.1.20:8080/control/` and `http://192.168.1.20:8080/`. Before
starting Control, provision the publisher credential in that Control browser
session (never commit it):

```js
sessionStorage.setItem(
    "livezone.programOutput.token",
    "replace-with-a-long-random-secret"
);
```

The Node server exposes network mode dynamically at
`/config/program-output.json`; ordinary static hosting retains explicit local
mode. A missing publisher token produces `publishing-error` and never affects a
Studio TAKE.

## Production requirements

- Node.js 20+ persistent process with `npm run serve`.
- `LIVEZONE_PROGRAM_OUTPUT_TOKEN` supplied by the process environment or secret
  manager; at least 16 characters and never served to Public clients.
- HTTPS at the reverse proxy for Internet deployment.
- Proxy buffering disabled for `/api/program-output/events`; long-lived SSE
  connections and appropriate idle timeouts enabled.
- Control and Public should normally use the same origin. If Control is hosted
  elsewhere, list exact trusted origins in comma-separated
  `LIVEZONE_ALLOWED_ORIGINS`; wildcard publisher CORS is not emitted.
- Media and graphic URLs must be reachable from every Public device. Do not use
  Control-PC-only `localhost`, `file:` paths, or private paths inaccessible to
  viewers.

## Runtime configuration and health

The Node listener defaults remain development-compatible: `LIVEZONE_HTTP_HOST`
defaults to `0.0.0.0` and `PORT` defaults to `8080`. Set the host to
`127.0.0.1` when a same-host reverse proxy is introduced in a later Phase 2C
block. Invalid host or port values fail startup instead of falling back.

`GET /healthz` is pure Node process liveness. It returns HTTP 200 whenever the
server can answer, regardless of MediaMTX, OBS or HLS state.

`GET /readyz` checks application readiness. Writable Media Library storage is
required and its failure returns HTTP 503. Program Output is ready once the
server is initialized. MediaMTX Control API availability is an optional ingest
dependency: its failure returns a sanitized HTTP 200 `degraded` result because
the web/control and recorded-media application remains usable. An offline OBS
publisher, including the expected HLS 404 while no publisher exists, does not
make the application unready. Live ingest state remains available separately
from `GET /api/media-ingest/status`.

Neither endpoint returns configured URLs, filesystem paths, environment values,
credentials, tokens or stack traces. See `.env.example` for the supported
non-secret runtime configuration contract.

Retention is in memory. A server restart loses the retained snapshot. Connected
viewers keep their last valid Program while EventSource reconnects; Control must
publish another meaningful revision (or restart its publisher session) after a
server restart. One active publisher session is retained. The first valid
revision from a previously unseen session replaces the active session in server
arrival order; the prior session is then retired so delayed messages cannot
reclaim authority.

MEDIA/AUDIO timing uses transferable UTC timestamps and assumes reasonably
synchronized device clocks. Network and clock skew make playback approximate,
not frame-accurate.
