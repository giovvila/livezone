import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';
import AutoLiveAuthority from '../server/autolive/AutoLiveAuthority.js';
import RestartReconciliation from '../server/autolive/RestartReconciliation.js';
import DurableProgramRepository from '../server/program-output/DurableProgramRepository.js';
import ProgramCommitCoordinator from '../server/program-output/ProgramCommitCoordinator.js';
import ProgramOutputStore from '../server/program-output/ProgramOutputStore.js';
import ProgramRestoreValidation from '../server/program-output/ProgramRestoreValidation.js';
import SchedulerServer from '../server/scheduler/SchedulerServer.js';
import Ledger from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import ScheduledRepository from '../server/scheduler/ScheduledLiveExecutionRepository.js';
import {executionEraStartup} from '../server/recovery/ExecutionEraContract.js';
import {readFile} from 'node:fs/promises';
import {testDurability} from './NewExecutionEraFixture.js';

// A component fixture for the actual ControlledStart function. No HTTP server,
// Windows service, network ingest or protected H1 module is constructed.
export function componentLaunch(f,{native=false,clock=()=>Date.parse('2030-01-01T11:50:00Z')}={}){
    const owners=[];
    function launch(options){
        const owner={};owners.push(owner);
        owner.executionOwnership=new BrowserExecutionOwnership({path:f.paths.authority,eraLedgerPath:f.paths.ledger,
            clock,...options.executionOwnershipOptions,...(native?{}:{eraDurability:testDurability})});
        const initialized=(async()=>{
            await owner.executionOwnership.ready;
            if(!owner.executionOwnership.available)throw Error(owner.executionOwnership.initializationError);
            const retained=JSON.parse(await readFile(f.paths.program)),config=JSON.parse(await readFile(f.paths.autoLive));
            const catalog={initialized:true,sources:[{...retained.identity.catalog.source,enabled:true},
                {id:config.sourceId,kind:'hls',enabled:true,url:'https://example.test/era.m3u8'}],scenes:[retained.identity.catalog.scene]};
            owner.catalog=catalog;owner.store=new ProgramOutputStore();
            const validator=new ProgramRestoreValidation({catalog:()=>catalog,assets:{list:()=>[],get:()=>null}});
            owner.durableProgram=new DurableProgramRepository({path:f.paths.program});
            owner.programCommits=new ProgramCommitCoordinator({repository:owner.durableProgram,store:owner.store,
                bind:value=>validator.bind(value),validate:record=>validator.validate(record),authorityEpoch:()=>owner.executionOwnership.authorityEpoch});
            await owner.programCommits.initialize();
            owner.autoLive=new AutoLiveAuthority({path:f.paths.autoLive,recoveryPath:f.paths.autoLive+'.recovery',catalog:()=>catalog,clock});
            await owner.autoLive.ready;
            owner.ledger=new Ledger({path:f.paths.ledger,authority:owner.executionOwnership,...(native?{}:{syncDirectory:testDurability.sync})});
            await owner.ledger.initialize();if(owner.ledger.status!=='READY')throw Error(owner.ledger.error);
            owner.scheduledRepository=new ScheduledRepository({path:f.paths.scheduledJournal,publicRoot:f.root+'/public',
                authority:owner.executionOwnership,...(native?{}:{eraDurability:testDurability})});
            await owner.scheduledRepository.initialize();
            if(owner.scheduledRepository.status!=='READY')throw Error(owner.scheduledRepository.error);
            owner.scheduledLiveExecutionRepository=owner.scheduledRepository;
            owner.scheduler=new SchedulerServer({path:f.paths.schedule,executionEra:executionEraStartup(f.paths.ledger),
                authority:owner.executionOwnership,clock,setTimer:()=>({unref(){}}),clearTimer:()=>{},...(native?{}:{eraDurability:testDurability})});
            await owner.scheduler.ready;
            owner.restartReconciliation=new RestartReconciliation({ownership:owner.executionOwnership,store:owner.store,
                durable:()=>({status:owner.durableProgram.status,generation:owner.durableProgram.record.generation}),
                configuration:()=>({available:owner.autoLive.available(),revision:owner.autoLive.store.state.revision,
                    sourceFingerprint:owner.autoLive.healthRuntime().resolvedSourceFingerprint})});
        })();
        owner.scheduler={ready:initialized};owner.autoLive={ready:initialized};
        owner.programReady=initialized;owner.scheduledEntryReady=initialized;owner.scheduledLiveExecutionReady=initialized;
        owner.close=async()=>{await initialized.catch(()=>{});await owner.scheduler?.close?.();await owner.scheduledRepository?.close();await owner.ledger?.close();
            await owner.autoLive?.close?.();await owner.executionOwnership.close();};
        return owner;
    }
    return {launch,owners,close:async()=>{for(const owner of owners)await owner.close();}};
}
