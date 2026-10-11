const protectedSuffixes=['/server/autolive/AutoLiveSafeHttp.js','/server/autolive/ManagedIngestTransport.js','/test/managed-ingest-transport-health.test.js','/test/scheduled-live-managed-health-gap.test.js','/test-support/MediaMtxCookieFixture.js'];
export async function resolve(specifier,context,nextResolve){
 const result=await nextResolve(specifier,context);
 if(protectedSuffixes.some(s=>result.url.toLowerCase().endsWith(s.toLowerCase())))throw Object.assign(Error('H1_DEPENDENCY_FORBIDDEN: '+result.url),{code:'H1_DEPENDENCY_FORBIDDEN'});
 return result;
}
