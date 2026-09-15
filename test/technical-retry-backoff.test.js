import test from 'node:test';
import assert from 'node:assert/strict';
import LiveSourceMonitor,{TECHNICAL_RETRY_MAX_DELAY_MS} from '../public/js/studio/LiveSourceMonitor.js';
import SourcePresenceMonitor from '../public/js/studio/SourcePresenceMonitor.js';
import {shareTechnicalLiveHealth} from '../public/js/studio/SharedLiveHealthConsumer.js';
import {AUTO_LIVE_ENTRY_STABILITY_MS} from '../public/js/studio/AutoLiveEntryPolicy.js';
import {JSDOM} from 'jsdom';
import AutoLiveEntryController from '../public/js/studio/AutoLiveEntryController.js';
import StudioMediaSurface from '../public/js/studio/renderers/StudioMediaSurface.js';
import StudioAudioSurface from '../public/js/studio/renderers/StudioAudioSurface.js';

const source={id:'technical-live',kind:'hls',url:'https://fixture.test/live.m3u8'};
function harness(t,{adaptive=true}={}){
 let now=0,serial=0,active=0,peak=0,healthy=false;const timers=new Map(),attempts=[];
 const set=(fn,delay)=>{timers.set(++serial,{fn,at:now+delay});return serial;};
 const clear=id=>timers.delete(id);
 const clock=()=>now;
 const monitor=new LiveSourceMonitor({clock,setTimer:set,clearTimer:clear,
  ...(adaptive?{maxRetryDelayMs:TECHNICAL_RETRY_MAX_DELAY_MS}:{}),
  consumerFactory:(_source,handlers)=>{const entry={at:now,handlers,destroyed:false};attempts.push(entry);
   return {start(){active++;peak=Math.max(peak,active);if(healthy)handlers.online();else handlers.error('NETWORK');},
    destroy(){if(!entry.destroyed){entry.destroyed=true;active--;}}};}});
 t.after(()=>monitor.destroy());
 const advance=ms=>{const until=now+ms;let safety=0;
  for(;;){const next=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
   assert.ok(++safety<10000,'bounded timer progress');now=next[1].at;timers.delete(next[0]);next[1].fn();}now=until;};
 return {monitor,attempts,advance,set,clear,clock,get active(){return active;},get peak(){return peak;},set healthy(value){healthy=value;}};
}

test('repeated external presence stop and restart releases every lease and observer',t=>{
 const h=harness(t);h.monitor.selectSource(source);
 const baseline=h.monitor.listeners.size;
 const presence=new SourcePresenceMonitor({clock:h.clock,setTimer:h.set,clearTimer:h.clear,
  externalConsumerFactory:shareTechnicalLiveHealth(h.monitor,()=>{throw Error('unexpected fallback');})});
 t.after(()=>presence.destroy());
 for(let i=0;i<20;i++){
  presence.startExternal(source,presence.lifecycle);
  assert.equal(h.monitor.healthDemands.get(h.monitor.sourceKey(source)),1);
  h.advance(5000);presence.stop();presence.stop();
  assert.equal(h.monitor.healthDemands.size,0);
  assert.equal(h.monitor.listeners.size,baseline);
 }
});

test('source replacement releases old external demand before acquiring a new identity',t=>{
 const h=harness(t);h.monitor.selectSource(source);
 const presence=new SourcePresenceMonitor({clock:h.clock,setTimer:h.set,clearTimer:h.clear,
  externalConsumerFactory:shareTechnicalLiveHealth(h.monitor,()=>{throw Error('unexpected fallback');})});
 t.after(()=>presence.destroy());presence.startExternal(source,presence.lifecycle);
 presence.selectSource(null);assert.equal(h.monitor.healthDemands.size,0);
 const next={...source,id:'replacement',url:source.url+'?replacement'};
 h.monitor.selectSource(next);presence.startExternal(next,presence.lifecycle);
 assert.equal(h.monitor.healthDemands.has(h.monitor.sourceKey(source)),false);
 assert.equal(h.monitor.healthDemands.get(h.monitor.sourceKey(next)),1);
 presence.destroy();assert.equal(h.monitor.healthDemands.size,0);
});

test('characterization: CLOSED AutoLive owns external recovery demand until source removal or destroy',t=>{
 const h=harness(t);h.monitor.selectSource(source);
 const presence=new SourcePresenceMonitor({clock:h.clock,setTimer:h.set,clearTimer:h.clear,
  externalConsumerFactory:shareTechnicalLiveHealth(h.monitor,()=>{throw Error('unexpected fallback');})});
 // External endpoint classification is already independently covered by source-presence tests.
 presence.poll=function(lifecycle){this.startExternal(this.source,lifecycle);};
 const settings={armed:true,authorizedSourceId:source.id},listeners=new Set();
 const config={getSnapshot:()=>settings,subscribe(fn){listeners.add(fn);fn();return()=>listeners.delete(fn);}};
 const controller=new AutoLiveEntryController({config,
  catalog:{getSources:()=>[source],subscribe(fn){fn();return()=>{};}},monitor:presence,
  scheduler:{getSnapshot:()=>({enabled:true}),subscribe(fn){fn({enabled:true});return()=>{};}},
  command:{stateManager:{getProgramSceneId:()=> 'heavy-program'}},renderer:{},
  eventBus:{on(){},off(){}},clock:h.clock,setTimer:h.set,clearTimer:h.clear});
 t.after(()=>controller.destroy());controller.start();
 assert.equal(controller.getSnapshot().phase,'CLOSED');
 assert.equal(h.monitor.healthDemands.get(h.monitor.sourceKey(source)),1);
 h.advance(600000);assert.equal(h.attempts.length,121);
 assert.equal(controller.getSnapshot().phase,'CLOSED');assert.equal(h.peak,1);
 settings.authorizedSourceId=null;for(const fn of listeners)fn();
 assert.equal(h.monitor.healthDemands.size,0);
 controller.destroy();assert.equal(h.monitor.healthDemands.size,0);
});
test('passive immediate failures back off 5 5 10 20 30 seconds and stay bounded for ten minutes',t=>{
 const h=harness(t);h.monitor.selectSource(source);h.advance(600000);
 assert.deepEqual(h.attempts.slice(0,7).map(a=>a.at),[0,5000,10000,20000,40000,70000,100000]);
 assert.equal(h.attempts.length,23);assert.equal(h.active,0);assert.equal(h.peak,1);
 assert.ok(h.attempts.every(a=>a.destroyed));
});
test('non-Technical default cadence remains five seconds',t=>{
 const h=harness(t,{adaptive:false});h.monitor.selectSource(source);h.advance(600000);
 assert.equal(h.attempts.length,121);assert.equal(h.peak,1);
});
test('automatic healthy recovery cancels retry and resets passive failure history',t=>{
 const h=harness(t);h.monitor.selectSource(source);h.advance(45000);h.healthy=true;
 h.advance(25000);assert.equal(h.monitor.getSnapshot().state,'ONLINE');assert.equal(h.active,1);
 const count=h.attempts.length;h.advance(60000);assert.equal(h.attempts.length,count);
 h.healthy=false;h.attempts.at(-1).handlers.error('NETWORK');h.advance(4999);assert.equal(h.attempts.length,count);
 h.advance(1);assert.equal(h.attempts.length,count+1);assert.equal(h.peak,1);
});
test('AutoLive source demand preserves five-second retries even between failed attempts',t=>{
 const h=harness(t);const release=h.monitor.retainHealthDemand(source);h.monitor.selectSource(source);h.advance(600000);
 assert.equal(h.attempts.length,121);assert.equal(h.peak,1);release();release();
 h.advance(5000);const count=h.attempts.length;h.advance(29999);assert.equal(h.attempts.length,count);h.advance(1);assert.equal(h.attempts.length,count+1);
});
test('new AutoLive demand expedites an already backed-off Technical retry',t=>{
 const h=harness(t);h.monitor.selectSource(source);h.advance(45000);
 const count=h.attempts.length,release=h.monitor.retainHealthDemand(source);h.healthy=true;h.advance(0);
 assert.equal(h.attempts.length,count+1);assert.equal(h.monitor.getSnapshot().state,'ONLINE');release();
});
test('demand is source-specific and reference counted',t=>{
 const h=harness(t);const unrelated=h.monitor.retainHealthDemand({...source,url:source.url+'?other'});
 h.monitor.selectSource(source);h.advance(40000);assert.equal(h.attempts.length,5);
 const first=h.monitor.retainHealthDemand(source),second=h.monitor.retainHealthDemand(source);first();
 h.advance(15000);assert.equal(h.attempts.length,8);second();unrelated();assert.equal(h.monitor.healthDemands.size,0);
});
test('source selection resets backoff; retired consumer cannot report recovery',t=>{
 const h=harness(t);h.monitor.selectSource(source);h.advance(40000);const retired=h.attempts.at(-1);
 h.monitor.selectSource({...source,id:'other'});assert.equal(h.attempts.at(-1).at,40000);
 retired.handlers.online();assert.equal(h.monitor.getSnapshot().state,'OFFLINE');h.advance(5000);assert.equal(h.attempts.at(-1).at,45000);
 h.monitor.stop();const count=h.attempts.length;h.advance(60000);assert.equal(h.attempts.length,count);assert.equal(h.active,0);
});
test('SourcePresenceMonitor retains shared-health demand across consumer failures and releases on stop',t=>{
 const h=harness(t);h.monitor.selectSource(source);let cold=0;
 const factory=shareTechnicalLiveHealth(h.monitor,()=>{cold++;throw Error('must share Technical');});
 const presence=new SourcePresenceMonitor({clock:h.clock,setTimer:h.set,clearTimer:h.clear,externalConsumerFactory:factory});
 t.after(()=>presence.destroy());presence.startExternal(source,presence.lifecycle);
 h.advance(60000);assert.equal(h.attempts.length,13);assert.equal(cold,0);assert.equal(h.monitor.healthDemands.size,1);
 h.healthy=true;h.advance(5000);assert.equal(presence.getSnapshot().state,'ONLINE');
 presence.stop();assert.equal(h.monitor.healthDemands.size,0);
 assert.equal(AUTO_LIVE_ENTRY_STABILITY_MS,30000);
});
for(const kind of ['video','audio'])test('passive retry never reloads heavy '+kind+' Program or independent Preview',async t=>{
 const dom=new JSDOM('<div id="program"></div><div id="preview"></div>'),previous=globalThis.document;
 globalThis.document=dom.window.document;let plays=0,pauses=0;
 const proto=dom.window.HTMLMediaElement.prototype;proto.load=()=>{};proto.pause=()=>{pauses++;};proto.play=()=>{plays++;return Promise.resolve();};
 const Program=kind==='audio'?StudioAudioSurface:StudioMediaSurface;
 const program=new Program({consumer:'program',sourceId:'heavy-'+kind,sourceUrl:'http://fixture.test/heavy.mp4',audioUrl:'http://fixture.test/long.mp3',initialPlayback:'playing'});
 const preview=new StudioMediaSurface({consumer:'preview',sourceId:'small',sourceUrl:'http://fixture.test/small.mp4',initialPlayback:'playing'});
 t.after(()=>{program.destroy();preview.destroy();globalThis.document=previous;dom.window.close();});
 await program.start(document.querySelector('#program'));await preview.start(document.querySelector('#preview'));
 const primary=program.audio||program.video,secondary=preview.video,before={plays,pauses};
 const h=harness(t);h.monitor.selectSource(source);h.advance(600000);
 assert.equal(program.audio||program.video,primary);assert.equal(preview.video,secondary);
 assert.equal(program.destroyed,false);assert.equal(preview.destroyed,false);assert.deepEqual({plays,pauses},before);
 assert.equal(document.querySelectorAll('video,audio').length,2);
 assert.equal(h.attempts.length,23);
});
