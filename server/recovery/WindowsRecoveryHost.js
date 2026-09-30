import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {proveWindowsOffline} from '../autolive/ReconcileAuthorityLock.js';
import {evaluateWindowsAuthorityCensus} from '../autolive/WindowsAuthorityProcessProof.js';
import {assertRepository,fail} from './RecoveryContract.js';
import {discoverMediaMtx} from './MediaMtxIdentity.js';
const execute=promisify(execFile);
async function ps(script){
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:4*1024*1024});
    return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
export async function reserve8080(){
    const sockets=[];
    // This is an exclusivity gate, not an application server. A probe must not
    // retain an accepted connection and make close() wait indefinitely.
    try{for(const host of ['0.0.0.0','::']){const socket=createServer(peer=>peer.destroy());sockets.push(socket);
        await new Promise((ok,no)=>{socket.once('error',no);socket.listen({host,port:8080,exclusive:true,ipv6Only:host==='::'},ok);});}
    }catch(error){for(const s of sockets)if(s.listening)s.close();throw error;}
    return async()=>{for(const s of sockets)await new Promise(ok=>s.close(ok));};
}
export class WindowsRecoveryHost {
    constructor(root){this.root=root;}
    proveOffline=proveWindowsOffline;
    reserve=reserve8080;
    async inspect(){
        if(process.platform!=='win32')fail('WINDOWS_REQUIRED');
        const script=`$ErrorActionPreference='Stop'
function ServiceState($name) {
 $s=Get-CimInstance Win32_Service -Filter "Name='$name'"
 if (!$s) { return $null }
 $key=Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'+$name)
 $d=$key.PSObject.Properties['DelayedAutoStart']
 [pscustomobject]@{Name=$s.Name;State=$s.State;StartMode=$s.StartMode;PathName=$s.PathName;StartName=$s.StartName;DelayedPresent=($null -ne $d);DelayedValue=$(if($d){[int]$d.Value}else{0})}
}
$s=ServiceState 'LivezoneNode'; $m=@(Get-CimInstance Win32_Service -Filter "Name='LivezoneMediaMtx'" | Select-Object Name,State,StartMode,PathName,ProcessId)
$mediaProcesses=@(Get-CimInstance Win32_Process -Filter "Name='mediamtx.exe' OR Name='LivezoneMediaMtx.exe' OR Name='pwsh.exe' OR Name='powershell.exe'" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}})
$nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='LivezoneNode.exe'" | Select-Object ProcessId,Name,ExecutablePath,CommandLine)
$ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -in 8080,1935,8888,9997 | Select-Object LocalAddress,LocalPort,OwningProcess)
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$globalBootstrap=([bool][Environment]::GetEnvironmentVariable('LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP','Machine') -or [bool][Environment]::GetEnvironmentVariable('LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP','User'))
[pscustomobject]@{service=$s;mediaServices=$m;mediaProcesses=$mediaProcesses;nodes=$nodes;ports=$ports;administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);globalBootstrap=$globalBootstrap} | ConvertTo-Json -Depth 7 -Compress`;
        const [os,branch,head,root]=await Promise.all([ps(script),...['branch --show-current','rev-parse HEAD','rev-parse --show-toplevel'].map(args=>execute('git',args.split(' '),{cwd:this.root,windowsHide:true}))]);
        const proof=evaluateWindowsAuthorityCensus({services:os.service?[os.service]:[],nodes:os.nodes});
        let env='';try{env=await readFile(join(this.root,'.env'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
        const media=discoverMediaMtx(this.root,{services:os.mediaServices,processes:os.mediaProcesses});
        const {mediaServices,mediaProcesses,...observed}=os;
        return {...observed,media,ports:os.ports.filter(p=>p.LocalPort===8080),mediaPorts:os.ports.filter(p=>p.LocalPort!==8080),proof,branch:branch.stdout.trim(),head:head.stdout.trim(),root:root.stdout.trim(),
            bootstrapPermission:os.globalBootstrap||Boolean(process.env.LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP)||/^\s*(?:export\s+)?LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP\s*=/m.test(env)};
    }
    async restore(original){
        const encoded=Buffer.from(JSON.stringify(original),'utf8').toString('base64');
        return ps(`$ErrorActionPreference='Stop'
$o=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$s=Get-CimInstance Win32_Service -Filter "Name='LivezoneNode'"
if($s.State -ne 'Stopped' -or $s.StartMode -ne 'Disabled' -or $s.PathName -cne $o.PathName -or $s.StartName -cne $o.StartName){throw 'RESTORE_SERVICE_CHANGED'}
$mode=switch($o.StartMode){'Auto'{'Automatic'} 'Manual'{'Manual'} 'Disabled'{'Disabled'} default{throw 'INVALID_RESTORE_MODE'}}
Set-Service -Name LivezoneNode -StartupType $mode
$key='HKLM:\\SYSTEM\\CurrentControlSet\\Services\\LivezoneNode'
if($o.DelayedPresent){New-ItemProperty -LiteralPath $key -Name DelayedAutoStart -PropertyType DWord -Value ([int]$o.DelayedValue) -Force | Out-Null}
elseif((Get-ItemProperty -LiteralPath $key).PSObject.Properties['DelayedAutoStart']){Remove-ItemProperty -LiteralPath $key -Name DelayedAutoStart}
'{"restored":true,"started":false}'`);
    }
}
export function assertHost(h,root,{online=false,expected}={}){
    assertRepository(h,root,expected);
    if(!h.administrator)fail('ADMINISTRATOR_REQUIRED');
    if(h.service?.Name!=='LivezoneNode'||h.service.State!=='Stopped'||h.service.StartMode!=='Disabled')fail('SERVICE_MUST_BE_STOPPED_DISABLED');
    if(h.media?.status!=='VERIFIED'||h.media.Name!=='LivezoneMediaMtx')fail('MEDIAMTX_IDENTITY_REQUIRED');
    if(h.bootstrapPermission)fail('PERSISTENT_BOOTSTRAP_PERMISSION_FORBIDDEN');
    if(!online&&(h.proof?.absent!==true||h.ports?.length!==0))fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
}
