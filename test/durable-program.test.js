import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Store from '../server/program-output/ProgramOutputStore.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
export function envelope(kind=null,revision=1,publisherSessionId='publisher'){
 const at=new Date().toISOString();return createProgramOutputEnvelope({version:1,publisherSessionId,revision,publishedAt:at,committedAt:at,
  scene:kind?{id:'scene',name:'Program',type:kind==='break'?'SLATE':'MEDIA'}:null,
  source:kind?{id:'source',kind,...(kind==='break'?{title:'Slate',message:'Message',logoUrl:'https://example.test/logo.png'}:kind==='audio'?{audioUrl:'https://example.test/a.mp3',stillUrl:'https://example.test/s.png',motionUrl:'https://example.test/m.mp4'}:{url:'https://example.test/source'})}:null,
  playback:{initialTime:27,duration:120,playing:true,ended:false,state:'playing',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
}
async function fixture(t,options={}){
 const {default:Repository}=await import('../server/program-output/DurableProgramRepository.js');
 const {default:Coordinator}=await import('../server/program-output/ProgramCommitCoordinator.js');
 const dir=await mkdtemp(join(tmpdir(),'lz-dp1-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'state.json.program-output.json'),store=new Store();
 const repository=new Repository({path,...options});
 const coordinator=new Coordinator({repository,store,bind:async()=>({sourceFingerprint:null,assets:[]}),validate:async()=>true});
 await coordinator.initialize();return {path,store,repository,coordinator,Repository,Coordinator};
}
for(const kind of [null,'media','audio','image','break','hls'])test('DP1 durable restart preserves '+(kind||'explicit empty')+' and exact envelope',async t=>{
 const h=await fixture(t),e=envelope(kind);assert.equal(h.repository.status,'UNAVAILABLE');
 assert.equal((await h.coordinator.accept(e,{check:()=>true})).accepted,true);
 const disk=JSON.parse(await readFile(h.path,'utf8'));assert.deepEqual(disk.envelope,h.store.getCurrent());
 const repository=new h.Repository({path:h.path}),store=new Store();await new h.Coordinator({repository,store,validate:async()=>true}).initialize();
 assert.equal(repository.status,kind?'PRESENT':'EXPLICIT_EMPTY');assert.deepEqual(store.getCurrent(),e);
});
test('DP1 staging failure cannot update memory or notify',async t=>{
 const h=await fixture(t);await h.coordinator.accept(envelope(),{check:()=>true});const before=h.store.getCurrent();let notified=0;h.store.subscribe(()=>notified++);
 h.repository.hook=stage=>{if(stage==='staged')throw Object.assign(Error('full'),{code:'ENOSPC'});};
 assert.equal((await h.coordinator.accept(envelope(null,2),{check:()=>true})).accepted,false);assert.equal(h.store.getCurrent(),before);assert.equal(notified,0);
});
test('DP1 rechecks lease after staging and does not retire candidate publisher',async t=>{
 let valid=true;const h=await fixture(t);await h.coordinator.accept(envelope(),{check:()=>true});
 h.repository.hook=stage=>{if(stage==='staged')valid=false;};
 assert.equal((await h.coordinator.accept(envelope(null,1,'next'),{check:()=>valid})).accepted,false);
 assert.equal(h.store.getCurrent().publisherSessionId,'publisher');assert.equal(h.store.retiredSessions.size,0);
});
test('DP1 listener failure after commit still acknowledges durable publication',async t=>{
 const h=await fixture(t);h.store.subscribe(()=>{throw Error('SSE disconnected');});assert.equal((await h.coordinator.accept(envelope(),{check:()=>true})).accepted,true);
 assert.deepEqual(JSON.parse(await readFile(h.path,'utf8')).envelope,h.store.getCurrent());
});
test('DP1 ledger recovery rejects retired and same-revision publishers',async t=>{
 const h=await fixture(t);await h.coordinator.accept(envelope(),{check:()=>true});await h.coordinator.accept(envelope(null,1,'next'),{check:()=>true});
 const store=new Store(),repository=new h.Repository({path:h.path}),c=new h.Coordinator({store,repository,validate:async()=>true});await c.initialize();
 assert.equal((await c.accept(envelope(),{check:()=>true})).reason,'retired-session');assert.equal((await c.accept(envelope(null,1,'next'),{check:()=>true})).reason,'stale-revision');
});
for(const bad of ['{','schema','checksum'])test('DP1 corrupt '+bad+' is not empty',async t=>{
 const h=await fixture(t);await h.coordinator.accept(envelope(),{check:()=>true});let value=JSON.parse(await readFile(h.path,'utf8'));
 if(bad==='schema')value.schemaVersion=99;if(bad==='checksum')value.envelope.revision++;
 await writeFile(h.path,bad==='{'?bad:JSON.stringify(value));const store=new Store(),repository=new h.Repository({path:h.path});await new h.Coordinator({store,repository,validate:async()=>true}).initialize();
 assert.equal(repository.status,'CORRUPT');assert.equal(store.getCurrent(),null);
});
test('DP1 changed dependencies preserve historical record but do not hydrate',async t=>{
 const h=await fixture(t);await h.coordinator.accept(envelope('hls'),{check:()=>true});const repository=new h.Repository({path:h.path}),store=new Store();
 await new h.Coordinator({repository,store,validate:async()=>false}).initialize();assert.equal(repository.status,'UNRESOLVED');assert.ok(repository.record);assert.equal(store.getCurrent(),null);
});

for(const state of ['paused','ended'])test('DP1 '+state+' media preserves cue and anchor after restart',async t=>{
 const h=await fixture(t),e=structuredClone(envelope('media'));Object.assign(e.snapshot.playback,{playing:false,ended:state==='ended',state,initialTime:state==='ended'?120:37});
 assert.equal((await h.coordinator.accept(e,{check:()=>true})).accepted,true);const repository=new h.Repository({path:h.path}),store=new Store();await new h.Coordinator({repository,store,validate:async()=>true}).initialize();assert.deepEqual(store.getCurrent().snapshot.playback,e.snapshot.playback);
});
test('DP1 oversized canonical file is corrupt and cannot become empty',async t=>{
 const h=await fixture(t);await writeFile(h.path,' '.repeat(128*1024+1));await h.coordinator.initialize();assert.equal(h.repository.status,'CORRUPT');assert.equal(h.store.getCurrent(),null);
});
