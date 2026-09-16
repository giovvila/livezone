// Local diagnostics only: no requests, storage, controller writes or timers.
export default async function compareHealth(server,browser){
    if(!server||!browser)return null;
    let endpointMatch=null;
    try{
        const url=new URL(browser.endpoint);url.hash='';
        const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(url.href));
        endpointMatch=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')===server.endpointFingerprint;
    }catch{}
    const sameSource=server.sourceId===browser.sourceId;
    const browserState=['UNKNOWN','CHECKING','ONLINE','OFFLINE','ERROR','UNCERTAIN'].includes(browser.state)?browser.state:'UNKNOWN';
    return Object.freeze({sameSource,endpointMatch,fullFingerprintMatch:null,serverState:server.state,browserState,
        timestampDeltaMs:Number.isFinite(browser.checkedAt)?server.observedAt-browser.checkedAt:null,
        stateAgreement:sameSource&&endpointMatch===true?server.state===browserState:null,
        progressionAgreement:null,reason:'TRANSPORT_IS_NOT_DECODER_EQUIVALENT'});
}
