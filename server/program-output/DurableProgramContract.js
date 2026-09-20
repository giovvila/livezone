import {createHash} from 'node:crypto';
import {validateProgramOutputEnvelope} from '../../public/js/program-output/ProgramOutputEnvelope.js';
export const MAX_DURABLE_BYTES=128*1024;
export function canonical(value){return JSON.stringify(sort(value));}
function sort(value){if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])]));return value;}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function recordFor({envelope,retiredPublisherSessions,identity,generation,authorityEpoch=0}){
 const body={schemaVersion:1,generation,acceptedAt:new Date().toISOString(),acceptedAuthorityEpoch:authorityEpoch,
  programState:envelope.snapshot.scene?'PRESENT':'EXPLICIT_EMPTY',envelope,identity,retiredPublisherSessions};
 return {...body,checksum:{algorithm:'sha256',value:digest(body)}};
}
export function validateRecord(value){
 if(!value||value.schemaVersion!==1||!Number.isSafeInteger(value.generation)||value.generation<1||
  !Number.isSafeInteger(value.acceptedAuthorityEpoch)||value.acceptedAuthorityEpoch<0||!Number.isFinite(Date.parse(value.acceptedAt)))throw Error('DURABLE_CORRUPT');
 const {checksum,...body}=value;
 if(checksum?.algorithm!=='sha256'||checksum.value!==digest(body))throw Error('DURABLE_CORRUPT');
 const envelope=validateProgramOutputEnvelope(value.envelope),retired=value.retiredPublisherSessions;
 if(!envelope||value.envelope.snapshot.output!==undefined||value.envelope.snapshot.overlays?.sponsor!==undefined||value.envelope.snapshot.overlays?.textCrawl?.scheduled!==undefined||
  value.programState!==(envelope.snapshot.scene?'PRESENT':'EXPLICIT_EMPTY')||!value.identity||!Array.isArray(value.identity.assets)||
  !Array.isArray(retired)||retired.length>100||new Set(retired).size!==retired.length||retired.includes(envelope.publisherSessionId)||
  retired.some(id=>typeof id!=='string'||!id.trim()||id.length>120))throw Error('DURABLE_CORRUPT');
 return value;
}
