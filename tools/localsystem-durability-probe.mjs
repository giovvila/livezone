// Administrative capability probe only; no application bootstrap or runtime state.
import fs from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import {resolve,relative,isAbsolute,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createWindowsLedgerDurability,helperPath,helperSha256,gatePath,gateSha256} from '../server/scheduler/WindowsLedgerDurability.js';

export function constrainTarget(root,target){
    if(!isAbsolute(target))throw Error('PROBE_ABSOLUTE_TARGET_REQUIRED');
    let current=resolve(target);const suffix=[];
    while(!fs.existsSync(current)){const parent=dirname(current);if(parent===current)throw Error('PROBE_TARGET_UNRESOLVED');suffix.unshift(current.slice(parent.length+1));current=parent;}
    const actual=join(fs.realpathSync(current),...suffix),base=fs.realpathSync(root);
    const child=relative(base,actual);
    if(!child||child.startsWith('..')||isAbsolute(child))throw Error('PROBE_TARGET_OUTSIDE_TEMP');
    return actual;
}
export function validateProbeRoot(root){
    if(typeof root!=='string'||!isAbsolute(root))throw Error('PROBE_ABSOLUTE_ROOT_REQUIRED');
    root=resolve(root);
    const rel=relative(fs.realpathSync(tmpdir()),fs.realpathSync(root));
    if(!rel.startsWith('lz-era05-probe-')||rel.startsWith('..')||isAbsolute(rel)||fs.lstatSync(root).isSymbolicLink())throw Error('PROBE_TEMP_ROOT_REQUIRED');
    return root;
}
export function createProbeAdapter(root,{run=spawnSync,calls=[]}={}){
    root=validateProbeRoot(root);
    return createWindowsLedgerDurability({run:(executable,args,options)=>{
        const fields=options.input.trimEnd().split('\n');
        const command=Buffer.from(fields[3],'base64').toString('utf8');
        const targets=fields.slice(4).map(value=>Buffer.from(value,'base64').toString('utf8'));
        for(const target of targets)constrainTarget(root,target);
        calls.push({command,targets});return run(executable,args,options);
    }});
}
export async function probe(root,mode){
    root=validateProbeRoot(root);
    const save=(name,value)=>fs.writeFileSync(constrainTarget(root,join(root,name)),JSON.stringify(value,null,2));
    const result={mode,root,capabilities:{},status:'FAIL'};
    try{
        const id=spawnSync('C:\\Windows\\System32\\whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
        if(id.status!==0||!id.stdout.includes('S-1-5-18'))throw Error('PROBE_LOCALSYSTEM_REQUIRED');
        result.identity={sid:'S-1-5-18',whoami:id.stdout.trim(),pid:process.pid};save('identity-'+mode+'.json',result.identity);
        if(mode==='fail')throw Error('DELIBERATE_PROBE_FAILURE');
        if(mode==='timeout'||mode==='interrupted'){
            const child=spawn(process.execPath,['--input-type=module','-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
            save('waiting-'+mode+'.json',{pid:process.pid,childPid:child.pid});
            await new Promise(()=>{});
        }
        if(mode!=='success')throw Error('PROBE_MODE');
        for(const [key,path,pin] of [['helper',helperPath,helperSha256],['gate',gatePath,gateSha256]]){
            const bytes=fs.readFileSync(path),digest=createHash('sha256').update(bytes).digest('hex'),pe=bytes.readUInt32LE(60);
            if(digest!==pin||bytes.toString('ascii',0,2)!=='MZ'||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664)throw Error('PROBE_NATIVE_IDENTITY');
            result[key]={path,sha256:digest,architecture:'x64',bytes:bytes.length};
        }
        // Every operation is checked again at the native launch boundary. The
        // original pinned adapter verifies executable identity and full protocol.
        const calls=[];
        const adapter=createProbeAdapter(root,{calls});
        const work=constrainTarget(root,join(root,'work'));fs.mkdirSync(work);
        result.capabilities.storage=adapter.capability(work);
        result.capabilities.namespace=adapter.invoke('sync-directory',work);
        const target=join(work,'target'),stage=join(work,'stage'),archive=join(work,'archive');
        for(const [path,bytes] of [[target,'OLD'],[stage,'NEW']]){constrainTarget(root,path);const fd=fs.openSync(path,'wx');try{fs.writeSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        result.capabilities.replace=adapter.replace(stage,target);
        if(fs.readFileSync(target,'utf8')!=='NEW'||fs.existsSync(stage))throw Error('PROBE_REPLACE_CONTENT');
        result.capabilities.archive=adapter.archive(target,archive);
        if(fs.existsSync(target)||fs.readFileSync(archive,'utf8')!=='NEW')throw Error('PROBE_ARCHIVE_CONTENT');
        result.capabilities.remove=adapter.remove(archive);
        if(fs.existsSync(archive))throw Error('PROBE_REMOVE_CONTENT');
        result.capabilities.finalNamespace=adapter.invoke('sync-directory',work);
        result.access={helperReadExecute:true,gateReadExecute:true,tempReadWrite:true};
        result.nativeCalls=calls;result.status='PASS';
    }catch(error){result.error=error.message;}
    save('result-'+mode+'.json',result);if(result.status!=='PASS')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const [root,mode]=process.argv.slice(2);
    // The service assigns the process to its kill-on-close job before releasing it.
    const deadline=Date.now()+15000;
    while(!fs.existsSync(join(root,'launch-'+mode))){if(Date.now()>deadline)throw Error('PROBE_JOB_RELEASE_TIMEOUT');await new Promise(ok=>setTimeout(ok,25));}
    await probe(root,mode);
}
