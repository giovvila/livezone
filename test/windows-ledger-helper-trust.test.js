import test from 'node:test';
import {registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync,existsSync,renameSync,linkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {helperPath,helperSha256,gatePath,gateSha256,executionHost} from '../server/scheduler/WindowsLedgerDurability.js';
const source=fileURLToPath(new URL('../tools/native/windows-ledger-durability/',import.meta.url));
const moduleSource=readFileSync(new URL('../server/scheduler/WindowsLedgerDurability.js',import.meta.url),'utf8');
const failure={code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'};
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function build(dir,script) {
    const r=spawnSync(join(dir,script),[],{shell:true,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:65536});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.ifError(r.error);
}
function copyDeployment(root,gate=gatePath,gatePin=gateSha256,image=helperPath,imagePin=helperSha256) {
    const moduleDir=join(root,'server','scheduler'),binaryDir=join(root,'tools','native','windows-ledger-durability','generated');
    mkdirSync(moduleDir,{recursive:true});mkdirSync(binaryDir,{recursive:true});
    const module=join(moduleDir,'WindowsLedgerDurability.mjs'),helper=join(binaryDir,'windows-ledger-durability.exe');
    writeFileSync(module,moduleSource.replace(gateSha256,gatePin).replace(helperSha256,imagePin));
    copyFileSync(gate,join(binaryDir,'LedgerExecutionGate.dll'));copyFileSync(image,helper);
    return {module,helper,binaryDir};
}
test('Windows helper trust: R6 regression, locked namespace attacks, byte-loaded gate and reproducible build',{skip:process.platform!=='win32',timeout:300000},async t=>{
    const temp=realpathSync(tmpdir()),root=mkdtempSync(join(temp,'lz-r7-trust-'));
    registerNativeTestRoot(root);
    const children=[];
    t.after(()=>{
        for(const child of children)child.kill();
        const rel=relative(temp,resolve(root));assert.ok(rel.startsWith('lz-r7-trust-')&&!rel.startsWith('..')&&!isAbsolute(rel));
        rmSync(root,{recursive:true,force:true});
    });
    const fake=join(root,'counterfeit');mkdirSync(fake);
    writeFileSync(join(fake,'main.cpp'),readFileSync(join(source,'main.cpp'),'utf8').replace('if(mutation) {','if(argc<0 && mutation) {').replace('directory.flush();','// R6 counterfeit omits the barrier.'));
    copyFileSync(join(source,'build-x64.cmd'),join(fake,'build-x64.cmd'));build(fake,'build-x64.cmd');
    const counterfeit=join(fake,'generated','windows-ledger-durability.exe');
    // PE overlay padding makes the attack same-size without depending on compiler layout.
    const counterfeitBytes=readFileSync(counterfeit),approvedSize=readFileSync(helperPath).length;
    assert.ok(counterfeitBytes.length<=approvedSize);
    writeFileSync(counterfeit,Buffer.concat([counterfeitBytes,Buffer.alloc(approvedSize-counterfeitBytes.length)]));
    assert.equal(readFileSync(counterfeit).length,readFileSync(helperPath).length,'R6 counterfeit is a same-size replacement');
    assert.notEqual(hash(counterfeit),helperSha256);
    const clean=join(root,'clean-source-build');mkdirSync(clean);
    for(const name of ['ExecutionGate.cs','build-gate.cmd'])copyFileSync(join(source,name),join(clean,name));
    build(clean,'build-gate.cmd');assert.equal(hash(join(clean,'generated','LedgerExecutionGate.dll')),gateSha256);
    for(const name of ['main.cpp','build-x64.cmd'])copyFileSync(join(source,name),join(clean,name));
    for(let repeat=0;repeat<2;repeat++) {
        build(clean,'build-x64.cmd');
        assert.equal(hash(join(clean,'generated','windows-ledger-durability.exe')),helperSha256);
    }
    let n=0;
    function next(){const dir=join(root,'case-'+(++n));mkdirSync(dir);return dir;}
    await t.test('counterfeit control can emit a valid protocol acknowledgement without the reviewed barrier',()=>{
        const dir=next(),stage=join(dir,'stage'),ledger=join(dir,'ledger');
        writeFileSync(stage,'new');writeFileSync(ledger,'old');
        const result=spawnSync(counterfeit,['durable-replace',stage,ledger],{windowsHide:true,encoding:'utf8'});
        assert.equal(result.status,0);assert.equal(result.stderr,'');
        const value=JSON.parse(result.stdout);
        assert.equal(value.ok,true);assert.equal(value.protocol,1);assert.equal(value.version,'1.0.0');
        assert.equal(value.barrier,'NTFS_DIRECTORY_FLUSH');assert.equal(readFileSync(ledger,'utf8'),'old');
        assert.equal(existsSync(stage),true,'counterfeit acknowledges a mutation it never performed');
    });
    await t.test('launch uses the held image volume path even if the original launch pathname is redirected',async()=>{
        const gateDir=join(root,'redirected-launch');mkdirSync(gateDir);
        const cs=readFileSync(join(source,'ExecutionGate.cs'),'utf8');
        assert.ok(cs.includes('var start=new ProcessStartInfo(image.ExecutionPath())'));
        writeFileSync(join(gateDir,'ExecutionGate.cs'),cs.replace('var start=new ProcessStartInfo',
            'executable="'+counterfeit.replaceAll('\\','\\\\')+'"; var start=new ProcessStartInfo'));
        copyFileSync(join(source,'build-gate.cmd'),join(gateDir,'build-gate.cmd'));build(gateDir,'build-gate.cmd');
        const dll=join(gateDir,'generated','LedgerExecutionGate.dll');
        const dir=next(),deployment=copyDeployment(dir,dll,hash(dll)),adapter=await import(pathToFileURL(deployment.module));
        const stage=join(dir,'stage'),ledger=join(dir,'ledger');writeFileSync(stage,'new');writeFileSync(ledger,'old');
        assert.equal(adapter.windowsLedgerDurability.replace(stage,ledger).ok,true);
        assert.equal(readFileSync(ledger,'utf8'),'new');assert.equal(existsSync(stage),false);
    });
    await t.test('exact R6 scheduling attack: replace A with valid-JSON/protocol B after real verification',async()=>{
        const dir=next(),deployment=copyDeployment(dir),adapter=await import(pathToFileURL(deployment.module));
        const stage=join(dir,'stage'),ledger=join(dir,'ledger');writeFileSync(stage,'new');writeFileSync(ledger,'old');let spawned=false;
        const guarded=adapter.createWindowsLedgerDurability({run:(exe,args,options)=>{
            assert.equal(exe,executionHost);
            copyFileSync(counterfeit,deployment.helper);spawned=true;return spawnSync(exe,args,options);
        }});
        assert.throws(()=>guarded.replace(stage,ledger),failure);assert.equal(spawned,true);
        assert.equal(readFileSync(ledger,'utf8'),'old');assert.equal(readFileSync(stage,'utf8'),'new');
    });
    for(const attack of ['rename-substitute','delete','junction','hardlink','gate-overwrite','gate-delete'])await t.test('between Node validation and gate entry: '+attack,async()=>{
        const dir=next(),deployment=copyDeployment(dir),adapter=await import(pathToFileURL(deployment.module));
        const stage=join(dir,'stage'),ledger=join(dir,'ledger');writeFileSync(stage,'new');writeFileSync(ledger,'old');
        const guarded=adapter.createWindowsLedgerDurability({run:(exe,args,options)=>{
            if(attack==='rename-substitute'){renameSync(deployment.helper,deployment.helper+'.away');copyFileSync(counterfeit,deployment.helper);}
            else if(attack==='delete')rmSync(deployment.helper);
            else if(attack==='junction'){renameSync(deployment.binaryDir,deployment.binaryDir+'.away');symlinkSync(deployment.binaryDir+'.away',deployment.binaryDir,'junction');}
            else if(attack==='hardlink')linkSync(deployment.helper,deployment.helper+'.alias');
            else if(attack==='gate-overwrite')writeFileSync(join(deployment.binaryDir,'LedgerExecutionGate.dll'),'malicious assembly pathname bytes');
            else rmSync(join(deployment.binaryDir,'LedgerExecutionGate.dll'));
            return spawnSync(exe,args,options);
        }});
        if(attack.startsWith('gate-')) {assert.equal(guarded.replace(stage,ledger).ok,true);assert.equal(readFileSync(ledger,'utf8'),'new');}
        else {assert.throws(()=>guarded.replace(stage,ledger),failure);assert.equal(readFileSync(ledger,'utf8'),'old');assert.equal(existsSync(stage),true);}
    });
    // Instrument only scheduling pauses in a separately pinned TEMP assembly; the production gate has no hook.
    for(const phase of ['before-launch','after-exit']) {
        const gateDir=join(root,phase);mkdirSync(gateDir);
        const marker=join(gateDir,'paused');
        const literal=marker.replaceAll('\\','\\\\');
        const pause='File.WriteAllText("'+literal+'","paused"); while(!File.Exists("'+literal+'.continue")) System.Threading.Thread.Sleep(10);';
        let cs=readFileSync(join(source,'ExecutionGate.cs'),'utf8');
        cs=phase==='before-launch'?cs.replace('using(var child=Process.Start(start))',pause+'\n            using(var child=Process.Start(start))'):
            cs.replace('foreach(var pin in pins)pin.Revalidate(); Verify(image,lines[1]);',pause+'\n                foreach(var pin in pins)pin.Revalidate(); Verify(image,lines[1]);');
        writeFileSync(join(gateDir,'ExecutionGate.cs'),cs);copyFileSync(join(source,'build-gate.cmd'),join(gateDir,'build-gate.cmd'));build(gateDir,'build-gate.cmd');
        const dll=join(gateDir,'generated','LedgerExecutionGate.dll');
        for(const attack of ['overwrite','rename-substitute','parent-rename','junction','in-place-junction','delete','hardlink','acl'])await t.test(phase+': held-handle '+attack,async()=>{
            rmSync(marker,{force:true});rmSync(marker+'.continue',{force:true});
            const dir=next(),deployment=copyDeployment(dir,dll,hash(dll)),adapter=await import(pathToFileURL(deployment.module));
            const stage=join(dir,'stage'),ledger=join(dir,'ledger');writeFileSync(stage,'new');writeFileSync(ledger,'old');
            const attacker=spawn(process.execPath,[fileURLToPath(new URL('../test-support/LedgerHelperAttackChild.mjs',import.meta.url)),dir,attack,deployment.helper,counterfeit,deployment.binaryDir,marker],{windowsHide:true,stdio:'ignore'});children.push(attacker);
            let accepted=false;try {accepted=adapter.windowsLedgerDurability.replace(stage,ledger).ok;}catch(e){assert.equal(e.code,failure.code);}
            const result=JSON.parse(readFileSync(join(dir,'attack-result.json'),'utf8'));
            if(result.changed) {assert.equal(accepted,false,'ACL/link uncertainty must suppress acknowledgement');assert.ok(['acl','hardlink'].includes(attack),JSON.stringify(result));}
            else {assert.equal(accepted,true,JSON.stringify(result));assert.ok(result.error);}
            if(attack==='in-place-junction')assert.equal(result.error,'FSCTL_SET_REPARSE_POINT denied: 145');
            // Restore inherited read/delete rights for TEMP cleanup after the deliberate ACL attack.
            if(attack==='acl')spawnSync('C:\\Windows\\System32\\icacls.exe',[deployment.helper,'/inheritance:e'],{windowsHide:true,stdio:'ignore'});
            assert.equal(hash(deployment.helper),helperSha256,'counterfeit never becomes execution identity');
            if(!(attack==='acl'&&phase==='before-launch'))assert.equal(readFileSync(ledger,'utf8'),'new','only the approved native helper performed mutation');
            t.diagnostic(JSON.stringify({phase,...result,accepted}));
        });
    }
    await t.test('missing/corrupt gate bytes fail closed before launch',async()=>{
        for(const state of ['missing','corrupt']) {
            const dir=next(),deployment=copyDeployment(dir),adapter=await import(pathToFileURL(deployment.module));
            if(state==='missing')rmSync(join(deployment.binaryDir,'LedgerExecutionGate.dll'));else writeFileSync(join(deployment.binaryDir,'LedgerExecutionGate.dll'),'bad');
            let launched=false;
            assert.throws(()=>adapter.createWindowsLedgerDurability({run:()=>{launched=true;}}).capability(dir),failure);assert.equal(launched,false);
        }
    });
    assert.equal(hash(helperPath),helperSha256);assert.equal(hash(gatePath),gateSha256);
});
