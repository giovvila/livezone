# Studio reconciliation and Scheduler Media Library audit

> Historical architecture/phase evidence retained for BUILD 1003.4. Phase-specific BLOCKED decisions, test counts, staging restrictions and next steps below describe that earlier phase. Current acceptance and consolidation status are authoritative in [Runtime checkpoint](BUILD-1003.4-RUNTIME-CHECKPOINT.md); the exact final selection is in [Checkpoint inventory](BUILD-1003.4-CHECKPOINT-FILES.json).

Decision: BUILD_1003_4D3_STUDIO_RECONCILIATION_MEDIA_PANEL_BLOCKED

Production evidence read on 2026-09-14 from the persisted authority census and Studio repository. No production state writes, DELETE, TAKE, service restart, stage, commit or push were performed for this task.

## Actual client census

All records use capability version 3 and supported=true. R means both catalog and legacyStatus RECONCILED; P means both PENDING. Active is a registry flag, not proof of a connected browser. Authenticated principals and resume credentials are intentionally omitted.

| Role | Client ID | Generation | Confirmed | Active | Catalog/aliases | Termination |
|---|---|---:|---|---|---|---|
| CONTROL | e8fd1591-f8da-4f59-8bee-4c2686a29191 | 3 | true | false | R | EXPLICIT_CLOSE |
| CONTROL | 2b3cc6f0-b2d9-4d56-a202-84f9b14391e9 | 1 | true | false | R | EXPLICIT_CLOSE |
| SCHEDULER | 1e8a44e7-bb31-4e95-a373-5287755d762e | 1 | false | true | P | none |
| SCHEDULER | 89567ccd-11ca-4162-829b-32aebc8ef490 | 3 | true | false | R | EXPLICIT_CLOSE |
| SCHEDULER | 2621e6df-d90d-4b91-b304-08424453ddb1 | 1 | false | true | P | none |
| CONTROL | c73536d4-311d-48fe-808e-ae93b55409fa | 2 | true | false | R | EXPLICIT_CLOSE |
| SCHEDULER | fa096d25-c363-411c-a2b7-0355ec987722 | 2 | true | false | R | EXPLICIT_CLOSE |
| CONTROL | 540424c2-118c-4ced-8eb3-b8c05129f6f1 | 1 | true | false | R | EXPLICIT_CLOSE |
| SCHEDULER | 1380d97a-5b23-42d5-9750-e58cf69bbd56 | 1 | false | true | P | none |

The three pending Scheduler records have distinct IDs. Neither their age nor their shared authenticated principal proves supersession. Positive resume-token replacement for the same ID already increments generation and replaces the record; tests confirm old generations no longer veto after reconciliation. No unsafe census retirement was added.

## Reconciliation evidence and limits

Server Studio: schemaVersion=1, revision=1, initialized=true, sources=8, scenes=8. A separate Studio reconciliation generation and per-client reported schema/revision/counts are not persisted in these records. Browser catalog operands are unavailable: the browser tool reports no attached browsers. Do not infer content equality, a version conflict, or current browser connectivity from the registry alone.

Exact false predicates for each pending ID: `client.catalog === 'RECONCILED'`, `client.legacyStatus === 'RECONCILED'`, and `client.confirmed`. These explain LEGACY_CATALOG_PENDING, LEGACY_ALIASES_UNCONFIRMED and CLIENT_CAPABILITY_UNKNOWN. The actual first missing acknowledgement is after Scheduler registration and before alias/catalog publication. The successful closed Control records have acknowledged reconciliation; there is no evidence of a Control catalog conflict.

Scheduler contains source editors and legacy asset references, so exempting its catalog/alias acknowledgement would conceal possible references. Equal-content no-op reconciliation, current Control/Scheduler acknowledgement, token-backed supersession and no Program/Preview writes are covered with isolated fixtures. Actual production completeness remains unproven/incomplete; tests do not substitute for the missing production acknowledgements.

The production bootstrap registers a client before asynchronous config, source, media and authority initialization. Previously its close handler and panel click binding were installed after those awaits. An interrupted bootstrap could therefore leave both pending acknowledgement and an unbound EXPAND button. The exact exception in the operator's browser cannot be established without its console/connection. The close handler is now installed immediately after registration. Reference messages identify missing catalog/alias acknowledgement or unconfirmed connection rather than generically prescribing Control/Scheduler reload.

## Media Library change

Media Library now uses the same ScheduleWorkspacePanels contract as Configured Sources and Live Sources, bound before authentication/network awaits. It preserves `livezone.scheduler.mediaLibrary.collapsed.v1`; the other panels retain separate keys. The panel manager owns hidden, is-collapsed, aria-expanded and EXPAND/COLLAPSE labels. MediaLibraryUI opts out of a second collapse owner; its default behavior elsewhere is unchanged. Repeated start is idempotent and destroy removes listeners.

The actual Scheduler HTML has unique toggle/body IDs and a non-disabled button outside a form. Tests verify the real DOM contract, body visibility, labels, persistence, independent panel state, late library initialization, rerender and the real Scheduler SSE handler. Filters, upload and Sponsor selection callbacks remain functional. No CSS patch was needed. Live event interception/browser-specific failure remains unverified without the operator browser.

## Validation

- Added 30 tests in test/studio-reconciliation-media-panel.test.js.
- Focused: 114/114 PASS, var/1003-4d3-studio-panel-focused.log.
- Full node --test: 1318/1318 PASS (baseline 1288), var/1003-4d3-studio-panel-full.log.
- node --check: schedule-app.js, ScheduleWorkspacePanels.js, MediaLibraryUI.js, and the new test file PASS.
- git diff --check PASS; Git emitted existing LF/CRLF conversion warnings.

Files changed for this task only: public/control/schedule/index.html; public/js/entries/schedule-app.js; public/js/ui/ScheduleWorkspacePanels.js; public/js/ui/MediaLibraryUI.js; test/studio-reconciliation-media-panel.test.js; this audit. The workspace already contains unrelated prior-build modifications, which were preserved.

## Manual retest and blocker

Reload Control and Scheduler normally. Verify one-boot acknowledgement without source/scene edits and inspect reference-check reasons. Expand/collapse Media Library, reload to verify preference, then exercise filter/upload/Sponsor selection and Scheduler updates without TAKE or DELETE. If the same three IDs remain pending, a new unrelated client ID is insufficient: their original client identities must positively reconnect/reconcile or their replacement must be positively established. Do not force COMPLETE or retire on silence. Capture the first browser console error if bootstrap still stops.

NEXT_STEP = MANUAL RELOAD CONTROL + SCHEDULER, VERIFY REFERENCE CHECK COMPLETE + MEDIA LIBRARY EXPAND
