// Temporary DevTools-only diagnostic. Does not issue requests or authorize actions.
// Paste this file in the existing Control tab; operate the UI manually.
(() => {
  window.dp1ReconciliationDiagnostic?.stop();
  const original = window.fetch, rows = [];
  const keys = ['authorityEpoch', 'authorityProcessSession', 'durableGeneration',
    'programIdentity', 'configRevision', 'sourceFingerprint', 'manualIntentRevision', 'ownershipRevision'];
  const bounded = value => typeof value === 'string' ? value.slice(0, 120) :
    typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
  const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, bounded(value?.[key])]));
  let prepared = null;
  function wrapper(input, options) {
    let request, watched = false;
    try {
      watched = new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/api/studio/execution-ownership';
      if (watched) request = JSON.parse(options?.body || '{}');
    } catch { watched = false; }
    const pending = Reflect.apply(original, window, [input, options]);
    if (watched) pending.then(response => {
      response.clone().json().then(body => {
        const expected = request.expected || body.expected || prepared?.expected;
        const current = body.current;
        if (request.operation === 'prepare-reconciliation' && response.ok)
          prepared = {expected: pick(body.expected, keys), expiresAt: body.expiresAt};
        const row = {at: Date.now(), operation: bounded(request.operation), httpStatus: response.status,
          error: bounded(body.error), reconciliationId: bounded(body.reconciliationId || request.reconciliationId),
          ownerInstanceId: bounded(request.ownerInstanceId), publisherSessionId: bounded(request.publisherSessionId),
          expiresAt: bounded(body.expiresAt || prepared?.expiresAt),
          preparationProgramStatus: bounded(body.program?.status),
          state: pick(body.state, ['state', 'reason', 'authorityEpoch', 'authorityProcessSession', 'grantRevision']),
          grantPresent: Boolean(body.grant),
          fields: Object.fromEntries(keys.map(key => [key, {prepared: bounded(expected?.[key]),
            current: bounded(current?.[key]), comparison: !current || !expected ? 'NOT_RETURNED' :
              current[key] === expected[key] ? 'MATCH' : 'MISMATCH'}]))};
        rows.push(row); if (rows.length > 12) rows.shift();
      }).catch(() => { rows.push({at: Date.now(), error: 'DIAGNOSTIC_RESPONSE_NOT_JSON'}); if (rows.length > 12) rows.shift(); });
    }).catch(() => {});
    return pending;
  }
  window.fetch = wrapper;
  window.dp1ReconciliationDiagnostic = {
    snapshot: () => structuredClone(rows),
    stop: () => { if (window.fetch === wrapper) window.fetch = original; }
  };
  return 'Diagnostic installed. No request sent. Read dp1ReconciliationDiagnostic.snapshot(); stop with dp1ReconciliationDiagnostic.stop().';
})();
