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

The Control Room and Scheduler require a separate operator login. Configure
`LIVEZONE_OPERATOR_USERNAME` and exactly one of
`LIVEZONE_OPERATOR_PASSWORD` or `LIVEZONE_OPERATOR_PASSWORD_SCRYPT`. The
publisher token remains an independent capability and is never accepted as an
operator password. Local HTTP development must explicitly set
`LIVEZONE_OPERATOR_COOKIE_SECURE=false`; production keeps the secure-cookie
default and sets `LIVEZONE_OPERATOR_ALLOWED_ORIGINS=https://www.livezone.it`.

The preferred password verifier uses Node's built-in scrypt in this exact
format:

```text
scrypt$16384$8$1$<base64url-salt>$<base64url-64-byte-digest>
```

Generate it in an operator-controlled environment without committing or
logging the password or resulting environment file. Plaintext
`LIVEZONE_OPERATOR_PASSWORD` is supported for local operation only. Setting
both password forms makes authentication unavailable rather than choosing one.

Generate the verifier interactively with
`node tools/generate-operator-password-hash.mjs`. The helper accepts no password
argument, hides terminal input, and prints only the verifier. Production HTTPS
behind a reverse proxy must configure `LIVEZONE_OPERATOR_ALLOWED_ORIGINS` with
the exact public origin because forwarded headers are not trusted.

Sessions are memory-only, expire after eight hours by default, are swept on
session access/creation, and are capped at 64 concurrent entries. Capacity
fails closed without evicting a valid session. Sessions are invalidated by
`POST /api/operator/logout`. The cookie is HttpOnly,
SameSite=Strict, path `/`, and Secure unless explicitly disabled. Media Library
mutations additionally require exact-origin validation, an application marker
header, and the per-session CSRF value returned by the sanitized session API.

`LIVEZONE_OPERATOR_AUTH_DISABLED=true` is an explicit development-only bypass.
It is never inferred from localhost or `NODE_ENV`, and must not be used on a
shared or public listener. Startup rejects this setting unless
`LIVEZONE_HTTP_HOST` is explicitly `127.0.0.1`, `localhost`, or `::1`.

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
- Operator credentials supplied separately from the Program Output token;
  production uses an scrypt verifier, Secure session cookie, and the exact
  canonical operator origin.
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
