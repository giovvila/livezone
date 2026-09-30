import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {RecoveryWorkflow} from '../server/recovery/RecoveryWorkflow.js';
import {WindowsRecoveryHost} from '../server/recovery/WindowsRecoveryHost.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {fail} from '../server/recovery/RecoveryContract.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [mode,runId,...flags]=process.argv.slice(2);
const allowed=new Set(['--authorize-legacy','--authorize-disarm','--authorize-start','--authorize-bootstrap']);
let revision,hash;
for(let i=0;i<flags.length;i++){
    if(flags[i]==='--expected-revision'){revision=Number(flags[++i]);continue;}
    if(flags[i]==='--expected-hash'){hash=flags[++i];continue;}
    if(!allowed.has(flags[i]))fail('UNKNOWN_RECOVERY_OPTION');
}
const workflow=new RecoveryWorkflow({root,runId:runId==='-'?undefined:runId,host:new WindowsRecoveryHost(root)});
try{
    if(resolve(process.cwd()).toLowerCase()!==root.toLowerCase())fail('RUN_FROM_REPOSITORY_ROOT');
    let result;
    if(mode==='DryRun')result=await workflow.inspect();
    else if(mode==='Prepare')result=await workflow.begin({authorizeLegacy:flags.includes('--authorize-legacy')});
    else if(mode==='AutoPlan')result=await workflow.autoPlan();
    else if(mode==='Scheduled')result=await workflow.scheduled();
    else if(mode==='Prepared')result=await workflow.prepared();
    else if(mode==='Disarm')result=await workflow.disarm({authorize:flags.includes('--authorize-disarm'),expectedRevision:revision,expectedHash:hash});
    else if(mode==='Start'){
        let env='';try{env=await readFile(resolve(root,'.env'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
        if(process.env.LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP||/^\s*(?:export\s+)?LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP\s*=/m.test(env))fail('PERSISTENT_BOOTSTRAP_PERMISSION_FORBIDDEN');
        if(env)process.loadEnvFile(resolve(root,'.env'));
        if(process.env.PORT&&process.env.PORT!=='8080')fail('RECOVERY_PORT_MUST_BE_8080');
        for(const [name,path] of [['LIVEZONE_STUDIO_STATE_PATH',workflow.p.studio],['LIVEZONE_SCHEDULE_PATH',workflow.p.schedule],['LIVEZONE_MEDIA_LIBRARY_ROOT',workflow.p.mediaRoot]])
            if(process.env[name]&&resolve(process.env[name]).toLowerCase()!==path.toLowerCase())fail('RECOVERY_PATH_ENVIRONMENT_CONFLICT');
        const started=await controlledStart({workflow,authorizeStart:flags.includes('--authorize-start'),authorizeBootstrap:flags.includes('--authorize-bootstrap')});
        result=started.result;
        console.log('CONTROLLED START VERIFIED; RESTART_RECONCILIATION_REQUIRED remains. Ctrl+C here to drain before RestoreService.');
    }else if(mode==='RestoreService')result=await workflow.restore();
    else fail('UNKNOWN_RECOVERY_MODE');
    console.log(JSON.stringify(result,null,2));
}catch(error){console.error('RECOVERY STOPPED: '+error.message);
    if(error.manualServerMayBeRunning)console.error('Manual server may still be running in this terminal. No rollback or automatic restart. Inspect logs; Ctrl+C to drain.');
    process.exitCode=1;
}
