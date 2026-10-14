import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyLocalSystemCapabilityProof} from '../server/recovery/LocalSystemCapabilityProof.js';
import {WindowsRecoveryHost,assertHost} from '../server/recovery/WindowsRecoveryHost.js';
import {recoveryIdentity} from '../server/recovery/RecoveryContract.js';
import {installPermanentProof} from './PermanentProofInstaller.js';
import {windowsSecurity} from './PermanentProofWindowsSecurity.js';
// Production destination is fixed; there is no fixture/injected verifier CLI mode.
try {
const options={};const args=process.argv.slice(2);
for(let i=0;i<args.length;i+=2){if(!['--source','--expected-proof-hash','--approved-head','--authorize-install'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('INSTALL_ARGUMENTS');options[args[i]]=args[i+1];}
if(options['--authorize-install']!=='YES')throw Error('INSTALL_EXPLICIT_AUTHORIZATION_REQUIRED');
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const h=await new WindowsRecoveryHost(root).inspect();
assertHost(h,root,{expected:recoveryIdentity(options['--approved-head'])});
if(h.service.StartName!=='LocalSystem')throw Error('INSTALL_LOCALSYSTEM_REQUIRED');
const index=spawnSync('git',['--no-optional-locks','diff','--cached','--no-ext-diff','--no-textconv','--name-only'],{cwd:root,encoding:'utf8',windowsHide:true});
if(index.status!==0||index.stdout.trim())throw Error('INSTALL_INDEX_REQUIRED_EMPTY');
    const result=await installPermanentProof({source:options['--source'],destination:'C:\\ProgramData\\Livezone\\capability-evidence\\88443da7-5648-4a73-bda2-68f7db461908',expectedHash:options['--expected-proof-hash'],host:{platform:process.platform,administrator:h.administrator,serviceIdentity:h.service.StartName},verify:directory=>verifyLocalSystemCapabilityProof(directory,{serviceIdentity:h.service.StartName}),security:windowsSecurity()});
    console.log(JSON.stringify(result,null,2));
} catch(error) {console.log(JSON.stringify({status:'INSTALL_REVIEW_REQUIRED',reason:error.code||error.message,...error.installState},null,2));process.exitCode=1;}
