import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ledgerReconciliationBoundaries,verifyLedgerReconciliationCase} from '../test-support/EraLedgerReconciliationCases.js';

const matrix=new URL('../docs/NEW-ERA-07-NATIVE-ABRUPT-MATRIX.csv',import.meta.url);
async function rows(){return (await readFile(matrix,'utf8')).trim().split(/\r?\n/).slice(1).map(line=>{
    const match=line.match(/^(\d+),("(?:[^"\\]|\\.)*")/);assert.ok(match);
    return {index:Number(match[1]),boundary:JSON.parse(match[2])};
});}
test('510 unique matrix IDs include exactly thirteen new named Ledger reconciliation hooks',async()=>{
    const all=await rows();assert.equal(all.length,510);assert.equal(new Set(all.map(r=>r.index)).size,510);
    assert.equal(new Set(all.map(r=>r.boundary)).size,510);
    for(const boundary of ledgerReconciliationBoundaries)assert.equal(all.filter(r=>r.boundary===boundary).length,1);
    const protocol=await readFile(new URL('../server/scheduler/ScheduledEntryLedgerV2Protocol.js',import.meta.url),'utf8');
    const install=protocol.slice(protocol.indexOf('export async function install('),protocol.indexOf('export async function recoverV2('));
    const installHooks=[...install.matchAll(/hook\('([^']+)'\)/g)].map(m=>'ledger-reconciliation/'+m[1]);
    assert.deepEqual(installHooks,ledgerReconciliationBoundaries.slice(0,7));
    const append=protocol.slice(protocol.indexOf('export async function append('),protocol.indexOf('export async function append(')+1500);
    for(const suffix of ['opened','written','flushed'])assert.ok(append.includes("+'-"+suffix+"'"));
    assert.match(protocol,/await append\(path,state.records,'COMMIT'/);
    const reconcile=await readFile(new URL('../server/scheduler/ReconcileScheduledEntryLedgerV2.js',import.meta.url),'utf8');
    assert.match(reconcile,/await append\(path,state.records,'END'/);
    const workflow=await readFile(new URL('../server/recovery/NewEraRecoveryWorkflow.js',import.meta.url),'utf8');
    assert.ok(workflow.includes("hook:point=>this.hook('ledger-reconciliation/'+point)"));
});

test('canonical matrix Ledger reconciliation subset uses independent abrupt TEMP fixtures',{
    skip:process.env.LZ_ERA16B_RUN_MATRIX_SUBSET!=='1'
},async()=>{
    const all=await rows(),selected=all.filter(r=>r.boundary.includes('ledger-reconciliation/')||r.boundary==='restart/terminal-ledger-recovery');
    assert.equal(selected.length,36);
    const evidence=process.env.LZ_ERA16B_SUBSET_EVIDENCE_DIRECTORY??await mkdtemp(join(tmpdir(),'lz-era16b-subset-'));
    const native=process.env.LZ_TEST_NATIVE_DURABILITY==='1';
    const old=selected.filter(r=>!ledgerReconciliationBoundaries.includes(r.boundary)).map(r=>({...r,
        operation:r.boundary.startsWith('completed-owner-recovery/')?'recover-completed':'recover'}));
    assert.equal(old.length,23);
    const groups=Array.from({length:4},()=>[]),children=new Set();
    old.forEach((row,index)=>groups[index%groups.length].push(row));
    const inputs=await Promise.all(groups.map(async(group,index)=>{
        const input=join(evidence,'existing-subset-input-'+index+'.json');
        await writeFile(input,JSON.stringify({worker:'era16b-subset-'+index,rows:group,evidenceDirectory:evidence,native}));return input;
    }));
    const statuses=await Promise.all(inputs.map(input=>new Promise((resolve,reject)=>{
        const env={...process.env};delete env.NODE_TEST_CONTEXT;
        const child=spawn(process.execPath,[fileURLToPath(new URL('../test-support/NewEraControlledMatrixWorker.mjs',import.meta.url)),input],
            {env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.add(child);
        child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));
        child.once('error',error=>{for(const other of children)other.kill();reject(error);});
        child.once('close',code=>{children.delete(child);if(code!==0)for(const other of children)other.kill();resolve(code);});
    })));
    assert.ok(statuses.every(code=>code===0),'STOP_AFTER_FAILED_EXISTING_LEDGER_SUBSET_CASE: '+JSON.stringify(statuses));
    for(const row of old){const result=JSON.parse(await readFile(join(evidence,'controlled-matrix-'+String(row.index).padStart(4,'0')+'.json')));
        assert.equal(result.boundary,row.boundary);assert.equal(result.status,'PASS');}
    for(const row of selected.filter(r=>ledgerReconciliationBoundaries.includes(r.boundary)))
        await verifyLedgerReconciliationCase(row.boundary,{native,evidenceDirectory:evidence});
    await writeFile(join(evidence,'subset-summary.json'),JSON.stringify({matrixTotal:all.length,selected:36,existing:23,added:13,passed:36,native},null,2)+'\n');
});
