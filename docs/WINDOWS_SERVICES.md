# LIVEZONE Windows service supervision

Phase 2C/P0-B provides optional Windows service supervision without replacing
the manual development commands. It does not install a reverse proxy, TLS,
firewall rules, DNS, or RTMPS.

## Runtime architecture

WinSW is pinned to stable version **2.12.0**. Download `WinSW-x64.exe` only from
the official WinSW v2.12.0 GitHub release, verify the release artifact, and place
it at the ignored path `var/runtime/winsw/WinSW-x64.exe`. The installer copies
that untouched source binary into deterministic bundled pairs:

- `services/LivezoneMediaMtx/LivezoneMediaMtx.exe|.xml`
- `services/LivezoneNode/LivezoneNode.exe|.xml`

Each copied wrapper is invoked without an external configuration argument, as
required by WinSW 2.12.0 bundled mode. All copied executables and generated
machine-specific XML files remain under `var/runtime/winsw/` and must not be
committed.

The deterministic Windows service IDs are:

- `LivezoneMediaMtx` (`LIVEZONE MediaMTX`)
- `LivezoneNode` (`LIVEZONE Node`)

MediaMTX runs through `pwsh` and `tools/start-mediamtx.ps1`. That preserves the
pinned MediaMTX 1.20.1 validation and generates its ignored credential-bearing
runtime YAML from `.env` at service start. Node runs the resolved absolute
`node.exe` directly with the equivalent of the canonical package command:

```text
node --env-file-if-exists=.env server/program-output-server.js
```

Both services use the repository root as their explicit working directory,
Automatic Delayed Start, and bounded failure recovery: restart after 10 seconds,
restart after 30 seconds, then remain stopped. The failure count resets after one
healthy hour. Node has no hard SCM dependency on MediaMTX, so it can start and
report degraded readiness while MediaMTX is still starting. Install/start order
is MediaMTX followed by Node.

## Identity and permissions

The scripts never create users or alter ACLs. The initial installation requires
an explicit `-ServiceIdentity LocalSystem` acknowledgement; no identity is
selected silently. For sustained production, prefer a pre-provisioned dedicated
least-privilege service identity in a later credential/ACL provisioning step.

The effective service identity requires:

- read/execute access to the repository and Node executable;
- read access to `.env`;
- read/write access to `var/media-library/`;
- read/write access to `var/runtime/mediamtx/` and `var/runtime/winsw/`;
- read/write access to `var/log/livezone/`.

Do not grant write access to source or operator assets unless separately needed.

## Logging

Node and MediaMTX stdout/stderr are separated by their generated WinSW config
names under the ignored `var/log/livezone/` directory. Size rotation is bounded
to eight retained files per stream at 10 MiB each. WinSW wrapper failures are
also written to that directory and the Windows Event Log. Logs must never be
used to print `.env`, publisher URLs containing credentials, or secret values.

## Validation and lifecycle

Run from an elevated PowerShell 7 shell for actual installation. Stop the manual
Node and MediaMTX runtimes first; installation fails closed when ports 1935,
8080, 8888, or 9997 are occupied.

```powershell
pwsh -NoProfile -File tools/install-livezone-services.ps1 -ServiceIdentity LocalSystem -ValidateOnly
pwsh -NoProfile -File tools/install-livezone-services.ps1 -ServiceIdentity LocalSystem -StartServices
pwsh -NoProfile -File tools/status-livezone-services.ps1
pwsh -NoProfile -File tools/uninstall-livezone-services.ps1 -WhatIf
pwsh -NoProfile -File tools/uninstall-livezone-services.ps1
```

Validation requires the pinned WinSW and MediaMTX executables, Node 20+, `.env`,
all repository templates, and the three required secret variable names. Values
are checked for presence but never printed. Installation refuses pre-existing
service IDs and rolls back services installed by the same failed attempt.

Uninstall verifies that each deterministic service ID points to its matching
same-basename bundled WinSW/config pair. It removes only those services and never deletes `.env`, media,
runtime binaries/configuration, logs, or operator assets. The status command
reports only sanitized installation/state, file presence, listener, liveness,
readiness, and MediaMTX API reachability information.

Manual development remains supported:

```powershell
npm run serve
pwsh -NoProfile -File tools/start-mediamtx.ps1
```

Expected service ports remain 1935 (RTMP), 8080 (Node HTTP), 8888 (LL-HLS), and
loopback-only 9997 (MediaMTX API). Reverse proxy, HTTPS, firewall, DNS, and RTMPS
are intentionally deferred to later Phase 2C work.
