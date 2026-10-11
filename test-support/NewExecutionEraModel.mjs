// Specification model only. Not a runtime writer, CLI, native durability proof,
// or authorization to change a real repository. All persistence lives in TEMP.
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash,seal,equal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';

export const HEAD='0eb3aa2906f574f1da3815f96313678261a3b2ec';
export const STAGES=Object.freeze(['AUTHORIZED','FORENSIC_SNAPSHOT','RETIREMENT','INTENT','LEDGER','ACTIVATED']);
export const knownSnapshot=()=>({head:HEAD,branch:'build/1003.9A1',epoch:22,
    ledger:{schemaVersion:1,ledgerId:'ebd717e3-cbf0-4215-a9ec-484b096b3737',generation:0,entries:[]},
    ledgerLock:{version:1,pid:10236,processSession:'a9fbb491-22af-45e9-a234-ae8032b02330'},
    authorityLock:{pid:10236,authorityProcessSession:'93504701-59ce-436e-8415-744d9773aa02'},
    scheduledLock:{schemaVersion:2,processId:10236,authorityEpoch:22,
        authorityProcessSession:'93504701-59ce-436e-8415-744d9773aa02',
        repositoryId:'1e59d75b6db6769f089ff855e23c08248066e2ac61d53b4e63ce722bd9268fe1'},
    observedPidRunning:false,observedV2:{wal:false,activation:false,migrationArtifacts:false},
    marker:{version:1,authorityEpoch:21},
    auto:{version:1,revision:27,enabled:true,armed:false,sourceId:'live-73e8c51e-1c6d-4481-b351-9f3a9b9d6fe4'},
    program:{generation:47,programState:'PRESENT',acceptedAuthorityEpoch:20},
    schedule:{version:3,revision:54,knownHistoricalIds:['live-01091877-5a16-4986-9ac8-8986504567a6','live-29771f19-e4f2-49ab-b5ac-cde3863a6e6d']},
    suppliedHashes:{ledger:'9abf9d7b096da3ea429ef8a107df99c41ddf649ad34a737e6f96847a2cafa363',
        marker:'222970a3722826de473740aac82b4a27dc02ac7c956ce8544078608dbf5aad93',
        program:'dab83c76a69304a1a361f8e16e3f02d4d77a1d2a40e85814cde256913db7b2e5',
        schedule:'9c0db63aaa7d2b7432aed590ce1dde10b6cf59f784717f0e0fd13ea0bcb7681e'},
    evidenceKind:'SUPPLIED_SUMMARY_NOT_ORIGINAL_BYTES'});

export function dryRun(snapshot){
    const known=equal(snapshot,knownSnapshot());
    return {classification:snapshot?.ledgerLock?.version===1?'LEGACY_LEDGER_LOCK_UNVERIFIABLE':'UNKNOWN_LEGACY_STATE',
        fingerprint:known?'KNOWN_SUPPLIED_SUMMARY':'CHANGED_OR_UNKNOWN',
        exactBytesVerified:false,eligibleForRealExecution:false,
        blockers:['ORIGINAL_BYTE_EVIDENCE_REQUIRED','PRODUCTION_ERA_INTEGRATION_REQUIRED','NATIVE_RUNTIME_ACCOUNT_VALIDATION_REQUIRED']};
}

export class NewExecutionEraModel {
    constructor(directory,snapshot=knownSnapshot()){
        const rel=relative(resolve(tmpdir()),resolve(directory));
        if(!rel||rel.startsWith('..')||isAbsolute(rel)||!rel.startsWith('lz-new-era-model-'))throw Error('TEMP_ONLY');
        this.directory=directory;this.snapshot=structuredClone(snapshot);
    }
    async records(){
        const names=await readdir(this.directory);
        if(names.some(n=>!STAGES.some((s,i)=>n===`${i}-${s}.json`)))throw Error('UNKNOWN_ARTIFACT');
        const records=[];
        for(const [i,stage] of STAGES.entries()){
            const name=`${i}-${stage}.json`;
            if(!names.includes(name)){
                if(names.some(n=>Number(n.split('-')[0])>i))throw Error('PHASE_GAP');
                break;
            }
            const record=JSON.parse(await readFile(join(this.directory,name),'utf8'));
            const {checksum,...value}=record;
            if(checksum!==hash(value)||value.stage!==stage||value.previous!==(records.at(-1)?.checksum??null)||
                value.snapshotHash!==hash(this.snapshot)||!equal(value.payload,records[0]?.payload??value.payload))throw Error('CHAIN_CHANGED');
            records.push(record);
        }
        return records;
    }
    async transition(authorization,{interruptAfter}={}){
        const expected={action:'AUTHORIZE_NEW_EXECUTION_ERA_AND_RETIRE_ALL_OLD_IDENTITIES',head:HEAD,snapshotHash:hash(this.snapshot)};
        if(!equal(authorization,expected)||dryRun(this.snapshot).fingerprint!=='KNOWN_SUPPLIED_SUMMARY')throw Error('AUTHORIZATION_REQUIRED');
        const records=await this.records();
        const payload=records[0]?.payload??{executionEraId:randomUUID(),ledgerId:randomUUID(),
            oldEraId:hash({kind:'LEGACY_FORENSIC_ERA',snapshot:this.snapshot}),
            snapshot:this.snapshot,authorization,retirement:'ALL_IDENTITIES_WITHOUT_NEW_ERA_SERVER_GRANT',
            ledger:{generation:0,entries:[]},authorityPolicy:'NEXT_EXCLUSIVE_OWNER_INCREMENTS_PERSISTED_EPOCH',
            evidenceKind:'MODEL_SUMMARY_ONLY'};
        for(let i=records.length;i<STAGES.length;i++){
            const record=seal({stage:STAGES[i],previous:records.at(-1)?.checksum??null,snapshotHash:hash(this.snapshot),payload});
            await writeFile(join(this.directory,`${i}-${STAGES[i]}.json`),JSON.stringify(record)+'\n',{flag:'wx'});
            records.push(record);
            if(interruptAfter===STAGES[i])throw Error('MODEL_INTERRUPTION');
        }
        return payload;
    }
    async admission(event,grants){
        const records=await this.records();
        if(records.length!==STAGES.length)return false;
        const era=records[0].payload.executionEraId;
        return event?.executionEraId===era&&grants.some(g=>g.executionEraId===era&&g.eventId===event.id&&g.incarnationId===event.incarnationId);
    }
}
export const modelAuthorization=snapshot=>({action:'AUTHORIZE_NEW_EXECUTION_ERA_AND_RETIRE_ALL_OLD_IDENTITIES',head:HEAD,snapshotHash:hash(snapshot)});
