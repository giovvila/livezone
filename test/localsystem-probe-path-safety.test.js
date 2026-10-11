import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createProbeAdapter,validateProbeRoot,constrainTarget} from '../tools/localsystem-durability-probe.mjs';
test('probe rejects real runtime roots and escaped native targets before subprocess launch',()=>{
    const root=mkdtempSync(join(tmpdir(),'lz-era05-probe-'));
    try{
        assert.throws(()=>validateProbeRoot(resolve('var')),/PROBE_TEMP_ROOT_REQUIRED/);
        assert.throws(()=>validateProbeRoot('relative'),/PROBE_ABSOLUTE_ROOT_REQUIRED/);
        let launches=0;const adapter=createProbeAdapter(root,{run:()=>{launches++;throw Error('MUST_NOT_LAUNCH');}});
        for(const operation of [()=>adapter.capability(resolve('var')),()=>adapter.remove(resolve('var/never-create')),()=>adapter.replace(join(root,'stage'),resolve('var/never-create'))])
            assert.throws(operation,{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});
        assert.equal(launches,0);
        const simulated=join(root,'simulated-repository');mkdirSync(simulated);const sentinel=join(simulated,'sentinel');writeFileSync(sentinel,'ORIGINAL');
        const work=join(root,'work');mkdirSync(work);
        assert.throws(()=>constrainTarget(work,sentinel),/PROBE_TARGET_OUTSIDE_TEMP/);
        assert.equal(readFileSync(sentinel,'utf8'),'ORIGINAL');
        assert.throws(()=>constrainTarget(root,join(root,'..','escape')),/PROBE_TARGET_OUTSIDE_TEMP/);
    }finally{const rel=relative(resolve(tmpdir()),resolve(root));assert.ok(rel.startsWith('lz-era05-probe-')&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true});}
});
