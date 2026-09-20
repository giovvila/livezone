import {readFile,open,rename,lstat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {acquireMaintenanceGate} from './AuthorityMaintenanceGate.js';
import {evaluateWindowsAuthorityCensus} from './WindowsAuthorityProcessProof.js';
const execute=promisify(execFile);
const refuse=reason=>{throw new Error('RECONCILIATION_REFUSED: '+reason);};
export async function proveWindowsOffline(){
 if(process.platform!=='win32')return {absent:false,reason:'Windows service proof required'};
 const script=`$ErrorActionPreference='Stop'; $service=@(Get-CimInstance Win32_Service -Filter "Name='LivezoneNode'"); $nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='LivezoneNode.exe'" | Select-Object ProcessId,Name,ExecutablePath,CommandLine); [pscustomobject]@{services=@($service | Select-Object State,StartMode);nodes=$nodes} | ConvertTo-Json -Compress -Depth 4`;
 const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:1048576});
 const value=JSON.parse(stdout);
 return evaluateWindowsAuthorityCensus(value);
}
async function reservePort(port){
 const listener=createServer();
 await new Promise((ok,no)=>{listener.once('error',no);listener.listen({host:'0.0.0.0',port,exclusive:true},ok);});
 return ()=>new Promise(ok=>listener.close(ok));
}
// Proof providers are injectable only for isolated module tests, never CLI options.
export async function reconcileAuthorityLock({path,expectedEpoch,expectedPid,expectedSession,expectedEpochHash,expectedLockHash,port=8080,
 proveOffline=proveWindowsOffline,reserve=reservePort,isAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}}){
 path=resolve(path);if(!path.endsWith('.execution'))refuse('explicit execution authority path required');
 const releaseGate=await acquireMaintenanceGate(path);let releasePort;
 try{
  for(const file of [path,path+'.lock'])if(!(await lstat(file)).isFile()||(await lstat(file)).isSymbolicLink())refuse('ordinary files required');
  const epochBytes=await readFile(path,'utf8'),lockBytes=await readFile(path+'.lock','utf8');
  const hash=value=>createHash('sha256').update(value).digest('hex');
  if(expectedEpochHash&&hash(epochBytes)!==expectedEpochHash.toLowerCase()||expectedLockHash&&hash(lockBytes)!==expectedLockHash.toLowerCase())refuse('reviewed file hash mismatch');
  const epoch=JSON.parse(epochBytes).epoch,lock=JSON.parse(lockBytes);
  if(!Number.isSafeInteger(epoch)||epoch<1||epoch!==expectedEpoch||lock.pid!==expectedPid||lock.authorityProcessSession!==expectedSession)refuse('reviewed identity/epoch mismatch');
  if(isAlive(lock.pid))refuse('recorded owner is still alive or ambiguous');
  const proof=await proveOffline();if(proof.absent!==true)refuse(proof.reason||'exclusive service absence unproven');
  releasePort=await reserve(port);
  const finalProof=await proveOffline();if(finalProof.absent!==true)refuse('offline proof changed');
  if(await readFile(path,'utf8')!==epochBytes||await readFile(path+'.lock','utf8')!==lockBytes)refuse('authority files changed');
  const id=randomUUID(),archive=path+'.lock.reconciled-'+id,audit=path+'.reconciliation-'+id+'.json';
  const record={version:1,at:new Date().toISOString(),operator:process.env.USERNAME||process.env.USER||'unknown',
   action:'archive-abandoned-lock',path,archive,epoch,previousOwner:lock,proof:finalProof,port,state:'PREPARED'};
  const journal=await open(audit,'wx');
  try{await journal.writeFile(JSON.stringify(record,null,2));await journal.sync();}finally{await journal.close();}
  await rename(path+'.lock',archive);
  const completion=await open(audit+'.completed','wx');
  try{await completion.writeFile(JSON.stringify({state:'COMPLETED',epoch,archive}));await completion.sync();}finally{await completion.close();}
  return {epoch,archive,audit};
 }finally{if(releasePort)await releasePort();await releaseGate();}
}
