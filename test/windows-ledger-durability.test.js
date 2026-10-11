import test from 'node:test';
import {registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,chmodSync,symlinkSync,linkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {helperPath,executionHost,createWindowsLedgerDurability,windowsLedgerDurability} from '../server/scheduler/WindowsLedgerDurability.js';
import {directorySync,createLedgerV2Durability} from '../server/scheduler/LedgerV2Durability.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
import {acquireMaintenanceGate} from '../server/autolive/AuthorityMaintenanceGate.js';

const windows={skip:process.platform!=='win32'};
const code={code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'};
function fixture(t) {
    const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'lz-r5-native-'));
    registerNativeTestRoot(dir);
    t.after(()=>{const rel=relative(root,realpathSync(dir));assert.ok(rel.startsWith('lz-r5-native-')&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});});
    return dir;
}
function raw(...args) {
    const result=spawnSync(helperPath,args,{encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:65536});
    assert.ifError(result.error);assert.equal(result.signal,null);return {...result,value:JSON.parse(result.stdout)};
}
test('native capability binds isolated TEMP directories to local NTFS and completes actual directory flush',windows,t=>{
    const dir=fixture(t),nested=join(dir,'capability');mkdirSync(nested);
    const temp=windowsLedgerDurability.capability(dir),child=windowsLedgerDurability.capability(nested);
    for(const result of [temp,child]) {assert.equal(result.filesystem,'NTFS');assert.equal(result.local,true);assert.equal(result.architecture,'x64');assert.equal(result.barrier,'NTFS_DIRECTORY_FLUSH');}
    t.diagnostic(JSON.stringify({temp,child,physicalPowerLossTested:false}));
    assert.equal(directorySync(join(dir,'absent-ledger')),'DIRECTORY_SYNCED');
});
test('native replace, archive and remove acknowledge exact names and bytes; archive never overwrites',windows,t=>{
    const dir=fixture(t),source=join(dir,'sorgente-è-摄像'),dest=join(dir,'ledger'),archive=join(dir,'archive');
    writeFileSync(source,'new');writeFileSync(dest,'old');windowsLedgerDurability.replace(source,dest);
    assert.equal(readFileSync(dest,'utf8'),'new');assert.equal(existsSync(source),false);
    writeFileSync(archive,'prior-evidence');assert.throws(()=>windowsLedgerDurability.archive(dest,archive),code);
    assert.equal(readFileSync(archive,'utf8'),'prior-evidence');assert.equal(readFileSync(dest,'utf8'),'new');
    const other=join(dir,'retained');windowsLedgerDurability.archive(dest,other);assert.equal(existsSync(dest),false);
    assert.equal(readFileSync(other,'utf8'),'new');windowsLedgerDurability.remove(other);assert.equal(existsSync(other),false);
});
for(const kind of ['empty','unknown','missing-target','extra-capability','missing-replace-target','extra-remove'])
test('native malformed arguments remain confined to verified TEMP: '+kind,windows,t=>{
    const dir=fixture(t),other=join(dir,'extra');
    const args={empty:[],unknown:['unknown',dir],'missing-target':['capability'],
        'extra-capability':['capability',dir,other],'missing-replace-target':['durable-replace',dir],
        'extra-remove':['durable-remove',dir,other]}[kind];
    if(args.length<2){assert.throws(()=>raw(...args),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});return;}
    const r=raw(...args);assert.equal(r.status,2);assert.equal(r.value.ok,false);
});
test('native nonexistent, file/directory misuse, UNC, ADS, relative and alias paths fail closed',windows,t=>{
    const dir=fixture(t),file=join(dir,'file');writeFileSync(file,'x');
    for(const p of ['\\\\server\\share\\folder','relative'])assert.throws(()=>raw('sync-directory',p),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});
    for(const p of [join(dir,'absent'),file,file+':stream',join(dir,'x')+'\\..']) {
        const r=raw('sync-directory',p);assert.notEqual(r.status,0);assert.equal(r.value.ok,false);
    }
    assert.throws(()=>windowsLedgerDurability.remove(dir),code);
    const child=join(dir,'child');mkdirSync(child);
    assert.throws(()=>windowsLedgerDurability.replace(file,join(child,'other')),code);assert.equal(readFileSync(file,'utf8'),'x');
});
test('native access denied on read-only file retains evidence',windows,t=>{
    const dir=fixture(t),file=join(dir,'readonly');writeFileSync(file,'evidence');chmodSync(file,0o444);
    try {const r=raw('durable-remove',file);assert.equal(r.status,5);assert.equal(r.value.win32,5);assert.equal(readFileSync(file,'utf8'),'evidence');}
    finally {chmodSync(file,0o666);}
});
test('native rejects reparse ancestors and multiply linked files',windows,t=>{
    const dir=fixture(t),target=join(dir,'target'),junction=join(dir,'junction');mkdirSync(target);symlinkSync(target,junction,'junction');
    assert.throws(()=>windowsLedgerDurability.capability(junction),code);
    const file=join(target,'file');writeFileSync(file,'retained');linkSync(file,join(target,'alias'));
    assert.throws(()=>windowsLedgerDurability.remove(file),code);assert.equal(existsSync(file),true);
});
function success(command,dir) {return {status:0,signal:null,stderr:'',stdout:JSON.stringify({helper:'livezone-windows-ledger-durability',version:'1.0.0',protocol:1,architecture:'x64',command,ok:true,directory:dir,volume:'\\\\?\\Volume{002b730b-7110-a9e1-5934-df0116e65600}\\',volumeSerial:123,filesystem:'NTFS',local:true,barrier:'NTFS_DIRECTORY_FLUSH'})+'\n'};}
for(const bad of ['nonzero','signal','timeout','missing','malformed','extra-output','stderr','protocol','architecture','helper','version','filesystem','local','directory','volume','barrier','extra-field','partial'])
test('adapter rejects '+bad+' without weak fallback',windows,t=>{
    const dir=fixture(t);
    const run=(path,args,options)=>{
        assert.equal(path,executionHost);assert.equal(options.shell,false);assert.equal(options.timeout,10000);
        const command=Buffer.from(options.input.split('\n')[3],'base64').toString('utf8');
        const r=success(command,dir),value=JSON.parse(r.stdout);
        if(bad==='nonzero')r.status=5;else if(bad==='signal')r.signal='SIGTERM';else if(bad==='timeout')r.error={code:'ETIMEDOUT'};
        else if(bad==='missing')throw Error('ENOENT');else if(bad==='malformed')r.stdout='garbage\n';
        else if(bad==='extra-output')r.stdout+=r.stdout;else if(bad==='stderr')r.stderr='warning';else if(bad==='partial')r.stdout=r.stdout.trim();
        else {value[bad]=bad==='local'?false:bad==='protocol'?2:bad==='directory'?join(dir,'other'):'invalid';r.stdout=JSON.stringify(value)+'\n';}
        return r;
    };
    assert.throws(()=>createWindowsLedgerDurability({run}).capability(dir),code);
});
test('adapter treats helper identity/missing-file verification failure as unproven',windows,t=>{
    const dir=fixture(t);let called=false;
    const adapter=createWindowsLedgerDurability({verify:()=>{throw Error('identity-unavailable');},run:()=>{called=true;}});
    assert.throws(()=>adapter.capability(dir),code);assert.equal(called,false);
});
for(const state of ['missing','malformed-PE','wrong-hash'])test('actual deployment binary '+state+' is rejected before execution',windows,async t=>{
    const dir=fixture(t),moduleDir=join(dir,'server','scheduler'),binaryDir=join(dir,'tools','native','windows-ledger-durability','generated');
    mkdirSync(moduleDir,{recursive:true});mkdirSync(binaryDir,{recursive:true});
    const modulePath=join(moduleDir,'WindowsLedgerDurability.mjs');
    writeFileSync(modulePath,readFileSync(new URL('../server/scheduler/WindowsLedgerDurability.js',import.meta.url)));
    if(state!=='missing') {
        const bytes=state==='malformed-PE'?Buffer.from('not an executable'):readFileSync(helperPath);
        if(state==='wrong-hash')bytes[bytes.length-1]^=1;
        writeFileSync(join(binaryDir,'windows-ledger-durability.exe'),bytes);
    }
    const isolated=await import(pathToFileURL(modulePath).href);
    assert.throws(()=>isolated.windowsLedgerDurability.capability(dir),code);
});
test('adapter rejects malformed output from an actual child process',windows,t=>{
    const dir=fixture(t);
    const adapter=createWindowsLedgerDurability({run:(_exe,_args,options)=>spawnSync(process.execPath,['-e','console.log("malformed")'],options)});
    assert.throws(()=>adapter.capability(dir),code);
});
test('adapter bounds a real unresponsive subprocess and reports no success',windows,t=>{
    const dir=fixture(t),start=Date.now();
    const adapter=createWindowsLedgerDurability({run:(_exe,_args,options)=>spawnSync(process.execPath,['-e','setInterval(()=>{},1000)'],options)});
    assert.throws(()=>adapter.capability(dir),code);assert.ok(Date.now()-start<15000);
});
test('native creates each missing ancestor with barriers and supports clean ledger readiness',windows,async t=>{
    const dir=fixture(t),path=join(dir,'a','b','ledger');
    const repo=new Repository({path,create:true,authority:{authorityEpoch:1,authorityProcessSession:'native-test'}});
    await repo.initialize();assert.equal(repo.status,'READY',repo.error);await repo.close();assert.equal(repo.status,'CLOSED');assert.equal(existsSync(path+'.lock'),false);
});
test('writer lock barrier failure is sticky and retained before READY',async t=>{
    const dir=fixture(t),path=join(dir,'ledger');let calls=0;
    const repo=new Repository({path,create:true,authority:{authorityEpoch:1,authorityProcessSession:'lock-test'},syncDirectory:()=>++calls===3?'FILE_SYNC_ONLY':'DIRECTORY_SYNCED'});
    await repo.initialize();assert.equal(repo.status,'DURABILITY_UNCERTAIN');assert.equal(repo.error,code.code);await repo.close();assert.equal(existsSync(path+'.lock'),true);
});
test('clean removal barrier failure cannot report CLOSED',async t=>{
    const dir=fixture(t),path=join(dir,'ledger');let fail=false;
    const repo=new Repository({path,create:true,authority:{authorityEpoch:1,authorityProcessSession:'close-test'},syncDirectory:()=>fail?'FILE_SYNC_ONLY':'DIRECTORY_SYNCED',hook:p=>{if(p==='shutdown-durable')fail=true;}});
    await repo.initialize();assert.equal(repo.status,'READY');await assert.rejects(repo.close(),code);assert.equal(repo.status,'DURABILITY_UNCERTAIN');
});
test('v2 bootstrap marker barrier failure suppresses initialization',async t=>{
    const dir=fixture(t),path=join(dir,'ledger');let calls=0;
    const repo=await initializeEntryLedger({path,ownership:{available:true,authorityEpoch:1,authorityProcessSession:'marker-test'},startupSchedule:{events:[]},executionRepository:{status:'READY'},options:{protocolVersion:2,syncDirectory:()=>++calls===2?'FILE_SYNC_ONLY':'DIRECTORY_SYNCED'}});
    assert.notEqual(repo.status,'READY');assert.equal(repo.error,code.code);assert.equal(existsSync(path+'.bootstrap'),true);assert.equal(existsSync(path),false);await repo.close();
});
test('maintenance gate creation failure retains uncertainty; native release proves absence',windows,async t=>{
    const dir=fixture(t),path=join(dir,'authority');
    await assert.rejects(acquireMaintenanceGate(path,{durability:{sync:()=>{throw Object.assign(Error(code.code),code);}}}),code);
    assert.equal(existsSync(path+'.maintenance'),true);
    const other=join(dir,'second');const release=await acquireMaintenanceGate(other,{durability:createLedgerV2Durability()});await release();assert.equal(existsSync(other+'.maintenance'),false);
});
