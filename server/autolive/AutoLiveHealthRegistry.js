import {randomUUID} from 'node:crypto';
import {observation,capabilities,freshObservation} from './AutoLiveHealthContract.js';
import {error} from './AutoLiveContract.js';
import {abortable} from './AutoLiveSafeHttp.js';
import AutoLiveHlsObserver from './AutoLiveHlsObserver.js';

export class ManagedIngestHealthProducer {
    constructor(client){this.client=client;}
    async sample(source,signal){
        const status=await this.client.getStatus({sourceOnly:true,signal});
        if(status.ingestId!==source.ingestId||status.playbackHlsUrl!==this.client.config?.playbackHlsUrl)throw error('MAPPING_MISMATCH');
        const present=status.health?.publisherPresent;
        return {state:status.state==='error'?'ERROR':present?'ONLINE':status.state==='offline'?'OFFLINE':'UNCERTAIN',
            reason:status.state==='error'?'MANAGED_API_ERROR':present?'PUBLISHER_TRACKS_PRESENT':status.state==='offline'?'PUBLISHER_ABSENT':'TRACKS_UNCERTAIN',
            publisherPresent:status.state==='error'?null:present===true,playbackAvailable:null,playlistProgressing:null,segmentReachable:null,
            readiness:present?'publisher-present':'unavailable'};
    }
}
// Server-owned demand, never one instance per API/SSE client. One sample in flight
// per entry; abort and generation fencing precede every release/source replacement.
export default class AutoLiveHealthRegistry {
    constructor({managedClient,http,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,
        intervalMs=3000,ttlMs=10000,timeoutMs=7000,producerFactory}={}){
        Object.assign(this,{clock,setTimer,clearTimer,intervalMs,ttlMs,timeoutMs});
        this.factory=producerFactory||((source)=>source.ingestId?new ManagedIngestHealthProducer(managedClient):new AutoLiveHlsObserver({http,clock}));
        this.entries=new Map();this.generation=0;this.sessionId=randomUUID();
    }
    acquire(source,listener){
        if(this.closed)throw error('HEALTH_CLOSED');const key=source.sourceId+':'+source.fingerprint;let entry=this.entries.get(key);
        if(!entry){
            if(this.entries.size>=4)throw error('HEALTH_CAPACITY');
            entry={key,source,generation:++this.generation,listeners:new Set(),sequence:0,producer:this.factory(source)};
            this.entries.set(key,entry);this.publish(entry,{state:'CHECKING',reason:'STARTING',readiness:'observing'});
        }
        entry.listeners.add(listener);listener(this.current(entry));if(!entry.started){entry.started=true;void this.poll(entry);}
        let released=false;
        return {getSnapshot:()=>this.current(entry),release:()=>{if(released)return;released=true;entry.listeners.delete(listener);if(!entry.listeners.size)this.dispose(entry);}};
    }
    current(entry){return freshObservation(entry.value,this.clock());}
    notify(entry){for(const listener of entry.listeners)try{listener(this.current(entry));}catch{}}
    publish(entry,measurement){
        if(this.entries.get(entry.key)!==entry)return false;
        const now=this.clock();
        const value=observation({version:1,sourceId:entry.source.sourceId,sourceFingerprint:entry.source.fingerprint,endpointFingerprint:entry.source.endpointFingerprint,
            authority:entry.source.authority,sessionId:this.sessionId,generation:entry.generation,sequence:++entry.sequence,
            observedAt:now,validUntil:now+this.ttlMs,state:measurement.state,reason:measurement.reason,
            publisherPresent:measurement.publisherPresent??null,playbackAvailable:measurement.playbackAvailable??null,playbackProgressing:null,
            playlistProgressing:measurement.playlistProgressing??null,segmentReachable:measurement.segmentReachable??null,
            readiness:measurement.readiness||'unavailable',freshness:'FRESH',uncertain:measurement.state!=='ONLINE'&&measurement.state!=='OFFLINE',
            capabilities:capabilities(entry.source.authority)});
        return this.accept(entry,value);
    }
    accept(entry,value){
        try{value=observation(value);}catch{return false;}
        if(this.entries.get(entry.key)!==entry||value.sessionId!==this.sessionId||value.generation!==entry.generation||
            value.sourceFingerprint!==entry.source.fingerprint||value.sourceId!==entry.source.sourceId||value.endpointFingerprint!==entry.source.endpointFingerprint||
            value.authority!==entry.source.authority||value.sequence<=(entry.value?.sequence??0)||value.observedAt>this.clock()||value.validUntil<this.clock())return false;
        entry.value=value;this.clearTimer(entry.expiry);
        entry.expiry=this.setTimer(()=>{if(this.entries.get(entry.key)===entry)this.notify(entry);},Math.max(1,value.validUntil-this.clock()+1));entry.expiry?.unref?.();
        this.notify(entry);return true;
    }
    async poll(entry){
        if(this.entries.get(entry.key)!==entry||entry.running)return;entry.running=true;
        const controller=entry.controller=new AbortController();const timeout=this.setTimer(()=>controller.abort(),this.timeoutMs);
        try{this.publish(entry,await abortable(Promise.resolve().then(()=>entry.producer.sample(entry.source,controller.signal)),controller.signal));}
        catch(e){const allowed=['ADDRESS_FORBIDDEN','URL_FORBIDDEN','REDIRECT_LIMIT','REDIRECT_INVALID','BODY_LIMIT','ENCODING_UNSUPPORTED',
            'HTTP_ERROR','NETWORK_ERROR','ABORTED','PLAYLIST_INVALID','SEGMENT_EMPTY','VARIANT_DEPTH','MAPPING_MISMATCH'];
            this.publish(entry,{state:'ERROR',reason:allowed.includes(e.code)?e.code:'HEALTH_PROBE_ERROR'});}
        finally{this.clearTimer(timeout);controller.abort();entry.running=false;
            if(this.entries.get(entry.key)===entry){entry.timer=this.setTimer(()=>void this.poll(entry),this.intervalMs);entry.timer?.unref?.();}}
    }
    dispose(entry){this.entries.delete(entry.key);entry.controller?.abort();this.clearTimer(entry.timer);this.clearTimer(entry.expiry);entry.listeners.clear();entry.producer.close?.();}
    close(){this.closed=true;for(const entry of [...this.entries.values()])this.dispose(entry);}
}
