import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

// Each case replaces built-in bindings in its own process. No real CIM, registry,
// native helper, proof generation, or runtime writes occur in these fixtures.
async function fixture(input) {
    const assert=(await import('node:assert/strict')).default;
    const fs=(await import('node:fs')).default;
    const cp=(await import('node:child_process')).default;
    const {syncBuiltinESMExports}=await import('node:module');
    const {resolve,join,parse}=await import('node:path');
    const {createHash}=await import('node:crypto');
    const sha=b=>createHash('sha256').update(b).digest('hex');
    const guid='11111111-2222-3333-4444-555555555555';
    const machine={source:'HKLM/SOFTWARE/Microsoft/Cryptography/MachineGuid:64',value:sha(Buffer.from(guid))};
    const good={volume:'\\\\?\\Volume{002b730b-7110-a9e1-5934-df0116e65600}\\',volumeSerial:2849514048,filesystem:'NTFS',local:true};
    const calls=[];
    const observed={...good,...input.patch};
    for(const name of input.remove??[])delete observed[name];
    cp.spawnSync=(exe,args,options)=>{
        calls.push({exe,args,options});
        if(exe.endsWith('reg.exe'))return input.machineResult??{status:0,signal:null,stdout:`MachineGuid    REG_SZ    ${guid}\r\n`,stderr:''};
        return input.result??{status:0,signal:null,stdout:JSON.stringify(observed),stderr:input.stderr??''};
    };
    syncBuiltinESMExports();
    const contract=await import('./server/recovery/PermanentCapabilityContract.js');
    const storage=await import('./server/recovery/VerifiedCapabilityStorage.js');
    const pins=await import('./server/scheduler/WindowsLedgerDurability.js');
    const rejects=(action,code,reason)=>assert.throws(action,e=>{
        assert.equal(e.code,code);assert.equal(e.message,code);assert.equal(e.reason,reason);
        if(code==='PERMANENT_PROOF_VOLUME_UNAVAILABLE'){
            assert.equal(e.timeoutMs,45000);assert.equal(e.status,Number.isInteger(input.result?.status)?input.result.status:input.result?null:0);
            assert.equal(e.childErrorCode,input.result?.error?.code??null);assert.equal(e.signal,input.result?.signal??null);
            assert.equal('stdout' in e,false);assert.equal('stderr' in e,false);
        }
        return true;
    });
    if(input.kind==='machine'){
        if(input.fail)rejects(()=>contract.readMachineIdentity(),'PERMANENT_PROOF_MACHINE_UNAVAILABLE',undefined);
        else assert.deepEqual(contract.readMachineIdentity(),machine);
        assert.equal(calls.length,1);assert.deepEqual(calls[0],{exe:'C:\\Windows\\System32\\reg.exe',args:['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid','/reg:64'],options:{encoding:'utf8',windowsHide:true,timeout:10000}});
        return;
    }
    if(input.kind==='observer'){
        if(input.reason)rejects(()=>contract.currentCompatibility('C:\\'),'PERMANENT_PROOF_VOLUME_UNAVAILABLE',input.reason);
        else assert.deepEqual(contract.currentCompatibility('C:\\'),{machine,volume:{...good,...input.patch}});
        assert.equal(calls.length,input.reason?1:2);
        const first=calls[0];assert.equal(first.exe,pins.executionHost);
        const script=`$ErrorActionPreference='Stop';$v=@(Get-CimInstance Win32_Volume -Filter "DriveLetter='C:'");if($v.Count -ne 1){throw 'VOLUME_REQUIRED'};[ordered]@{volume=$v[0].DeviceID;volumeSerial=[uint32]$v[0].SerialNumber;filesystem=$v[0].FileSystem;local=($v[0].DriveType -eq 3)}|ConvertTo-Json -Compress`;
        assert.deepEqual(first.args,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
        assert.deepEqual(first.options,{encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
        if(!input.reason){assert.equal(calls[1].options.timeout,10000);}
        // The fixture represents child completion at this virtual duration;
        // invocation assertions, not a real sleep, establish the timeout policy.
        if(input.elapsedMs){assert.ok(input.elapsedMs>10000&&input.elapsedMs<first.options.timeout);}
        return;
    }
    // Fully synthetic, memory-only bundle. Never read or reseal ERA20 evidence.
    const root=resolve('C:/synthetic-volume-observer-bundle'),work=join(root,'work');
    const probeId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',createdAt='2026-10-13T00:00:00.000Z';
    const pid=123,account='NT AUTHORITY\\SYSTEM',sid='S-1-5-18';
    const result={status:'PASS',root,identity:{pid,sid},helper:{sha256:pins.helperSha256,architecture:'x64'},gate:{sha256:pins.gateSha256,architecture:'x64'},capabilities:Object.fromEntries(contract.operations.map(key=>[key,{ok:true,protocol:1,version:'1.0.0',architecture:'x64',helper:'livezone-windows-ledger-durability',filesystem:'NTFS',local:true,barrier:'NTFS_DIRECTORY_FLUSH',volume:good.volume,volumeSerial:good.volumeSerial,directory:work}])),nativeCalls:['capability','sync-directory','durable-replace','durable-archive','durable-remove','sync-directory'].map(command=>({command}))};
    const artifacts=new Map();const put=(name,value)=>artifacts.set(name,Buffer.from(typeof value==='string'?value:JSON.stringify(value)));
    put('result-success.json',result);put('identity-success.json',{pid,sid});put('success.exe','synthetic executable bytes, never executed');put('success.cs','synthetic source');
    put('host-identity-success.txt',account+'\r\n'+sid);put('host-child-success.txt',String(pid));put('host-result-success.txt','EXIT=0');put('host-stop-success.txt','STOPPED_JOB_CLOSED');put('sc-transcript.txt','synthetic transcript');
    put('service-outcomes.json',[{mode:'success',removed:true,failure:null,binarySha256:sha(artifacts.get('success.exe'))}]);
    put('receipt.json',{schema:contract.schema,probeId,createdAt,machine,sid,pid,resultHash:sha(artifacts.get('result-success.json')),identityHash:sha(artifacts.get('identity-success.json')),inputs:contract.producerInputs.map(name=>({name,sha256:sha(fs.readFileSync(name))}))});
    const manifest={schema:contract.schema,probeVersion:1,probeId,createdAt,machine,result:'PASS',sid,account,helper:pins.helperSha256,gate:pins.gateSha256,protocol:1,version:'1.0.0',architecture:'x64',filesystem:'NTFS',local:true,volume:good.volume,volumeSerial:good.volumeSerial,operations:contract.operations,artifacts:[...artifacts].map(([name,b])=>({name,sha256:sha(b)}))};
    put('manifest.json',manifest);const proofHash=sha(artifacts.get('manifest.json'));
    const real={readFileSync:fs.readFileSync,lstatSync:fs.lstatSync,realpathSync:fs.realpathSync,readdirSync:fs.readdirSync};
    const virtual=p=>{const r=resolve(p);return r===root||r.startsWith(root+'\\');};
    fs.readFileSync=(p,...rest)=>virtual(p)?artifacts.get(resolve(p).slice(root.length+1)):real.readFileSync(p,...rest);
    fs.lstatSync=p=>virtual(p)?{isFile:()=>resolve(p)!==root,isDirectory:()=>resolve(p)===root,isSymbolicLink:()=>false,nlink:1,size:1}:real.lstatSync(p);
    fs.realpathSync=p=>virtual(p)?resolve(p):real.realpathSync(p);
    fs.readdirSync=(p,...rest)=>resolve(p)===root?[...artifacts.keys()]:real.readdirSync(p,...rest);
    syncBuiltinESMExports();
    const volume={...good,...input.patch},current={machine:input.foreignMachine?{...machine,value:'0'.repeat(64)}:machine,volume};
    if(input.kind==='proof'){
        const options={serviceIdentity:'LocalSystem',approvalHash:proofHash,compatibility:current,...(input.runtimeVolume?{volume:input.runtimeVolume}:{})};
        if(input.fail)rejects(()=>contract.verifyPermanentCapability(root,options),'PERMANENT_PROOF_FOREIGN_MACHINE_VOLUME',input.foreignMachine?undefined:'VOLUME_MISMATCH');
        else assert.equal(contract.verifyPermanentCapability(root,options).proofHash,proofHash);
        assert.equal(calls.length,0);
    }else{
        const proof={status:'PERMANENT DEPLOYABLE PROOF VALID',identity:sid,proofHash,volume:good.volume,helperSha256:pins.helperSha256,gateSha256:pins.gateSha256};
        if(input.foreignMachine)input.machineResult={status:0,stdout:'MachineGuid REG_SZ 99999999-2222-3333-4444-555555555555'};
        if(input.fail)rejects(()=>storage.verifiedCapabilityStorage(parse(root).root,proof,root),'NEW_ERA_VERIFIED_STORAGE_REQUIRED',input.foreignMachine?undefined:'VOLUME_MISMATCH');
        else assert.equal(storage.verifiedCapabilityStorage(parse(root).root,proof,root).volume,good.volume);
    }
}

function isolated(input){
    input.remove=Object.entries(input.patch??{}).filter(([,value])=>value===undefined).map(([name])=>name);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await (${fixture.toString()})(${JSON.stringify(input)});`],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr||result.stdout);
}

test('canonical invocation accepts virtual 32804 ms completion with 45000 ms deadline',()=>isolated({kind:'observer',elapsedMs:32804}));
test('progress-only stderr does not invalidate successful output',()=>isolated({kind:'observer',stderr:'#< CLIXML\r\n<Objs><Obj S="progress" /></Objs>'}));
for(const [name,result,reason] of [
    ['timeout',{status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'},stdout:''},'VOLUME_QUERY_TIMEOUT'],
    ['timeout with partial stdout',{status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'},stdout:'{"volume":'},'VOLUME_QUERY_TIMEOUT'],
    ['launch failure',{status:null,signal:null,error:{code:'ENOENT'},stdout:''},'VOLUME_QUERY_FAILED'],
    ['nonzero exit',{status:1,signal:null,stdout:'',stderr:'query failed'},'VOLUME_QUERY_FAILED'],
    ['unexpected signal',{status:null,signal:'SIGTERM',stdout:''},'VOLUME_QUERY_FAILED'],
    ['null status without timeout',{status:null,signal:null,stdout:''},'VOLUME_QUERY_FAILED'],
    ...['','{','null','[]','1','"text"','{}'].map(stdout=>['invalid output '+JSON.stringify(stdout),{status:0,signal:null,stdout},'VOLUME_OUTPUT_INVALID']),
])test(name,()=>isolated({kind:'observer',result,reason}));
for(const [name,patch] of [
    ['missing GUID',{volume:undefined}],['wrong GUID type',{volume:1}],['invalid GUID',{volume:'C:\\'}],['GUID missing trailing slash',{volume:'\\\\?\\Volume{002b730b-7110-a9e1-5934-df0116e65600}'}],
    ['missing serial',{volumeSerial:undefined}],['negative serial',{volumeSerial:-1}],['serial overflow',{volumeSerial:4294967296}],['fractional serial',{volumeSerial:1.5}],['string serial',{volumeSerial:'2849514048'}],
    ['missing filesystem',{filesystem:undefined}],['wrong filesystem type',{filesystem:1}],['empty filesystem',{filesystem:''}],['blank filesystem',{filesystem:' '}],['missing local',{local:undefined}],['non-Boolean local',{local:'true'}],
])test(name,()=>isolated({kind:'observer',patch,reason:'VOLUME_OUTPUT_INVALID'}));
for(const volumeSerial of [0,4294967295])test('uint32 boundary accepted '+volumeSerial,()=>isolated({kind:'observer',patch:{volumeSerial}}));
for(const kind of ['proof','storage']){
    test(kind+' comparison accepts matching identity',()=>isolated({kind}));
    for(const [name,patch] of [['foreign GUID',{volume:'\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\'}],['wrong serial',{volumeSerial:1}],['non-NTFS',{filesystem:'ReFS'}],['non-local',{local:false}]])
        test(kind+' rejects '+name+' with stable code and VOLUME_MISMATCH',()=>isolated({kind,patch,fail:true}));
    test(kind+' machine mismatch has no VOLUME_MISMATCH reason',()=>isolated({kind,foreignMachine:true,fail:true}));
}
test('caller runtime volume mismatch retains proof public code',()=>isolated({kind:'proof',runtimeVolume:'foreign',fail:true}));
test('MachineGuid success keeps registry invocation, 10000 ms and hash',()=>isolated({kind:'machine'}));
for(const [name,machineResult] of [['nonzero',{status:1,stdout:''}],['timeout',{status:null,error:{code:'ETIMEDOUT'},stdout:''}],['malformed',{status:0,stdout:'MachineGuid REG_SZ invalid'}],['missing',{status:0,stdout:''}]])
    test('MachineGuid unchanged failure '+name,()=>isolated({kind:'machine',machineResult,fail:true}));
test('real idle child is terminated at a short finite deadline',()=>{
    const start=performance.now();
    const result=spawnSync(process.execPath,['-e','setInterval(()=>{},1000)'],{encoding:'utf8',windowsHide:true,timeout:250});
    assert.equal(result.error?.code,'ETIMEDOUT');assert.equal(result.status,null);assert.ok(result.signal);assert.ok(performance.now()-start<10000);
});
