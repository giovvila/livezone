import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import Ledger from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import Scheduled from '../server/scheduler/ScheduledLiveExecutionRepository.js';
import {completedTransaction,fixtureProgram} from '../test-support/CompletedScheduledHistoryFixture.mjs';
import {ledgerRecoveryEvidence,reconcileScheduledEntryLedgerV2} from '../server/scheduler/ReconcileScheduledEntryLedgerV2.js';
import {inspectV2,terminalShutdown} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const variations={
    'exact R19 invalid UTF8 replacement collision':valid=>{
        const offset=valid.indexOf(Buffer.from('\uFFFD'));assert.ok(offset>=0);
        const damaged=Buffer.concat([valid.subarray(0,offset),Buffer.from([0xff]),valid.subarray(offset+3)]);
        assert.equal(valid.toString('utf8'),damaged.toString('utf8'));
        assert.equal(valid.length-damaged.length,2);
        assert.equal(Buffer.from(damaged.toString('utf8')).equals(damaged),false);
        return damaged;
    },
    'valid UTF8 change':valid=>Buffer.from(valid.toString().replace('literal-','changed-')),
    'BOM introduction':valid=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),valid]),
    'LF to CRLF':valid=>Buffer.from(valid.toString().replaceAll('\n','\r\n')),
    'trailing whitespace':valid=>Buffer.concat([valid,Buffer.from(' \t')]),
    'JSON whitespace':valid=>Buffer.from(JSON.stringify(JSON.parse(valid),null,2)+'\n'),
    'JSON key order':valid=>Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(valid)).reverse()))+'\n')
};
// Original R19 proof providers and namespace ACK are semantic TEMP fixtures.
// No runtime/service/native ownership-death claim is made by this regression.
for(const [name,change] of Object.entries(variations))test('R20 terminal PREPARED fence: '+name,async()=>{
    const root=await mkdtemp(join(tmpdir(),'lz-r20-r19-'));
    const path=join(root,'ledger'),authorityPath=join(root,'authority'),scheduledPath=join(root,'scheduled');
    const authority={available:true,closed:false,path:authorityPath,authorityEpoch:22,authorityProcessSession:'r19-encoding'};
    const ledger=new Ledger({path,create:true,authority,syncDirectory:()=> 'DIRECTORY_SYNCED'});
    const scheduled=new Scheduled({path:scheduledPath,publicRoot:join(root,'public'),authority});
    try{
        await writeFile(authorityPath,JSON.stringify({epoch:22}));
        await writeFile(path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:22}));
        await ledger.initialize();assert.equal(ledger.status,'READY',ledger.error);
        await scheduled.initialize();assert.equal(scheduled.status,'READY',scheduled.error);
        const program=structuredClone(fixtureProgram());program.snapshot.scene.name='literal-\uFFFD';
        await scheduled.write(completedTransaction(program));await ledger.finalize();await scheduled.close();
        assert.equal(terminalShutdown(await inspectV2(path),ledger.lockOwner),true);
        const valid=await readFile(scheduledPath),damaged=change(valid);
        assert.notDeepEqual(valid,damaged);assert.notEqual(sha(valid),sha(damaged));
        const args={path,authorityPath,scheduledPath,operationId:'r19-encoding',
            proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]}),
            reserve:async()=>()=>{},isAlive:()=>false,syncDirectory:()=> 'DIRECTORY_SYNCED'};
        const before=await ledgerRecoveryEvidence(args);args.expected=before.hashes;
        const protectedBefore=await Promise.all([path,path+'.wal',path+'.lock'].map(p=>readFile(p)));
        let injected=false;
        args.hook=async stage=>{if(stage==='prepared'){injected=true;await writeFile(scheduledPath,damaged);}};
        let result,error;try{result=await reconcileScheduledEntryLedgerV2(args);}catch(e){error=e;}
        assert.equal(injected,true);assert.ok(error,'changed journal must reject before lock archival; actual='+JSON.stringify(result));
        assert.ok(['PERSISTENT_EVIDENCE_INVALID_UTF8','LEDGER_V2_EVIDENCE_RACE'].includes(error.code),error.stack);
        assert.deepEqual(await Promise.all([path,path+'.wal',path+'.lock'].map(p=>readFile(p))),protectedBefore);
        await assert.rejects(access(path+'.lock.reconciled-r19-encoding'),{code:'ENOENT'});
        await assert.rejects(access(path+'.recovery-r19-encoding.json.completed'),{code:'ENOENT'});
        assert.equal(JSON.parse(await readFile(path+'.recovery-r19-encoding.json')).state,'PREPARED');
        assert.deepEqual(await readFile(scheduledPath),damaged);
        console.log(JSON.stringify({case:name,validBytes:valid.length,changedBytes:damaged.length,
            beforeHash:sha(valid),afterHash:sha(damaged),error:error.code,lockPreserved:true,archive:false,completion:false}));
    }finally{
        await scheduled.close();await ledger.close().catch(()=>{});
        const rel=relative(tmpdir(),root);assert.ok(rel.startsWith('lz-r20-r19-')&&!rel.startsWith('..')&&!isAbsolute(rel));
        await rm(root,{recursive:true,force:true});
    }
});
