import {AtomicAutoLiveStore} from './AutoLiveStore.js';
import {normalizeRecovery,normalizeRecoveryState,error,id,freeze} from './AutoLiveContract.js';
import {ID_PATTERN} from '../media-library/MediaAssetRepository.js';

// Internal storage capability only: no production route or executive reader.
export default class AutoLiveRecoveryStore extends AtomicAutoLiveStore {
    // Diagnostic projection only. Never repair/promote invalid data into executable state.
    captureInvalidScope(parsed){
        const record=parsed?.record;
        const assets=Array.isArray(record?.assets)?record.assets.filter(a=>typeof a?.assetId==='string'&&ID_PATTERN.test(a.assetId))
            .map(a=>({assetId:a.assetId})):[];
        const sourceId=id(record?.sourceId)?record.sourceId:null;
        const sceneId=id(record?.sceneId)?record.sceneId:null;
        const expected=record?.expectedCurrentActivation;
        this.invalidScope=freeze({classification:assets.length||sourceId||sceneId||id(expected?.sourceId)||id(expected?.sceneId)
            ?'CORRUPT_BUT_SCOPABLE':parsed===undefined?'CORRUPT_UNSCOPABLE':'INVALID_NONAUTHORITATIVE',
            record:{assets,sourceId,sceneId,expectedCurrentActivation:{sourceId:id(expected?.sourceId)?expected.sourceId:null,sceneId:id(expected?.sceneId)?expected.sceneId:null}}});
    }
    referenceScope(){
        const record=this.getSnapshot()?.record;
        return {classification:this.status==='READY'?(record?'VALID':'EMPTY'):(this.invalidScope?.classification||'INVALID_NONAUTHORITATIVE'),
            record:record||this.invalidScope?.record||null,uncertain:this.status!=='READY',
            // A1 has no executive recovery reader/writer. An unreadable foundation file
            // is not evidence of a live authority capable of holding arbitrary assets.
            executionCapability:'storage-only',globallyIncomplete:false};
    }
    constructor(options){super({...options,normalize:normalizeRecoveryState,defaults:()=>normalizeRecoveryState({version:1,revision:0,record:null})});}
    save(value,revision){
        let record;try{record=normalizeRecovery(structuredClone(value));}catch(e){return Promise.reject(e);}
        return this.change(revision,current=>{
            if(current.record && (current.record.sessionId!==record.sessionId || current.record.actionKey!==record.actionKey ||
                current.record.createdAt!==record.createdAt || record.updatedAt<current.record.updatedAt))throw error('RECOVERY_CONFLICT');
            return {version:1,revision:current.revision+1,record};
        });
    }
    clear(revision,actionKey){return this.change(revision,current=>{
        if(current.record && current.record.actionKey!==actionKey)throw error('RECOVERY_CONFLICT');
        return {version:1,revision:current.revision+1,record:null};
    });}
}
