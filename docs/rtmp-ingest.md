# LIVEZONE local RTMP ingest — Phase 1A

Phase 1A is pinned to **MediaMTX v1.20.1**. Do not use an unpinned `latest`
binary. MediaMTX is an external media service; RTMP never enters a browser or
the LIVEZONE Program Output contract.

## Runtime layout

Download the Windows amd64 archive for MediaMTX v1.20.1 from the official
release page and verify its published checksum. Place only the executable at:

```text
var/runtime/mediamtx/mediamtx.exe
```

The entire `var/runtime/mediamtx/` directory is ignored by Git. Never commit the
executable or generated runtime configuration.

Add these local values to the already ignored `.env` file:

```text
LIVEZONE_RTMP_PUBLISH_USER=<LOCAL_PUBLISH_USER>
LIVEZONE_RTMP_PUBLISH_PASSWORD=<LOCAL_PUBLISH_PASSWORD>
```

Use long, unique values. They are publisher credentials, not the media path or
an HLS token. Never copy them into a LIVE Source, Local Storage, Program Output
or screenshots.

## Validate and start

From PowerShell 7:

```powershell
pwsh -NoProfile -File tools/start-mediamtx.ps1 -ValidateOnly
pwsh -NoProfile -File tools/start-mediamtx.ps1
```

The script fails closed unless the binary reports v1.20.1, both local
credentials are non-empty, ports 1935/8888/9997 are free, and the generated
configuration keeps the API on loopback. It writes the credential-bearing
configuration only to ignored `var/runtime/mediamtx/mediamtx.yml` and never
prints credential values. Stop the foreground process with `Ctrl+C`.

## OBS concept

The runtime-validated OBS Custom RTMP configuration is:

```text
Service: Custom
Server: rtmp://127.0.0.1:1935
Stream key: livezone-test?user=<USER>&pass=<PASSWORD>
Use authentication: disabled
```

OBS combines Server and Stream key into the final private publish URL:

```text
rtmp://127.0.0.1:1935/livezone-test?user=<USER>&pass=<PASSWORD>
```

`<USER>` comes from `LIVEZONE_RTMP_PUBLISH_USER` and `<PASSWORD>` comes from
`LIVEZONE_RTMP_PUBLISH_PASSWORD`. Internal MediaMTX RTMP authentication uses
these `user` and `pass` query parameters. Do not enable OBS separate
authentication for this validated configuration. Never put real credentials in
tracked documentation, and never print, paste, or log the private publish URL.

The browser-safe playback URL is always credential-free:

```text
http://127.0.0.1:8888/livezone-test/index.m3u8
```

In LIVEZONE, create a normal **LIVE · HLS** Source with that URL, then create a
Scene separately. No `rtmp://` Source kind is introduced.

## Status and troubleshooting

LIVEZONE exposes only sanitized status at:

```text
GET http://127.0.0.1:8080/api/media-ingest/status
```

The raw MediaMTX API remains at loopback `127.0.0.1:9997`. States are `offline`,
`connecting`, `live`, or `error`. Browser first-frame readiness remains a
separate Studio concern.

- Occupied 1935, 8888 or 9997: stop the owning application yourself or review
  its configuration; the script never terminates another process.
- Invalid credentials: MediaMTX rejects publishing and status remains offline.
- `error`: confirm MediaMTX is running and the local Control API is reachable.
- `connecting`: publisher data exists but the HLS playlist is not yet usable.

Phase 1A uses plain RTMP only on the local machine. Production requires a
separate TLS/network-security design.
