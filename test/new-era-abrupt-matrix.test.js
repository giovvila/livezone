import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('every original offline matrix row uses a fresh native TEMP child with real abrupt exit and production retry',
    {skip:process.platform!=='win32'},async()=>{
    const evidence=resolve(process.env.LIVEZONE_ERA07_EVIDENCE_DIRECTORY??'');
    const tempRelative=relative(resolve(tmpdir()),evidence);
    assert.ok(tempRelative.startsWith('lz-era07-')&&!tempRelative.startsWith('..')&&!isAbsolute(tempRelative));
    const text=await readFile(new URL('../docs/NEW-ERA-06-NATIVE-ABRUPT-MATRIX.csv',import.meta.url),'utf8');
    const source=text.trim().split(/\r?\n/).slice(1).map((line,index)=>({boundary:JSON.parse(line.split(',')[0]),index}));
    assert.equal(source.length,261);assert.equal(new Set(source.map(r=>r.boundary)).size,261);
    const rows=source.filter(r=>/^(phase\/|forensic\/|ledger\/|schedule\/|archive\/|phase-completed\/|before-schedule-replace$|schedule-replaced$)/.test(r.boundary));
    assert.equal(rows.length,247);
    const count=Math.min(6,Number(process.env.LIVEZONE_MATRIX_WORKERS??4));assert.ok(count>=1);
    const groups=Array.from({length:count},()=>[]);rows.forEach((row,index)=>groups[index%count].push(row));
    const workers=[];
    for(let index=0;index<count;index++){
        const input=join(evidence,'offline-worker-'+index+'.json');
        await writeFile(input,JSON.stringify({worker:index,rows:groups[index],evidenceDirectory:evidence}));
        const env={...process.env};delete env.NODE_TEST_CONTEXT;
        workers.push(new Promise((ok,no)=>{
            const child=spawn(process.execPath,[fileURLToPath(new URL('../test-support/NewEraMatrixWorker.mjs',import.meta.url)),input],
                {env,windowsHide:true,stdio:['ignore','pipe','pipe']});
            child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));
            child.once('error',no);child.once('exit',code=>ok({worker:index,code}));
        }));
    }
    const statuses=await Promise.all(workers);assert.ok(statuses.every(r=>r.code===0),JSON.stringify(statuses));
    const names=await readdir(evidence),results=[];
    for(const row of rows){const name='matrix-'+String(row.index).padStart(4,'0')+'.json';assert.ok(names.includes(name),row.boundary);
        const result=JSON.parse(await readFile(join(evidence,name),'utf8'));assert.equal(result.boundary,row.boundary);assert.equal(result.status,'PASS',JSON.stringify(result.error));results.push(result);}
    await writeFile(join(evidence,'offline-matrix-summary.json'),JSON.stringify({entries:247,executed:results.length,pass:results.length,unexpectedFail:0,notExecuted:0},null,2)+'\n');
});
