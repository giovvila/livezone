// All Node subprocesses inherit the guard through NODE_OPTIONS, including the
// node:test workers. This runner never invokes the application or service tools.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
const args=process.argv.slice(2);
if(!args.length || args.some(arg=>arg.startsWith('-'))) throw new Error('Supply explicit test file paths');
const testRoot=fileURLToPath(new URL('../test/',import.meta.url));
for(const arg of args){const rel=relative(testRoot,resolve(arg));if(rel.startsWith('..')||isAbsolute(rel)||!rel.endsWith('.test.js'))throw new Error('Only repository test entry points are allowed');}
const guard=new URL('../test-support/RuntimeStateGuard.mjs',import.meta.url).href;
const nativeGuard=new URL('../test-support/NativeTempGuard.mjs',import.meta.url).href;
const env={...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --import="${guard}" --import="${nativeGuard}"`};
const result=spawnSync(process.execPath,['--test',...args],{env,stdio:'inherit',windowsHide:true});
if(result.error) throw result.error;
process.exitCode=result.status??1;
