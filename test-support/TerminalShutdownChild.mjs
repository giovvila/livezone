import {writeFile} from 'node:fs/promises';
import {artifact} from '../server/recovery/RecoveryContract.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {terminalShutdownFixture} from './TerminalShutdownFixture.mjs';
const [output,point='exact']=process.argv.slice(2),h=await terminalShutdownFixture({after(){}});
const points={'after-drain-before-END':'end-opened','during-END':'end-written','after-END-fsync':'end-flushed','after-terminal-barrier':'shutdown-durable','before-ledger-release':'before-lock-release','after-ledger-release':'lock-released'};
const started=await controlledStart({workflow:h.w,authorizeStart:true,launch:options=>h.launch({...options,scheduledEntryLedgerOptions:{...options.scheduledEntryLedgerOptions,hook:stage=>{
    // Same interruption window on the original parallel implementation and on
    // the new terminal/release contract; no companion lock is deleted by tests.
    if(stage===(points[point]??(typeof h.owner?.scheduledEntry.ledger?.finalize==='function'?'before-lock-release':'shutdown-durable')))throw Error('R17_TERMINAL_INTERRUPTION');
}}})});
process.on('unhandledRejection',async e=>{if(!String(e).includes('R17_TERMINAL_INTERRUPTION')){console.error(e);process.exit(2);}await observe();});
let observed=false;
async function observe(){if(observed)return;observed=true;const state=await inspectV2(h.p.ledger);await writeFile(output,JSON.stringify({root:h.root,p:h.p,pid:process.pid,snapshot:h.snapshot,ready:await artifact(h.w.audit+'.ready'),ledgerLock:await artifact(h.p.ledgerLock),authorityLock:await artifact(h.p.authorityLock),scheduledLock:await artifact(h.p.scheduledLock),lastType:state.records.at(-1).type,owner:state.owner,pending:state.pending}));process.exit(77);}
if(point==='before-admission')started.owner.scheduledEntry.close=()=>{throw Error('R17_TERMINAL_INTERRUPTION');};
if(point==='during-drain')started.owner.scheduledEntry.idle=async()=>{throw Error('R17_TERMINAL_INTERRUPTION');};
for(const [name,component] of [['Scheduled',started.owner.scheduledLiveExecutionRepository],['authority',started.owner.executionOwnership]]){
    if(point==='before-'+name+'-release')component.close=async()=>{throw Error('R17_TERMINAL_INTERRUPTION');};
    if(point==='after-'+name+'-release'){const close=component.close.bind(component);component.close=async()=>{await close();throw Error('R17_TERMINAL_INTERRUPTION');};}
}
try{started.owner.server.close(async error=>{if(error&&String(error).includes('R17_TERMINAL_INTERRUPTION'))await observe();else{console.error('Unexpected successful drain',error);process.exit(3);}});}
catch(error){if(String(error).includes('R17_TERMINAL_INTERRUPTION'))await observe();else throw error;}
