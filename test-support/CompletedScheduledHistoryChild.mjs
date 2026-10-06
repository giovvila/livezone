import {writeFile} from 'node:fs/promises';
import {artifact} from '../server/recovery/RecoveryContract.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {terminalShutdownFixture} from './TerminalShutdownFixture.mjs';
import {completedTransaction} from './CompletedScheduledHistoryFixture.mjs';

const [output,point='before-ledger-release']=process.argv.slice(2),h=await terminalShutdownFixture({after(){}});
const started=await controlledStart({workflow:h.w,authorizeStart:true,launch:options=>h.launch({...options,
    scheduledEntryLedgerOptions:{...options.scheduledEntryLedgerOptions,hook:stage=>{
        if(point==='before-ledger-release'&&stage==='before-lock-release')throw Error('R18_INTERRUPTION');
    }}})});
let captures=0,executions=0;
for(const [component,method,count] of [[started.owner.scheduledLiveOwnership,'capture',()=>captures++],
    [started.owner.scheduledLiveExecution,'commit',()=>executions++]]){
    const original=component[method].bind(component);component[method]=(...args)=>{count();return original(...args);};
}
await started.owner.scheduledLivePersistence.persist(completedTransaction());
const programBefore=await artifact(h.p.program);
for(const [name,component] of [['Scheduled',started.owner.scheduledLiveExecutionRepository],['authority',started.owner.executionOwnership]]){
    if(point==='before-'+name+'-release')component.close=async()=>{throw Error('R18_INTERRUPTION');};
    if(point==='after-'+name+'-release'){const close=component.close.bind(component);component.close=async()=>{await close();throw Error('R18_INTERRUPTION');};}
}
started.owner.server.close(async error=>{
    if(!String(error).includes('R18_INTERRUPTION')){console.error(error);process.exit(3);}
    const state=await inspectV2(h.p.ledger);
    await writeFile(output,JSON.stringify({root:h.root,p:h.p,pid:process.pid,snapshot:h.snapshot,
        ready:await artifact(h.w.audit+'.ready'),ledgerLock:await artifact(h.p.ledgerLock),
        authorityLock:await artifact(h.p.authorityLock),scheduledLock:await artifact(h.p.scheduledLock),
        scheduled:await artifact(h.p.scheduled),programBefore,programAfter:await artifact(h.p.program),
        captures,executions,lastType:state.records.at(-1).type,owner:state.owner,pending:state.pending}));
    process.exit(77);
});
