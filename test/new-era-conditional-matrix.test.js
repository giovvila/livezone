import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('conditional legacy Scheduled journal forensic blob covers every native publication boundary',async()=>{
    const evidence=resolve(process.env.LIVEZONE_ERA07_EVIDENCE_DIRECTORY??''),rel=relative(resolve(tmpdir()),evidence);
    assert.ok(rel.startsWith('lz-era07-')&&!rel.startsWith('..')&&!isAbsolute(rel));
    const rows=['before-open','opened','partial-written','written','file-flushed','namespace-flushed','before-install','installed','durable']
        .map((point,index)=>({boundary:'forensic/scheduledJournal/'+point,index:1000+index}));
    const statuses=await Promise.all([0,1].map(async index=>{
        const input=join(evidence,'conditional-worker-'+index+'.json');
        await writeFile(input,JSON.stringify({worker:index,rows:rows.filter((_,i)=>i%2===index),evidenceDirectory:evidence}));
        const env={...process.env};delete env.NODE_TEST_CONTEXT;
        return new Promise((ok,no)=>{
            const child=spawn(process.execPath,[fileURLToPath(new URL('../test-support/NewEraMatrixWorker.mjs',import.meta.url)),input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
            child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));child.once('error',no);child.once('exit',code=>ok(code));
        });
    }));
    assert.ok(statuses.every(code=>code===0),JSON.stringify(statuses));
    for(const row of rows){const result=JSON.parse(await readFile(join(evidence,'matrix-'+String(row.index).padStart(4,'0')+'.json'),'utf8'));
        assert.equal(result.boundary,row.boundary);assert.equal(result.status,'PASS');}
    await writeFile(join(evidence,'conditional-matrix-summary.json'),JSON.stringify({entries:9,executed:9,pass:9,unexpectedFail:0,notExecuted:0})+'\n');
});
