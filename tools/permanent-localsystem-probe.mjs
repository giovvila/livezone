// Fresh SYSTEM wrapper. Original approved durability producer remains byte-identical.
import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {probe,validateProbeRoot} from './localsystem-durability-probe.mjs';
import {schema,sha,producerInputs,readMachineIdentity} from '../server/recovery/PermanentCapabilityContract.js';
const [rootArgument,mode]=process.argv.slice(2),root=validateProbeRoot(rootArgument);
if(mode!=='success')throw Error('PERMANENT_PROBE_SUCCESS_ONLY');
const deadline=Date.now()+15000;
while(!fs.existsSync(join(root,'launch-success'))){if(Date.now()>deadline)throw Error('PROBE_JOB_RELEASE_TIMEOUT');await new Promise(r=>setTimeout(r,25));}
const machine=readMachineIdentity(),probeId=randomUUID(),createdAt=new Date().toISOString();
const repository=fileURLToPath(new URL('../',import.meta.url));
const inputs=producerInputs.map(name=>({name,sha256:sha(fs.readFileSync(join(repository,name)))}));
await probe(root,mode);
const result=fs.readFileSync(join(root,'result-success.json')),identity=fs.readFileSync(join(root,'identity-success.json'));
if(JSON.parse(result).status!=='PASS')throw Error('PERMANENT_PROBE_FAILED');
fs.writeFileSync(join(root,'receipt.json'),JSON.stringify({schema,probeId,createdAt,machine,sid:'S-1-5-18',pid:process.pid,inputs,resultHash:sha(result),identityHash:sha(identity)},null,2)+'\n',{flag:'wx'});
