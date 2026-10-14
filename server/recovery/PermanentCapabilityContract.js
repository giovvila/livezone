import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,join,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {helperPath,gatePath,helperSha256,gateSha256,executionHost} from '../scheduler/WindowsLedgerDurability.js';
export const schema='livezone-permanent-capability/1';
export const operations=['storage','namespace','replace','archive','remove','finalNamespace'];
export const producerInputs=['server/scheduler/WindowsLedgerDurability.js','tools/native/windows-ledger-durability/main.cpp','tools/native/windows-ledger-durability/ExecutionGate.cs','tools/native/windows-ledger-durability/build-x64.cmd','tools/native/windows-ledger-durability/build-gate.cmd','tools/localsystem-durability-probe.mjs','tools/invoke-localsystem-durability-probe.ps1','tools/native/localsystem-probe/ProbeService.cs','tools/permanent-localsystem-probe.mjs','tools/invoke-permanent-localsystem-probe.ps1','tools/package-permanent-capability.mjs','server/recovery/PermanentCapabilityContract.js'];
export const artifactNames=['receipt.json','result-success.json','identity-success.json','host-identity-success.txt','host-child-success.txt','host-result-success.txt','host-stop-success.txt','service-outcomes.json','sc-transcript.txt','success.cs','success.exe'];
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
export function ordinary(path){
    const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16*1024*1024||fs.realpathSync(path).toLowerCase()!==resolve(path).toLowerCase())fail('PERMANENT_PROOF_FILE');
    return fs.readFileSync(path);
}
export function readMachineIdentity(){
    const r=spawnSync('C:\\Windows\\System32\\reg.exe',['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid','/reg:64'],{encoding:'utf8',windowsHide:true,timeout:10000});
    const guid=r.stdout?.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i)?.[1]?.toLowerCase();
    if(r.status!==0||!guid||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(guid))fail('PERMANENT_PROOF_MACHINE_UNAVAILABLE');
    return {source:'HKLM/SOFTWARE/Microsoft/Cryptography/MachineGuid:64',value:sha(Buffer.from(guid,'utf8'))};
}
export function currentCompatibility(volumeDirectory){
    const drive=parse(resolve(volumeDirectory)).root.slice(0,2);
    if(!/^[a-z]:$/i.test(drive))fail('PERMANENT_PROOF_LOCAL_DRIVE_REQUIRED');
    // Read-only OS metadata; never flush or mutate real runtime directories.
    const script=`$ErrorActionPreference='Stop';$v=@(Get-CimInstance Win32_Volume -Filter "DriveLetter='${drive}'");if($v.Count -ne 1){throw 'VOLUME_REQUIRED'};[ordered]@{volume=$v[0].DeviceID;volumeSerial=[uint32]$v[0].SerialNumber;filesystem=$v[0].FileSystem;local=($v[0].DriveType -eq 3)}|ConvertTo-Json -Compress`;
    const r=spawnSync(executionHost,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
    const diagnostic={childErrorCode:typeof r.error?.code==='string'?r.error.code.slice(0,64):null,status:Number.isInteger(r.status)?r.status:null,signal:typeof r.signal==='string'?r.signal.slice(0,32):null,timeoutMs:45000};
    const reject=reason=>{throw Object.assign(Error('PERMANENT_PROOF_VOLUME_UNAVAILABLE'),{code:'PERMANENT_PROOF_VOLUME_UNAVAILABLE',reason,...diagnostic});};
    if(r.error?.code==='ETIMEDOUT')reject('VOLUME_QUERY_TIMEOUT');
    if(r.error||r.status!==0||r.signal)reject('VOLUME_QUERY_FAILED');
    let volume;try{volume=JSON.parse(r.stdout.trim());}catch{reject('VOLUME_OUTPUT_INVALID');}
    if(!volume||typeof volume!=='object'||Array.isArray(volume)||
        typeof volume.volume!=='string'||!/^\\\\\?\\Volume\{[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\}\\$/i.test(volume.volume)||
        !Number.isSafeInteger(volume.volumeSerial)||volume.volumeSerial<0||volume.volumeSerial>0xffffffff||
        typeof volume.filesystem!=='string'||!volume.filesystem.trim()||typeof volume.local!=='boolean')reject('VOLUME_OUTPUT_INVALID');
    return {machine:readMachineIdentity(),volume};
}
export function verifyPermanentCapability(directory,{serviceIdentity,volume,approvalHash,compatibility}={}){
    if(!directory)fail('LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED');
    directory=resolve(directory);
    if(fs.realpathSync(directory).toLowerCase()!==directory.toLowerCase()||fs.lstatSync(directory).isSymbolicLink())fail('PERMANENT_PROOF_ROOT');
    const bytes=ordinary(join(directory,'manifest.json'));
    if(!/^[a-f0-9]{64}$/.test(approvalHash||'')||sha(bytes)!==approvalHash)fail('PERMANENT_PROOF_APPROVAL');
    const m=JSON.parse(bytes);
    if(m.schema!==schema||m.probeVersion!==1||!/^[-a-f0-9]{36}$/.test(m.probeId)||!Number.isFinite(Date.parse(m.createdAt))||m.result!=='PASS'||m.sid!=='S-1-5-18'||m.account!=='NT AUTHORITY\\SYSTEM'||serviceIdentity!=='LocalSystem'||m.helper!==helperSha256||m.gate!==gateSha256||m.protocol!==1||m.version!=='1.0.0'||m.architecture!=='x64'||m.filesystem!=='NTFS'||m.local!==true)fail('PERMANENT_PROOF_CONTRACT');
    if(JSON.stringify(m.operations)!==JSON.stringify(operations)||!Array.isArray(m.artifacts)||m.artifacts.length!==artifactNames.length)fail('PERMANENT_PROOF_INVENTORY');
    const names=m.artifacts.map(a=>a.name);
    if(new Set(names.map(x=>typeof x==='string'?x.toLowerCase():x)).size!==names.length||!artifactNames.every(x=>names.includes(x))||names.some(x=>typeof x!=='string'||!/^[a-z0-9.-]+$/.test(x)))fail('PERMANENT_PROOF_PATH');
    const actual=fs.readdirSync(directory).sort();
    if(JSON.stringify(actual)!==JSON.stringify(['manifest.json',...artifactNames].sort()))fail('PERMANENT_PROOF_INVENTORY');
    const artifacts={};for(const a of m.artifacts){const b=ordinary(join(directory,a.name));if(sha(b)!==a.sha256)fail('PERMANENT_PROOF_ARTIFACT_CHANGED');artifacts[a.name]=b;}
    const receipt=JSON.parse(artifacts['receipt.json']),result=JSON.parse(artifacts['result-success.json']),identity=JSON.parse(artifacts['identity-success.json']),outcomes=JSON.parse(artifacts['service-outcomes.json']);
    if(receipt.schema!==schema||receipt.probeId!==m.probeId||receipt.createdAt!==m.createdAt||JSON.stringify(receipt.machine)!==JSON.stringify(m.machine)||receipt.sid!==m.sid||receipt.resultHash!==sha(artifacts['result-success.json'])||receipt.identityHash!==sha(artifacts['identity-success.json'])||result.status!=='PASS'||identity.sid!==m.sid||identity.pid!==receipt.pid||result.identity.pid!==receipt.pid||result.identity.sid!==m.sid)fail('PERMANENT_PROOF_PROVENANCE');
    const host=artifacts['host-identity-success.txt'].toString().trim().split(/\r?\n/);
    if(host[0].toUpperCase()!==m.account||host[1]!==m.sid||Number(artifacts['host-child-success.txt'].toString())!==receipt.pid||artifacts['host-result-success.txt'].toString().trim()!=='EXIT=0'||artifacts['host-stop-success.txt'].toString().trim()!=='STOPPED_JOB_CLOSED'||outcomes.length!==1||outcomes[0].mode!=='success'||!outcomes[0].removed||outcomes[0].failure||outcomes[0].binarySha256.toLowerCase()!==sha(artifacts['success.exe']))fail('PERMANENT_PROOF_HOST');
    if(result.helper.sha256!==m.helper||result.gate.sha256!==m.gate||result.helper.architecture!=='x64'||result.gate.architecture!=='x64')fail('PERMANENT_PROOF_NATIVE');
    for(const key of operations){const c=result.capabilities[key];if(!c?.ok||c.protocol!==m.protocol||c.version!==m.version||c.architecture!==m.architecture||c.helper!=='livezone-windows-ledger-durability'||c.filesystem!==m.filesystem||c.local!==true||c.barrier!=='NTFS_DIRECTORY_FLUSH'||c.volume!==m.volume||c.volumeSerial!==m.volumeSerial||resolve(c.directory)!==join(resolve(result.root),'work'))fail('PERMANENT_PROOF_CAPABILITY');}
    if(result.nativeCalls?.length!==6||JSON.stringify(result.nativeCalls.map(c=>c.command))!==JSON.stringify(['capability','sync-directory','durable-replace','durable-archive','durable-remove','sync-directory']))fail('PERMANENT_PROOF_CAPABILITY');
    const repository=fileURLToPath(new URL('../../',import.meta.url));
    if(!Array.isArray(receipt.inputs)||receipt.inputs.length!==producerInputs.length)fail('PERMANENT_PROOF_INPUTS');
    for(const name of producerInputs){const item=receipt.inputs.find(i=>i.name===name);if(!item||item.sha256!==sha(ordinary(join(repository,name))))fail('PERMANENT_PROOF_STALE');}
    for(const [path,pin] of [[helperPath,helperSha256],[gatePath,gateSha256]])if(sha(ordinary(path))!==pin)fail('PERMANENT_PROOF_STALE');
    const current=compatibility||currentCompatibility(parse(repository).root);
    if(process.platform!=='win32'||process.arch!=='x64')fail('PERMANENT_PROOF_PLATFORM');
    if(JSON.stringify(current.machine)!==JSON.stringify(m.machine))fail('PERMANENT_PROOF_FOREIGN_MACHINE_VOLUME');
    if(current.volume.volume!==m.volume||current.volume.volumeSerial!==m.volumeSerial||current.volume.filesystem!=='NTFS'||current.volume.local!==true||(volume&&volume!==m.volume)){throw Object.assign(Error('PERMANENT_PROOF_FOREIGN_MACHINE_VOLUME'),{code:'PERMANENT_PROOF_FOREIGN_MACHINE_VOLUME',reason:'VOLUME_MISMATCH'});}
    return Object.freeze({status:'PERMANENT DEPLOYABLE PROOF VALID',capability:'CAPABILITY TEST PASSED',identity:m.sid,proofHash:sha(bytes),probeId:m.probeId,volume:m.volume,helperSha256,gateSha256});
}
