import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export const helperPath=fileURLToPath(new URL('../../tools/native/windows-ledger-durability/generated/windows-ledger-durability.exe',import.meta.url));
// Reviewed build identity; a different compiler/build requires explicit review.
export const helperSha256='18e6f512134b371a38e2afe4aaf1b24778f4eb38e7656a186b3557ac0c1a8d0b';
export const executionHost='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const gatePath=fileURLToPath(new URL('../../tools/native/windows-ledger-durability/generated/LedgerExecutionGate.dll',import.meta.url));
export const gateSha256='9b726c3ef2c16ff31478b4d2d5735a325d1418f0358d533faf594363485c5cc3';
// Assembly.Load(byte[]) executes the exact verified buffer; no generated assembly pathname is loaded.
const hostScript="$ErrorActionPreference='Stop';try{[void][Reflection.Assembly]::Load([Convert]::FromBase64String([Console]::ReadLine()));exit [LedgerExecutionGate]::Run()}catch{exit 70}";
const hostArguments=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(hostScript,'utf16le').toString('base64')];
const failure=()=>{throw Object.assign(Error('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});};
const commands=new Map([['capability',1],['sync-directory',1],['durable-replace',2],['durable-archive',2],['durable-remove',1]]);
const keys=['helper','version','protocol','architecture','command','ok','directory','volume','volumeSerial','filesystem','local','barrier'];
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
function verifiedBinary() {
    const stat=lstatSync(helperPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||!same(realpathSync(helperPath),helperPath))failure();
    const bytes=readFileSync(helperPath),pe=bytes.length>=64?bytes.readUInt32LE(60):0;
    if(bytes.toString('ascii',0,2)!=='MZ'||pe+26>bytes.length||bytes.readUInt32LE(pe)!==0x4550||
        bytes.readUInt16LE(pe+4)!==0x8664||createHash('sha256').update(bytes).digest('hex')!==helperSha256)failure();
}
function verifiedGate() {
    const bytes=readFileSync(gatePath);
    if(bytes.length>65536||createHash('sha256').update(bytes).digest('hex')!==gateSha256)failure();
    return bytes;
}
// Dependency injection is for tests only. Executable path and identity cannot be overridden.
export function createWindowsLedgerDurability({run=spawnSync,verify=verifiedBinary}={}) {
    const invoke=(command,...paths)=>{
        try {
            if(process.platform!=='win32'||process.arch!=='x64'||commands.get(command)!==paths.length ||
                paths.some(p=>typeof p!=='string'||!isAbsolute(p)||p.includes('\0')||p.length>4096))failure();
            const args=paths.map(p=>resolve(p));
            verify();
            const gate=verifiedGate();
            const input=gate.toString('base64')+'\n'+[helperPath,helperSha256,command,...args].map(p=>Buffer.from(p,'utf8').toString('base64')).join('\n')+'\n';
            const result=run(executionHost,hostArguments,{encoding:'utf8',windowsHide:true,shell:false,input,
                timeout:10000,maxBuffer:64*1024,stdio:['pipe','pipe','pipe']});
            if(result.error||result.signal||result.status!==0||result.stderr!==''||typeof result.stdout!=='string'||
                !result.stdout.endsWith('\n')||result.stdout.trim().includes('\n'))failure();
            const value=JSON.parse(result.stdout),directory=command==='capability'||command==='sync-directory'?args[0]:dirname(args[0]);
            if(!value||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k)) ||
                value.helper!=='livezone-windows-ledger-durability'||value.version!=='1.0.0'||value.protocol!==1||
                value.architecture!=='x64'||value.command!==command||value.ok!==true||value.filesystem!=='NTFS'||
                value.local!==true||value.barrier!=='NTFS_DIRECTORY_FLUSH'||typeof value.directory!=='string'||
                !same(value.directory,directory)||!/^\\\\\?\\Volume\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}\\$/i.test(value.volume)||
                !Number.isSafeInteger(value.volumeSerial)||value.volumeSerial<0||value.volumeSerial>0xffffffff)failure();
            return Object.freeze(value);
        } catch {failure();}
    };
    return Object.freeze({invoke,capability:p=>invoke('capability',p),
        syncDirectory:p=>{invoke('sync-directory',dirname(p));return 'DIRECTORY_SYNCED';},
        replace:(from,to)=>invoke('durable-replace',from,to),
        archive:(from,to)=>invoke('durable-archive',from,to),remove:p=>invoke('durable-remove',p)});
}
export const windowsLedgerDurability=createWindowsLedgerDurability();
