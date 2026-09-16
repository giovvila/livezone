import {createHash} from 'node:crypto';
import {id,freeze,error} from './AutoLiveContract.js';

export const HEALTH_STATES=Object.freeze(['UNKNOWN','CHECKING','ONLINE','OFFLINE','ERROR','UNCERTAIN']);
export const hashIdentity=value=>createHash('sha256').update(value).digest('hex');
export function endpointIdentity(value){
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2048)throw error('INVALID_ENDPOINT');
    url.hash='';return url.href;
}
export function resolveHealthSource(source,resolveConfigRef=()=>null,managed=null){
    if(!source||!id(source.id)||source.kind!=='hls'||source.enabled===false)return null;
    try{
        const endpoint=endpointIdentity(source.url||resolveConfigRef(source.configRef));
        const equivalent=value=>endpointIdentity(value).replace('://localhost:', '://127.0.0.1:');
        const ingestId=managed&&equivalent(endpoint)===equivalent(managed.playbackHlsUrl)?managed.ingestId:null;
        return Object.freeze({sourceId:source.id,endpoint,ingestId,
            endpointFingerprint:hashIdentity(endpoint),
            fingerprint:hashIdentity(JSON.stringify([source.id,source.revision??null,source.configRef??null,endpoint,ingestId])),
            authority:ingestId?'managed-ingest':'external-hls-http'});
    }catch{return null;}
}
export const capabilities=authority=>Object.freeze({presenceEvidence:true,playlistProgressEvidence:authority==='external-hls-http',
    segmentReachabilityEvidence:authority==='external-hls-http',decoderProgressEvidence:false});
export function observation(value){
    const keys=['version','sourceId','sourceFingerprint','endpointFingerprint','authority','sessionId','generation','sequence','observedAt','validUntil',
        'state','reason','publisherPresent','playbackAvailable','playbackProgressing','playlistProgressing','segmentReachable','readiness','freshness','uncertain','capabilities'];
    if(!value||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||value.version!==1||!id(value.sourceId)||!id(value.sessionId)||
        !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)||!/^[a-f0-9]{64}$/.test(value.endpointFingerprint)||
        !['managed-ingest','external-hls-http'].includes(value.authority)||!HEALTH_STATES.includes(value.state)||
        !['observing','publisher-present','transport-only','unavailable'].includes(value.readiness)||
        !['FRESH','EXPIRED','INACTIVE'].includes(value.freshness)||typeof value.uncertain!=='boolean'||
        !/^[A-Z0-9_]{1,80}$/.test(value.reason)||
        !['generation','sequence'].every(k=>Number.isSafeInteger(value[k])&&value[k]>0)||
        !['observedAt','validUntil'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0)||value.validUntil<value.observedAt||
        !['publisherPresent','playbackAvailable','playlistProgressing','segmentReachable'].every(k=>value[k]===null||typeof value[k]==='boolean')||
        value.playbackProgressing!==null||JSON.stringify(value.capabilities)!==JSON.stringify(capabilities(value.authority)))throw error('INVALID_HEALTH_OBSERVATION');
    return freeze({...value,capabilities:{...value.capabilities}});
}
export function freshObservation(value,now){
    return value&&now>value.validUntil&&value.freshness==='FRESH'
        ?observation({...value,state:'UNKNOWN',freshness:'EXPIRED',reason:'OBSERVATION_EXPIRED',uncertain:true,
            publisherPresent:null,playbackAvailable:null,playlistProgressing:null,segmentReachable:null,readiness:'unavailable'}):value;
}
