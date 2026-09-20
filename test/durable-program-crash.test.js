import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,open} from 'node:fs/promises';
import {renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Repository from '../server/program-output/DurableProgramRepository.js';
import Coordinator from '../server/program-output/ProgramCommitCoordinator.js';
import Store from '../server/program-output/ProgramOutputStore.js';
const run=promisify(execFile);
function envelope(revision=1){const at=new Date().toISOString();return {protocolVersion:1,publisherSessionId:'p',revision,publishedAt:at,snapshot:{version:1,publisherSessionId:'p',revision,publishedAt:at,committedAt:at,scene:null,source:null,playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}}};}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'lz-dp1-crash-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'program.json'),store=new Store(),repository=new Repository({path}),coordinator=new Coordinator({repository,store});await coordinator.initialize();assert.equal((await coordinator.accept(envelope(),{check:()=>true})).accepted,true);return {dir,path,store,repository,coordinator};}
for(const boundary of ['opened','written','flushed','staged','before-replace','replaced','installed','notified'])test('DP1 process exit at '+boundary+' recovers only committed canonical generation',async t=>{
 const h=await fixture(t);const modules=['DurableProgramRepository','ProgramCommitCoordinator','ProgramOutputStore'].map(n=>new URL('../server/program-output/'+n+'.js',import.meta.url).href);
 const script=`import Repository from ${JSON.stringify(modules[0])};import Coordinator from ${JSON.stringify(modules[1])};import Store from ${JSON.stringify(modules[2])};
 const repository=new Repository({path:${JSON.stringify(h.path)},hook:s=>{if(s===${JSON.stringify(boundary)})process.exit(73);}}),store=new Store(),c=new Coordinator({repository,store,validate:async()=>true});await c.initialize();await c.accept(${JSON.stringify(envelope(2))},{check:()=>true});`;
 await assert.rejects(run(process.execPath,['--input-type=module','-e',script]),e=>e.code===73);
 const repository=new Repository({path:h.path});await repository.load();assert.equal(repository.status,'EXPLICIT_EMPTY');assert.equal(repository.record.envelope.revision,['replaced','installed','notified'].includes(boundary)?2:1);
});
for(const failure of ['ENOSPC','EACCES','short-write','flush','replace','ambiguous-replace','final-flush'])test('DP1 '+failure+' does not acknowledge or notify',async t=>{
 const h=await fixture(t),before=h.store.getCurrent();let count=0;h.store.subscribe(()=>count++);
 const fail=()=>{throw Object.assign(Error(failure),{code:failure});};
 if(['ENOSPC','EACCES','short-write','flush'].includes(failure))h.repository.fs.open=async(...args)=>{
  if(failure==='EACCES')fail();const file=await open(...args);return {write:failure==='short-write'?async()=>({bytesWritten:0}):failure==='ENOSPC'?async()=>fail():file.write.bind(file),sync:failure==='flush'?async()=>fail():file.sync.bind(file),close:file.close.bind(file)};
 };
 if(failure==='replace')h.repository.fs.renameSync=fail;
 if(failure==='ambiguous-replace')h.repository.fs.renameSync=(...args)=>{renameSync(...args);fail();};
 if(failure==='final-flush')h.repository.fs.fsyncSync=fail;
 const result=await h.coordinator.accept(envelope(2),{check:()=>true});assert.equal(result.accepted,false);assert.equal(count,0);assert.equal(h.store.getCurrent(),before);
 if(['ambiguous-replace','final-flush'].includes(failure)){assert.equal(h.repository.error,'DURABLE_COMMIT_UNCERTAIN');assert.equal(JSON.parse(await readFile(h.path,'utf8')).envelope.revision,2);assert.equal((await h.coordinator.accept(envelope(3),{check:()=>true})).accepted,false);}
});
test('DP1 handles partial writes and ignores orphan staging files',async t=>{
 const h=await fixture(t);h.repository.fs.open=async(...args)=>{const f=await open(...args);return {write:(buffer,offset,length,position)=>f.write(buffer,offset,Math.min(7,length),position),sync:f.sync.bind(f),close:f.close.bind(f)};};
 assert.equal((await h.coordinator.accept(envelope(2),{check:()=>true})).accepted,true);await writeFile(h.path+'.orphan.tmp','partial');
 const r=new Repository({path:h.path});await r.load();assert.equal(r.record.envelope.revision,2);
});
