# Public Viewer intermittent startup / reconnect

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

The operator reports that this issue predates fullscreen Sponsor. No Sponsor/Crawl implementation was changed for this audit. The exact observed browser failure was not captured: current read-only checks return 200 for `/`, public-app.js, Program Output config and readiness. The findings below are reproduced code-path defects, not a claim that the operator's particular failed attempt has been identified from a browser trace.

## First divergences and fixes

1. **BFCache restore:** Public's pagehide handler destroyed its controller/SSE and stopped bootstrap permanently. Returning through browser Back/Forward can restore the document without evaluating its module scripts again. No pageshow handler restarted it. The first divergence is the persisted pageshow transition, before any new SSE or render. Public now suspends on pagehide and restarts shell/bootstrap/controller on persisted pageshow, idempotently. This specifically affects ordinary Public navigation; OBS need not undergo that navigation to remain healthy.
2. **Terminal SSE:** native EventSource retries while CONNECTING, but a CLOSED stream was left referenced and no replacement was scheduled. The transport now schedules one lifecycle-guarded replacement for CLOSED, retaining native reconnect for CONNECTING. A temporary constructor failure retries too. Destroy cancels the pending retry. Publisher behavior and its credentials are unchanged.
3. **Failed controller bootstrap:** transport creation followed by controller-start failure entered retry without disposing the failed transport. Bootstrap now disposes it and awaits the initialization callback; Public destroys any partially started controller before retry. This avoids accumulating orphan streams on repeated startup failure.

## Remaining trace

GET `/` loads local hls.min.js and public-app.js. Public's existing bounded bootstrap fetches `/config/program-output.json`, retries configuration failures/timeouts, constructs a subscriber and subscribes to `/api/program-output/events`. The server sends any retained envelope and then later publications over the same stream; a healthy SSE connection does not imply a retained Program exists.

The Program store is process-local. A fresh server can therefore have no retained base until Control republishes. This is not itself a frontend failure: Public displays WAITING FOR PROGRAM and the first later valid publication renders without refreshing. No fabricated Program, automatic TAKE or server state mutation was introduced.

Existing revision/session gates reject old state and accept newer state. Existing source readiness and seek preparation have bounded timeouts. Initial preparation failure already shows PROGRAM UNAVAILABLE and retries the accepted snapshot without requiring a newer revision; regression tests verify that behavior. HLS preparation/recovery and old-surface generation guards were retained. No unbounded readiness wait or Sponsor-dependent bootstrap was demonstrated in the tested paths.

## Tests and evidence

20 new cases use the production server on an ephemeral port, real HTTP config and retained SSE, actual NetworkProgramOutputTransport/PublicProgramController and jsdom media readiness shims. They cover no retained Program, delayed publication, VIDEO/AUDIO/LIVE/BREAK late join on Public and OBS, BFCache resume, terminal versus native SSE reconnect, a fresh post-restart server state, stale/newer revisions, initial renderer failure, failed bootstrap cleanup, transient reconnect-constructor failure, and crawl/Sponsor absent/present (including fullscreen).

Media decoding and actual browser BFCache/OBS navigation remain manual acceptance items; the tests exercise production control flow rather than a real video decoder. Existing HLS, OBS, Program Output, normal TAKE and fullscreen regression suites are retained.

- Focused: 159/159 PASS (`var/public-startup-focused-final.log`).
- Full: 1392/1392 PASS (`var/public-startup-full.log`; baseline 1372).
- Syntax: four changed/new JavaScript files PASS.
- `git diff --check`: PASS.
- Index SHA-256 unchanged: `6ea17b9850a3e3a00ab92f4c27fadf0049d60bbb177c001ab24af0ff5d050f1a` (117 staged checkpoint files).

Files changed for this fix: public/js/entries/public-app.js; public/js/public/PublicProgramBootstrap.js; public/js/program-output/NetworkProgramOutputTransport.js; test/public-startup-reconnect.test.js; this audit. Previous unstaged fullscreen work was preserved. No stage, unstage, commit, push, service restart, production DELETE, event creation, Program or Preview mutation was performed.

Manual retest: load the updated Public page once, open before first Program publication, navigate away/back repeatedly, interrupt/reconnect connectivity, and check VIDEO/AUDIO/LIVE/BREAK late join with and without overlays. No backend restart is needed for these frontend-only changes. If the original symptom persists, capture whether HTML fails, waiting/unavailable remains, or a console/network error occurs; that determines the still-unobserved first divergence of the operator's actual episode.
