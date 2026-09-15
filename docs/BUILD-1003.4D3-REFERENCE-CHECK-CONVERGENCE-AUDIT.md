# D3 reference-check convergence

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Decision: BUILD_1003_4D3_REFERENCE_CHECK_CONVERGENCE_READY_FOR_MANUAL_RETEST.

The three reported messages were a stale Media Library projection, not evidence of three still-pending server acknowledgements. This fix changes frontend invalidation and test isolation only. No backend restart is required for these frontend modules; manually reload current clients.

## Real runtime evidence

Read-only inspection of the service's existing authority files on 2026-09-14 found:

| Component | Observed state |
|---|---|
| Control | Client e8fd1591-f8da-4f59-8bee-4c2686a29191, version 3, generation 3, supported=true, active=true, confirmed=true in the persisted census |
| Capabilities | The server accepted v3, which requires canonical-catalog, preview-ownership-v2, asset-validation and channel-logo-authority-v1 |
| Scheduler | No separate Scheduler entry in the inspected census |
| Catalog and aliases | Both RECONCILED; legacy revision 3; no managed legacy aliases |
| Studio server | Schema 1, revision 1, initialized; 8 sources and 8 scenes; 2 sources contain canonical managed-asset fields |
| Preview logo | Revision 2, generation 3, pending=false, references=[], previous=[] |
| Program logo | Revision 2, generation 3, pending=false, references=[], previous=[] |
| Logo mutation origin/age | No pending mutation; pending origin and age not applicable. Logo file last written at 08:06:23 +02:00 |
| Preview ownership | Session 72872609-fac5-488c-9d7a-42e7931f546b, ownership generation 1, confirmed=true, references=[] |
| Positive renewal | At 06:12:48.716 UTC, sequence 51; file updated 06:12:47.910 UTC; expiry 06:13:17.909 UTC |
| Retained Program | Read-only SSE reported media-demo-2-scene, kind media; no publication or TAKE was issued |

Authentication principals and resume credentials were omitted from the inspection output. These file observations establish that the catalog, logo and Preview acknowledgements had reached the server. They are not a claim that an authenticated live inventory GET or the real DOM was inspected: the Browser runtime reported no connected browsers. In-memory census liveness can change after a file write.

The current local logo URL/assetId, exact visual Preview scene and browser's local catalog revision were not directly observable. Zero managed Preview references proves known-empty managed asset ownership, not necessarily a visually empty monitor: BREAK, static graphics and other non-transport content can also have no playable transport. StudioMediaUI renders UNAVAILABLE when its transport snapshot is absent. This label alone does not establish a bootstrap regression; the real positive empty-ownership renewals contradict the hypothesis that no ownership was being published.

## First divergence and root cause

Control initializes MediaLibraryManager before legacy/catalog reconciliation, Preview publication and Channel Logo confirmation. Its first inventory read therefore legitimately contains the three incomplete reasons. MediaLibraryUI starts later but calls the manager's memoized initialize(), which returns the earlier projection. The UI previously refreshed on manual refresh, focus or media-library changes, not on authority acknowledgements. The server could finish every handshake while the UI continued showing the boot snapshot.

The observed pending-logo hypothesis is disproved by both real records having pending=false. No logo was blindly committed, no catalog was rewritten, and no empty ownership was fabricated to remove the messages. Existing no-op/equal reconciliation already confirms server authority and is covered by the added production-path tests.

## Fix

- MediaLibraryUI obtains a fresh audit after initialization instead of treating the memoized boot audit as current.
- The operator request client invalidates reference projections after catalog, capability, alias, Preview and logo mutation responses. Failure responses also invalidate because the server may have retained pending metadata before returning an error.
- Notifications carry only an invalidation signal. The current document refreshes and existing BroadcastChannel synchronization refreshes other Control/Scheduler documents. GET audits and Program publication cannot create notification loops.
- Presence confirmation/error events also invalidate the projection. Normal Preview renewals naturally refresh the audit without a new polling timer.
- Refreshes within one UI are coalesced. A change arriving during an in-flight read causes another read afterward, avoiding a missed final acknowledgement.
- UI teardown removes the listener and status element. A denied cross-tab messaging capability cannot interrupt a successful authority request.

The server already recomputes completeness on every inventory read. The fix requests that recomputation after relevant acknowledgements and displays the returned global and per-asset states. It never sets COMPLETE locally or enables DELETE independently of the server. Program, Preview selection, transport, Sponsor/Crawl, AutoLive and scheduler timing are untouched.

## Tests and limits

26 new tests use current frontend clients against real HTTP routes on isolated ephemeral servers, plus DOM projection tests. They cover Control/Scheduler capability and boot convergence, late UI mount, equal/no-op catalog reconciliation, safe legacy import, explicit catalog/logo conflicts, empty and media Preview publication/acknowledgement, unavailable transport presentation, stale pending/equal logo confirmation, updates after each authority acknowledgement, cross-document updates, coalescing, absent delete actions before COMPLETE, eligibility after COMPLETE, and no Program/Preview mutation from reconciliation.

Existing D3 restart/generation tests and full Sponsor/Crawl/AutoLive regressions remain in the full suite. New tests do not send DELETE; they check eligibility and UI only. Existing regression deletion fixtures remain isolated from production media.

The first full run revealed three readiness tests reading the now-initialized real Studio catalog. The test server wrapper now defaults Studio and schedule paths to its own temporary directory, preserving explicit test overrides. The existing UI test harness also waits for the new post-boot refresh before checking badges. No production catalog or schedule was changed for testing.

Focused authority/reconnect suite: 197/197 PASS. Full suite: 1288/1288 PASS, from baseline 1262. Syntax: 87 JavaScript files, zero errors. git diff --check: PASS. Logs: var/1003-4d3-convergence-focused.log, var/1003-4d3-convergence-full.log and var/1003-4d3-convergence-syntax-summary.txt.

A real browser retest remains necessary. No browser was connected to the available Browser tool, so this audit does not claim to have seen the actual Control/Scheduler banner change to COMPLETE. Genuine unresolved domains must continue to show INCOMPLETE.

## Files changed for this fix

- public/js/media-library/ReferenceAuthorityNotifications.js (new)
- public/js/auth/OperatorSessionClient.js
- public/js/studio/ReferenceClient.js
- public/js/ui/MediaLibraryUI.js
- test/reference-check-convergence.test.js (new)
- test/asset-reference-authority.test.js
- test-support/ReferenceAuthorityTestServer.js
- This audit

No stage, commit, push, service restart, production DELETE, TAKE, Program/Preview mutation, .env change or MediaMTX change was performed.

MANUAL_RETEST: Reload/login current Control and Scheduler, allow reconciliation and ownership publication, and confirm that the banner updates without a second reload. Inspect each asset's status independently; this turn does not authorize or perform a production deletion.

NEXT_STEP = MANUAL RELOAD CURRENT CLIENTS AND VERIFY REFERENCE CHECK COMPLETE.
