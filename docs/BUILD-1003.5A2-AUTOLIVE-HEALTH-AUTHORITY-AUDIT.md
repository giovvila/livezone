# BUILD 1003.5A2 — AutoLive health authority / shadow mode

## Scope and execution boundary

Base: `build/1003.5A1`, `1e09d2bb508ac50564aa507517398bce5d57ba9a`.
Work branch: `build/1003.5A2`. No staging, commit, push or production service restart.

AUTOLIVE PROGRAM EXECUTION WITH CONTROL CLOSED IS STILL NOT ENABLED IN 1003.5A2.

A2 makes health observation independent of Control. Execution remains
`AutoLiveEntryController` / `browser-legacy`. No server TAKE, return, preparation,
Preview mutation, Program publication or recovery execution is added. Scheduler
Program execution remains false / SUSPENDED.

## Contract and identity

`AutoLiveHealthContract` validates version 1 observations with source ID, hashed
source and endpoint identities, authority, server session UUID, generation,
sequence, observedAt, validUntil, freshness, state, reason, readiness, nullable
evidence and explicit capabilities. States are UNKNOWN, CHECKING, ONLINE,
OFFLINE, ERROR and UNCERTAIN. No raw endpoint, query secret or response payload
is published as health diagnostics.

Source fingerprint hashes source ID, definition revision, configRef, resolved
normalized endpoint and managed ingest ID. Endpoint changes under the same ID
create a new demand identity. The endpoint is resolved from existing authority;
it is not persisted as a second editable configuration.

`playbackProgressing` is always null in A2. ONLINE is producer-specific evidence,
not a claim of decoded healthy playback.

## Capability matrix

| Evidence | Managed producer | External HLS producer | Browser legacy |
| --- | --- | --- | --- |
| Publisher / track presence | Existing MediaMTX API | Not proved | Source-specific monitor |
| Manifest availability | Not probed by this producer | Yes | Existing media consumer |
| Playlist advancement | No | Sequence plus changed segment URI | Existing media consumer |
| Segment reachability | No | Bounded HTTP read | Existing media consumer |
| Decoder / currentTime progress | No | No | Yes, existing ENTRY / Program paths |

Managed flags: presenceEvidence=true; playlistProgressEvidence=false;
segmentReachabilityEvidence=false; decoderProgressEvidence=false.
External flags: first three=true; decoderProgressEvidence=false. These flags
describe producer capabilities; nullable observation fields describe actual evidence.

## Managed producer

Reuses `MediaIngestStatusClient.getStatus({sourceOnly:true, signal})` and its
existing MediaMTX paths API and track interpretation. Ingest ID and configured
playback URL must match the trusted mapping. No separate MediaMTX API path and
no decoder are introduced. Publisher presence produces ONLINE; publisher
absence OFFLINE; incomplete tracks UNCERTAIN; API failure ERROR.

The client now bounds the entire fetch/body operation and supports cancellation.
Trusted local MediaMTX configuration remains separate from external URL policy.

## External HLS producer

Pure HTTP, no ffmpeg or browser. Master playlists choose the lowest BANDWIDTH
variant deterministically. At most three playlist levels are traversed. Relative
segment and variant URIs resolve against the final response URL.

The observer requires successive successful samples, increasing media sequence
end and a changed last segment URI. Discontinuity changes, sequence regression
or selected playlist changes reset the baseline. PROGRAM-DATE-TIME, when present
in both samples, must advance; it is not used to assert absolute live-edge age.
The first sample is UNCERTAIN, even with HTTP 200. A static playlist becomes
PLAYLIST_STALLED after max(15 seconds, three target durations). Each ONLINE
observation requires new progression evidence and successful segment retrieval;
an unchanged sample is conservatively UNCERTAIN.

ENDLIST and declared VOD never become ONLINE. Byte-range media playlists are
explicitly unsupported and UNCERTAIN. Invalid playlists, unsafe integer identities,
HTTP errors, inaccessible segments and timeouts fail closed. Network recovery
can resume observation; a new producer starts with a new baseline.

Segment requests use Range bytes=0-0 and cancel the response on the first data
chunk, retaining no segment buffer. A server ignoring Range may deliver one
transport chunk before cancellation; this does not prove full segment integrity.

Protocol reference: [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216).
Request lifecycle reference: [Node HTTP API](https://nodejs.org/api/http.html).

## Registry, demand and freshness

One registry entry / producer per source ID and fingerprint, shared by retained
subscribers. Monitoring runs only when configuration is available, enabled,
armed and resolves to a valid source. Disabled/disarmed demand is released and
exposed health becomes UNKNOWN. Technical Monitor remains independent.

Default cadence is 3 seconds after each completed attempt; one sample per entry
is in flight. Observations expire after 10 seconds using the server clock.
Expiry notifications and read-time freshness both replace expired evidence with
UNKNOWN. A hung producer cannot retain ONLINE indefinitely.

Sequences increase within an entry. Generations increase for new entries;
server UUID fences restarts. Session, generation, sequence, source fingerprint,
endpoint fingerprint, authority and timestamps are checked. Old callbacks are
also fenced by entry object identity. Last release aborts the producer and clears
poll/expiry timers. Restart reloads existing configuration but trusts no prior
health, ENTRY accumulation or loss deadline.

## Resource and SSRF policy

- Maximum four registry entries; production authority requests one selected source.
- One sequential request at a time per producer; overall attempt deadline 7 seconds.
- Each external read: 2.5 seconds including DNS, redirects and body.
- Cancellable DNS resolver: 2 second timeout, one try, IPv4 and IPv6 queries.
- Maximum 32 resolved addresses; every returned address must pass public-IP policy.
- Socket lookup is pinned to a validated address; no second DNS lookup on connect.
- HTTP(S) only; no userinfo; maximum URL length 2048; only ports 80/443.
- Loopback, private, link-local, shared-address, multicast and reserved/documentation
  ranges are rejected. IPv6 is restricted to global unicast with reserved exclusions;
  mapped IPv4 and transition ranges are rejected conservatively.
- Local/reserved hostname suffixes are rejected. Managed trusted configuration
  bypasses external fetching and uses the existing managed client.
- Maximum three redirects per read; URL, port and DNS policy repeat on every hop.
- Headers maximum 16 KiB; manifest maximum 128 KiB and 8192 lines.
- No compressed responses, ambient credentials, cookies, proxy or reusable HTTP pool.
- Source changes abort HTTP/DNS and fence stale completion. No media buffering.

Private fixture trust is dependency-injected only in tests; production defaults
have no external localhost exception. TLS host verification remains enabled.

## Authority, events, UI and shadow diagnostics

Existing GET /api/studio/autolive and private shared `autolive-state` carry health
runtime fields. Existing retained ControlEventFeed delivery remains in use.
No new API mutation or browser network path; one physical Control SSE remains.
Public and OBS do not receive private Control health state.

Minimal Control health display shows authority, state, last check, freshness,
reason and capabilities. A bounded last comparison reads the existing dominant
health monitor locally, compares source ID and endpoint hash, states and timestamp
delta, and uses async sequence fencing. It creates no poller or decision timer.
Full catalog fingerprint equality and decoder progression agreement are null,
because browser observations do not prove those equivalences. No URL is logged.

Shadow ENTRY accumulation and shadow loss deadlines are deliberately not
implemented (`shadowEntryHealthyMs:null`, `shadowLoss:null`). Existing browser
healthy-playback ENTRY accumulation remains unchanged, as do external 15-second
corroborated loss and the managed 5-second legacy discrepancy. HTTP evidence must
not silently replace either policy. A3 must define capability equivalence first.

Health observations are not asset references. A1 scoped Safe Delete recovery
semantics are unchanged, including unrelated asset status under health failure.

## Validation

Two new test files cover contract, fingerprints, coalescing, stale generations,
expiry, abort, mapping, HTTP bounds, SSRF, redirects, HLS progression/stall/reset,
VOD/ENDLIST, recovery, and shadow comparison. Local HTTP fixtures require no
public Internet. Managed Control-closed tests exercise the actual managed client.
External Control-closed tests exercise HTTP HLS observation. Both update authority
without a Control instance and provide retained health to a later Control feed.
They assert non-execution and Safe Delete isolation, and cover restart/disable.

- Broad focused regression suite: 1238/1238 PASS.
- Final new health tests after VOD/integer hardening: 67/67 PASS.
- Full suite: 1625/1625 PASS, zero failed, cancelled or skipped.
- Syntax: 12/12 changed/new JavaScript files PASS.
- `git diff --check`: PASS.
- Final HEAD unchanged at the A1 base; branch `build/1003.5A2`; staged count 0.
- Task inventory: 10 production JavaScript files, 2 test files, this audit (13 files).
- `.env` and all five protected media/logo SHA-256 hashes match the initial values.
- Expected excluded status remains 342 runtime/generated entries and 5 protected
  media entries. No runtime files were written by this task; live service runtime
  content is not certified byte-for-byte by this status inventory.
- No service restart, production browser interaction, Program operation, staging,
  commit or push was performed. Test logs and fixture state were placed in temporary
  directories outside production runtime storage.

## Known limitations

Transport progress is not decoder progress. No complete HLS decoder, encryption
validation, full segment integrity, absolute live-edge age, LL-HLS parts-only
support or byte-range progression is claimed. Lowest-bandwidth variant evidence
does not certify all variants. External private-network URLs and nonstandard
ports are intentionally rejected. Strict transport states may differ from a
healthy browser decoder between segment advances; comparison never drives Program.

The accepted 1003.4 limitation remains: audio-12 + MOTION ARTWORK passes Control,
Public and OBS software; an additional OBS web tab in the same Edge browser can
fail. This is non-blocking and the shared Control Event Stream is preserved.

No production service was restarted or browser opened for A2. Automated
Control-closed fixture evidence does not claim a production manual retest.
