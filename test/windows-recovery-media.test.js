import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverMediaMtx,literalArguments} from '../server/recovery/MediaMtxIdentity.js';
import {assertHost} from '../server/recovery/WindowsRecoveryHost.js';
import {BRANCH} from '../server/recovery/RecoveryContract.js';
import {evaluateWindowsAuthorityCensus} from '../server/autolive/WindowsAuthorityProcessProof.js';
const root='C:\\Projects\\livezone-broadcast-engine-x';
const wrapper=root+'\\var\\runtime\\winsw\\services\\LivezoneMediaMtx\\LivezoneMediaMtx.exe';
const exe=root+'\\var\\runtime\\mediamtx\\mediamtx.exe',config=root+'\\var\\runtime\\mediamtx\\mediamtx.yml';
const shell='C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const quote=s=>'"'+s+'"';
export function topology(){return {services:[{Name:'LivezoneMediaMtx',State:'Running',ProcessId:100,PathName:quote(wrapper)}],processes:[
    {Name:'LivezoneMediaMtx.exe',ProcessId:100,ExecutablePath:wrapper,CommandLine:quote(wrapper),CreationDate:'2026-09-30T06:34:58Z'},
    {Name:'pwsh.exe',ProcessId:200,ParentProcessId:100,ExecutablePath:shell,CreationDate:'2026-09-30T06:34:59Z',
        CommandLine:quote(shell)+' -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+quote(root+'\\tools\\start-mediamtx.ps1')+
        ' -BinaryPath '+quote(exe)+' -TemplatePath '+quote(root+'\\ops\\mediamtx\\mediamtx.example.yml')+' -RuntimeConfigPath '+quote(config)+' -EnvironmentPath '+quote(root+'\\.env')},
    {Name:'mediamtx.exe',ProcessId:300,ParentProcessId:200,ExecutablePath:exe,CommandLine:quote(exe)+' '+config,CreationDate:'2026-09-30T06:35:01Z'}]};}
test('real WinSW -> PowerShell -> MediaMTX topology verifies without fixed PIDs',()=>{
    const t=topology();assert.equal(discoverMediaMtx(root,t).status,'VERIFIED');
    for(const p of t.processes){p.ProcessId+=1000;if(p.ParentProcessId)p.ParentProcessId+=1000;}t.services[0].ProcessId+=1000;
    assert.equal(discoverMediaMtx(root,t).status,'VERIFIED');
});
const failures={
    missing:t=>t.services=[],stopped:t=>t.services[0].State='Stopped',
    duplicateService:t=>t.services.push({...t.services[0]}),
    missingProcess:t=>t.processes.pop(),
    wrongService:t=>t.services[0].PathName='C:\\elsewhere\\LivezoneMediaMtx.exe',
    wrongExecutable:t=>t.processes[2].ExecutablePath='C:\\elsewhere\\mediamtx.exe',
    wrongConfig:t=>t.processes[2].CommandLine=quote(exe)+' C:\\elsewhere\\mediamtx.yml',
    duplicate:t=>t.processes.push({...t.processes[2],ProcessId:400}),
    malformed:t=>t.processes[2].CommandLine='"unclosed',unreadable:t=>t.processes[2].CommandLine=null,
    wrongParent:t=>t.processes[1].ParentProcessId=999,
    wrongWrapper:t=>t.processes[0].ExecutablePath='C:\\elsewhere\\LivezoneMediaMtx.exe',
    wrongLauncherConfig:t=>t.processes[1].CommandLine=t.processes[1].CommandLine.replace(config,'C:\\elsewhere\\mediamtx.yml'),
    reusedPid:t=>t.processes[0].CreationDate='2026-10-01T00:00:00Z',
    wrongLauncher:t=>t.processes[1].CommandLine+=' -ValidateOnly',
    incomplete:t=>delete t.processes,
};
for(const [name,change] of Object.entries(failures))test('fail closed: '+name,()=>{const t=topology();change(t);assert.equal(discoverMediaMtx(root,t).status,'UNVERIFIED');});
test('strict literal tokenization and path normalization',()=>{
    assert.equal(literalArguments('"abc"tail'),null);
    const t=topology();t.processes[2].ExecutablePath=exe.toUpperCase().replaceAll('\\','/');
    assert.equal(discoverMediaMtx(root,t).status,'VERIFIED');
});
test('Adobe node stays unrelated and media listeners do not bypass 8080 or census',()=>{
    const proof=evaluateWindowsAuthorityCensus({services:[{State:'Stopped',StartMode:'Disabled'}],nodes:[{
        ProcessId:987,Name:'node.exe',ExecutablePath:'C:/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe',
        CommandLine:'"C:/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" "C:/Program Files/Adobe/Adobe Creative Cloud Experience/js/main.js"'}]});
    assert.equal(proof.absent,true);
    // assertRepository uses native absolute paths; use the actual fixture cwd here.
    const h={root:process.cwd(),branch:BRANCH,head:'a'.repeat(40),administrator:true,service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled'},
        media:discoverMediaMtx(root,topology()),proof,ports:[],mediaPorts:[1935,8888,9997].map(LocalPort=>({LocalPort,OwningProcess:300}))};
    const check=()=>assertHost(h,process.cwd(),{expected:{branch:BRANCH,head:h.head}});
    assert.doesNotThrow(check);h.ports=[{LocalPort:8080,OwningProcess:300}];assert.throws(check,/CANONICAL_OFFLINE/);
    h.ports=[];h.proof={absent:false};assert.throws(check,/CANONICAL_OFFLINE/);
});
