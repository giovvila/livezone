import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('original authority/start/recovery rows and expanded publication boundaries use abrupt TEMP children',async()=>{
    const evidence=resolve(process.env.LIVEZONE_ERA07_EVIDENCE_DIRECTORY??''),rel=relative(resolve(tmpdir()),evidence);
    assert.ok(rel.startsWith('lz-era07-')&&!rel.startsWith('..')&&!isAbsolute(rel));
    const source=(await readFile(new URL('../docs/NEW-ERA-06-NATIVE-ABRUPT-MATRIX.csv',import.meta.url),'utf8')).trim().split(/\r?\n/).slice(1)
        .map((line,index)=>({boundary:JSON.parse(line.split(',')[0]),index}));
    const rows=source.filter(r=>!/^(phase\/|forensic\/|ledger\/|schedule\/|archive\/|phase-completed\/|before-schedule-replace$|schedule-replaced$)/.test(r.boundary));
    assert.equal(rows.length,14);
    for(const row of rows)if(/^(reconciliation\/|restart\/)/.test(row.boundary))row.operation='recover';
    if(process.env.LIVEZONE_CONTROLLED_EXPANDED==='1'){
        const points=['before-open','opened','partial-written','written','file-flushed','namespace-flushed','before-install','installed','durable'];
        const phases=['authority-intent','authority-successor','start','launch','claim','owned','ready','reconciliation-prepared','reconciled'];
        for(const phase of phases)for(const point of points)rows.push({boundary:'controlled/'+phase+'/'+point,index:261+rows.length-14,
            ...(phase.startsWith('reconcil')?{operation:'recover'}:{})});
        for(const phase of ['owner-anchor','ready-anchor'])for(const point of points)rows.push({boundary:phase+'/'+point,index:261+rows.length-14});
        for(const boundary of ['controlled-start/before-reservation','controlled-start/launch-reserved','before-controlled-launch','server-started',
            'controlled-start/before-ready-persist','controlled-start/ready-durable',...['prepared','recovered','archived','completed'].map(p=>'ledger-reconciliation/'+p),
            ...['prepared','archived','completed'].map(p=>'scheduled-reconciliation/'+p)])
            rows.push({boundary,index:261+rows.length-14,...(/^(ledger|scheduled)-reconciliation\//.test(boundary)?{operation:'recover'}:{})});
        for(const point of points)rows.push({boundary:'authority-epoch-stage/'+point,index:261+rows.length-14});
        for(const prefix of ['authority-owner-lock','authority-gate','ledger-reconciliation/gate','scheduled-reconciliation/gate'])
            for(const point of ['before-open','opened','partial-written','written','file-flushed','namespace-flushed','durable'])
                rows.push({boundary:prefix+'/'+point,index:261+rows.length-14,...(prefix.includes('reconciliation')?{operation:'recover'}:{})});
        const completedPoints=[...['reconciliation-prepared','reconciled'].flatMap(phase=>points.map(point=>'controlled/'+phase+'/'+point)),
            'reconciliation/prepared','reconciliation/archive','reconciliation/finalization',
            ...['prepared','recovered','archived','completed'].map(p=>'ledger-reconciliation/'+p),
            ...['prepared','archived','completed'].map(p=>'scheduled-reconciliation/'+p),
            ...['ledger-reconciliation/gate','scheduled-reconciliation/gate'].flatMap(prefix=>
                ['before-open','opened','partial-written','written','file-flushed','namespace-flushed','durable'].map(point=>prefix+'/'+point))];
        for(const point of completedPoints)rows.push({boundary:'completed-owner-recovery/'+point,index:261+rows.length-14,operation:'recover-completed'});
        for(const point of points)rows.push({boundary:'restart-authorization/'+point,index:261+rows.length-14,operation:'restart'});
    }
    assert.equal(new Set(rows.map(r=>r.boundary)).size,rows.length);
    await writeFile(join(evidence,'controlled-matrix-inventory.json'),JSON.stringify(rows,null,2)+'\n');
    const selected=process.env.LIVEZONE_CONTROLLED_BOUNDARIES?rows.filter(r=>JSON.parse(process.env.LIVEZONE_CONTROLLED_BOUNDARIES).includes(r.boundary)):rows;
    const count=Math.min(6,Number(process.env.LIVEZONE_MATRIX_WORKERS??2)),groups=Array.from({length:count},()=>[]);
    selected.forEach((r,i)=>groups[i%count].push(r));
    const statuses=await Promise.all(groups.map(async(group,index)=>{
        const input=join(evidence,'controlled-worker-'+index+'.json');
        await writeFile(input,JSON.stringify({worker:index,rows:group,evidenceDirectory:evidence,native:process.env.LIVEZONE_CONTROLLED_NATIVE!=='0'}));
        const env={...process.env};delete env.NODE_TEST_CONTEXT;
        return new Promise((ok,no)=>{
            const child=spawn(process.execPath,[fileURLToPath(new URL('../test-support/NewEraControlledMatrixWorker.mjs',import.meta.url)),input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
            child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));child.once('error',no);child.once('exit',code=>ok({worker:index,code}));
        });
    }));
    assert.ok(statuses.every(s=>s.code===0),JSON.stringify(statuses));
    const results=await Promise.all(selected.map(async row=>{
        const result=JSON.parse(await readFile(join(evidence,'controlled-matrix-'+String(row.index).padStart(4,'0')+'.json'),'utf8'));
        assert.equal(result.boundary,row.boundary);assert.equal(result.status,'PASS',JSON.stringify(result.error));return result;
    }));
    await writeFile(join(evidence,'controlled-matrix-summary.json'),JSON.stringify({native:process.env.LIVEZONE_CONTROLLED_NATIVE!=='0',entries:selected.length,
        executed:results.length,pass:results.length,unexpectedFail:0,notExecuted:0},null,2)+'\n');
});
