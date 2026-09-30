import {win32} from 'node:path';

// Deliberately limited to the installer's literal quoted/unquoted arguments.
// Reject shell expansion, escaped quotes and partial quoted tokens.
export function literalArguments(value){
    if(typeof value!=='string'||!value.trim())return null;
    const tokens=[];let rest=value.trim();
    while(rest){
        const match=/^(?:"([^"\r\n]*)"|([^\s"]+))(?:\s+|$)/.exec(rest);
        if(!match)return null;
        tokens.push(match[1]??match[2]);rest=rest.slice(match[0].length);
    }
    return tokens;
}
const path=value=>typeof value==='string'&&/^[a-z]:[\\/]/i.test(value)&&!/[\x00-\x1f]/.test(value)
    ?win32.normalize(value).replace(/\\+$/,'').toLowerCase():null;
const equal=(a,b)=>path(a)!==null&&path(a)===path(b);
const pid=value=>Number.isSafeInteger(value)&&value>0;
export function discoverMediaMtx(root,{services,processes}={}){
    const reject=reason=>({status:'UNVERIFIED',reason});
    if(!Array.isArray(services)||!Array.isArray(processes))return reject('INCOMPLETE_CENSUS');
    if(services.length!==1||services[0].Name!=='LivezoneMediaMtx')return reject('SERVICE_REQUIRED');
    const service=services[0],base=win32.join(root,'var/runtime');
    const wrapperPath=win32.join(base,'winsw/services/LivezoneMediaMtx/LivezoneMediaMtx.exe');
    const executable=win32.join(base,'mediamtx/mediamtx.exe'),config=win32.join(base,'mediamtx/mediamtx.yml');
    const serviceArgs=literalArguments(service.PathName);
    if(service.State!=='Running'||!pid(service.ProcessId))return reject('SERVICE_NOT_RUNNING');
    if(serviceArgs?.length!==1||!equal(serviceArgs[0],wrapperPath))return reject('SERVICE_PATH');
    const candidates=processes.filter(p=>String(p.Name).toLowerCase()==='mediamtx.exe'||equal(p.ExecutablePath,executable));
    if(candidates.length!==1)return reject('MEDIA_CANDIDATE_COUNT');
    const media=candidates[0],args=literalArguments(media.CommandLine);
    if(!pid(media.ProcessId)||String(media.Name).toLowerCase()!=='mediamtx.exe'||!equal(media.ExecutablePath,executable))return reject('MEDIA_EXECUTABLE');
    if(args?.length!==2||!equal(args[0],executable)||!equal(args[1],config))return reject('MEDIA_COMMAND_LINE');
    const unique=id=>{const rows=processes.filter(p=>p.ProcessId===id);return rows.length===1?rows[0]:null;};
    const launcher=unique(media.ParentProcessId),wrapper=unique(service.ProcessId);
    if(!launcher||!wrapper||!pid(launcher.ProcessId)||launcher.ParentProcessId!==wrapper.ProcessId||!equal(wrapper.ExecutablePath,wrapperPath)||
        String(wrapper.Name).toLowerCase()!=='livezonemediamtx.exe')return reject('SERVICE_PROCESS_CHAIN');
    const wa=literalArguments(wrapper.CommandLine),la=literalArguments(launcher.CommandLine);
    const shell=String(launcher.Name).toLowerCase();
    if(wa?.length!==1||!equal(wa[0],wrapperPath)||!['pwsh.exe','powershell.exe'].includes(shell)||
        win32.basename(launcher.ExecutablePath||'').toLowerCase()!==shell||!la||!equal(la[0],launcher.ExecutablePath))return reject('LAUNCHER_EXECUTABLE');
    const expected=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',win32.join(root,'tools/start-mediamtx.ps1'),
        '-BinaryPath',executable,'-TemplatePath',win32.join(root,'ops/mediamtx/mediamtx.example.yml'),
        '-RuntimeConfigPath',config,'-EnvironmentPath',win32.join(root,'.env')];
    if(la.length!==expected.length+1||expected.some((v,i)=>path(v)?!equal(v,la[i+1]):v.toLowerCase()!==la[i+1].toLowerCase()))return reject('LAUNCHER_ARGUMENTS');
    const times=[wrapper,launcher,media].map(p=>Date.parse(p.CreationDate));
    if(times.some(t=>!Number.isFinite(t))||times[0]>times[1]||times[1]>times[2]||new Set([wrapper.ProcessId,launcher.ProcessId,media.ProcessId]).size!==3)return reject('PROCESS_LIFETIME');
    return {status:'VERIFIED',Name:service.Name,State:service.State,PathName:service.PathName,
        wrapperPid:wrapper.ProcessId,launcherPid:launcher.ProcessId,pid:media.ProcessId,executable,config};
}
