import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import {validateProgramOutputSnapshot} from '../public/js/program-output/ProgramOutputContract.js';
import {AUTO_LIVE_ENTRY_ID} from '../public/js/program-output/AutoLiveEntrySlate.js';
import {AUTO_LIVE_LOSS_SLATE_ID} from '../public/js/program-output/AutoLiveLossSlate.js';
import {createTextCrawlElement,TextCrawlView} from '../public/js/studio/renderers/TextCrawlElement.js';
import OutputRevisionGate from '../public/js/program-output/OutputRevisionGate.js';
import PublicProgramController from '../public/js/public/PublicProgramController.js';
import ControlCrawlObserver from '../public/js/program-output/ControlCrawlObserver.js';
import StudioGraphicsLayer from '../public/js/studio/renderers/StudioGraphicsLayer.js';
const epoch=Date.parse('2026-09-12T20:00:00Z'),stamp=n=>new Date(epoch+n).toISOString();
const crawl=(patch={})=>({id:'crawl-a',name:'Evening news',version:1,type:'overlay.crawl',enabled:true,startAt:stamp(1000),endAt:stamp(10000),priority:0,
 payload:{text:'News <script>alert(1)</script>',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true},...patch});
const program=(patch={})=>({version:1,publisherSessionId:'control',revision:1,publishedAt:stamp(0),committedAt:stamp(0),
 scene:{id:'video',name:'Video',type:'MEDIA'},source:{id:'video-source',kind:'media',url:'https://example.test/video.mp4'},
 playback:{initialTime:30,duration:600,playing:true,ended:false,state:'playing',startedAt:stamp(0)},
 graphics:{items:[]},overlays:{},transition:{type:'cut',durationMs:0},...patch});
async function harness(t,{withProgram=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'lz-crawl-'));const clock={now:epoch};const aborts=[];let server;
 const make=()=>createProgramOutputServer({publisherToken:'crawl-test-publisher',operatorAuth:new OperatorAuth({disabled:true}),schedulePath:join(dir,'schedule.json'),studioStatePath:join(dir,'studio.json'),
 mediaAssetRepository:{initialize:async()=>{},get:id=>id==='asset-00000000-0000-4000-8000-000000000001'?{kind:'image',url:'/media-library/files/image/sponsor.png'}:null},scheduleClock:()=>clock.now,scheduleSetTimer:()=>1,scheduleClearTimer:()=>{}});
 async function start(){server=make();await new Promise(r=>server.server.listen(0,'127.0.0.1',r));await server.scheduler.ready;}
 async function stop(){aborts.forEach(a=>a.abort());await new Promise(r=>server.server.close(r));}
 await start();t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 if(withProgram)server.store.accept(createProgramOutputEnvelope(program()));
 const h={get server(){return server;},clock,get base(){return 'http://127.0.0.1:'+server.server.address().port;},
  async write(method,suffix,body){const response=await fetch(h.base+'/api/studio/schedule'+suffix,{method,headers:{'Content-Type':'application/json','If-Match':'"schedule-'+server.scheduler.store.getSnapshot().revision+'"'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};},
  tick(n){clock.now=epoch+n;server.scheduler.runtime.reconcile();},
  current(){return server.effectiveOutput.getCurrent()?.snapshot;},
  async publish(snapshot){const response=await fetch(h.base+'/api/program-output',{method:'POST',headers:{Authorization:'Bearer crawl-test-publisher','Content-Type':'application/json'},body:JSON.stringify(createProgramOutputEnvelope(snapshot))});assert.equal(response.status,202);},
  async stream(){const a=new AbortController();aborts.push(a);const response=await fetch(h.base+'/api/program-output/events',{signal:a.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);const reader=response.body.getReader();let buffer='';return {async next(){for(;;){let i;while((i=buffer.indexOf('\n\n'))>=0){const packet=buffer.slice(0,i);buffer=buffer.slice(i+2);const line=packet.split('\n').find(l=>l.startsWith('data: '));if(line)return JSON.parse(line.slice(6)).snapshot;}const chunk=await reader.read();if(chunk.done)throw Error('closed');buffer+=new TextDecoder().decode(chunk.value);}}};},
  async restart(){await stop();await start();}
 };return h;
}
const visible=s=>s?.overlays?.textCrawl?.enabled===true;

test('crawl API preserves name and future state without changing Program',async t=>{const h=await harness(t);const before=h.server.store.getCurrent();const r=await h.write('POST','/events',crawl());assert.equal(r.status,201);assert.equal(r.body.schedule.events[0].name,'Evening news');assert.equal(visible(h.current()),false);assert.deepEqual(h.server.store.getCurrent(),before);});
for(const [name,time,expected] of [['start',1000,true],['midpoint',5000,true],['end',10000,false]])test('exact '+name+' uses server interval',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(time);assert.equal(visible(h.current()),expected);assert.deepEqual(h.current().playback,program().playback);});
for(const [name,method,body] of [['disable','PATCH',{enabled:false}],['delete','DELETE',null]])test(name+' active crawl clears composite immediately',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);await h.write(method,'/events/crawl-a',body);assert.equal(visible(h.current()),false);assert.deepEqual(h.current().source,program().source);});
test('editing active text preserves media and advances only server output revision',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);const before=h.current();await h.write('PATCH','/events/crawl-a',{payload:{...crawl().payload,text:'Updated'}});const next=h.current();assert.equal(next.overlays.textCrawl.text,'Updated');assert.equal(next.revision,before.revision);assert.ok(next.output.revision>before.output.revision);assert.deepEqual(next.playback,before.playback);assert.deepEqual(next.scene,before.scene);});
test('priority winner expiry restores lower-priority active crawl',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());await h.write('POST','/events',crawl({id:'higher',priority:10,startAt:stamp(2000),endAt:stamp(4000),payload:{...crawl().payload,text:'High'}}));h.tick(2500);assert.equal(h.current().overlays.textCrawl.text,'High');h.tick(4000);assert.equal(h.current().overlays.textCrawl.text,crawl().payload.text);});
for(const consumer of ['Public','OBS'])test(consumer+' open receives start/end while Control and Scheduler are closed',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());const stream=await h.stream();await stream.next();h.tick(1000);assert.equal(visible(await stream.next()),true);h.tick(10000);assert.equal(visible(await stream.next()),false);});
for(const consumer of ['Public late join','OBS late join','Public refresh','OBS refresh','Control reconnect'])test(consumer+' receives retained current crawl',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(5000);const stream=await h.stream();const snapshot=await stream.next();assert.equal(visible(snapshot),true);assert.equal(snapshot.overlays.textCrawl.scheduled.startAt,stamp(1000));});
test('server restart keeps active crawl separate until Control establishes a real base',async t=>{
 const h=await harness(t);await h.write('POST','/events',crawl());h.tick(5000);await h.restart();
 assert.equal(h.server.store.getCurrent(),null);assert.equal(h.current(),undefined);
 assert.equal(h.server.effectiveOutput.effectiveCrawl.id,'crawl-a');
 const publicStream=await h.stream(),obsStream=await h.stream();
 let publications=0;h.server.effectiveOutput.subscribe(()=>publications++);h.tick(6000);
 assert.equal(publications,0);await h.publish(program({publisherSessionId:'reopened-control'}));
 for(const stream of [publicStream,obsStream]){
 const snapshot=await stream.next();assert.ok(validateProgramOutputSnapshot(snapshot));
 assert.equal(snapshot.publisherSessionId,'reopened-control');assert.equal(snapshot.output.overlayOnly,false);
 assert.deepEqual(snapshot.source,program().source);assert.equal(visible(snapshot),true);
 }
 assert.equal(publications,1);
});
for(const phase of ['ENTRY','LOSS'])test(phase+' suppresses scheduled crawl and recovery preserves deadline',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);const technical=phase==='ENTRY'?{scene:{id:AUTO_LIVE_ENTRY_ID,name:'Entry',type:'SLATE'},source:{id:AUTO_LIVE_ENTRY_ID,kind:'break',title:'Entry',message:'Preparing',logoUrl:'https://example.test/logo.png'}}:{graphics:{items:[{id:AUTO_LIVE_LOSS_SLATE_ID,kind:'image',position:'top-left',url:'https://example.test/logo.png'}]}};
 await h.publish(program({...technical,revision:2}));assert.equal(visible(h.current()),false);h.tick(6000);await h.publish(program({revision:3}));assert.equal(visible(h.current()),true);assert.equal(h.current().overlays.textCrawl.scheduled.startAt,stamp(1000));h.tick(10000);assert.equal(visible(h.current()),false);});
test('BREAK retains scheduled crawl and AutoLive LIVE identity transitions do not clear it',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);await h.publish(program({revision:2,scene:{id:'break',name:'Break',type:'SLATE'},source:{id:'break',kind:'break',title:'BREAK',message:'Break',logoUrl:'https://example.test/logo.png'}}));assert.equal(visible(h.current()),true);await h.publish(program({revision:3,source:{id:'live',kind:'hls',url:'https://example.test/live.m3u8'}}));assert.equal(visible(h.current()),true);});
test('manual visible wins and release restores scheduled winner without changing schedule',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);const schedule=h.server.scheduler.store.getSnapshot();const manual={enabled:true,mode:'fixed',text:'Manual',position:'top',direction:'rtl',speed:'medium',background:true};await h.publish(program({revision:2,overlays:{textCrawl:manual}}));assert.equal(h.current().overlays.textCrawl.text,'Manual');await h.publish(program({revision:3,overlays:{textCrawl:{...manual,enabled:false}}}));assert.equal(h.current().overlays.textCrawl.text,crawl().payload.text);assert.deepEqual(h.server.scheduler.store.getSnapshot(),schedule);});
test('new Control publication and stale rejected Control write cannot erase scheduled overlay',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);await h.publish(program({revision:3}));assert.equal(visible(h.current()),true);const before=h.current();assert.equal(h.server.store.accept(createProgramOutputEnvelope(program({revision:2}))).accepted,false);assert.deepEqual(h.current(),before);});
test('channel logo and lower third coexist unchanged with scheduled crawl',async t=>{const h=await harness(t);const graphics={items:[{id:'logo',kind:'image',position:'top-right',url:'https://example.test/logo.png'},{id:'lower',kind:'lower-third',position:'bottom-left',title:'Title',subtitle:'Subtitle'}]};await h.publish(program({revision:2,graphics}));await h.write('POST','/events',crawl());h.tick(2000);assert.deepEqual(h.current().graphics,graphics);assert.equal(visible(h.current()),true);});
test('clock reconciliation does not publish animation frames or mutate Program ingress',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(1000);let publications=0;h.server.effectiveOutput.subscribe(()=>publications++);const before=h.server.store.getCurrent();for(let n=1100;n<9000;n+=100)h.tick(n);assert.equal(publications,0);assert.deepEqual(h.server.store.getCurrent(),before);});
for(const [field,value] of [['speed','zero'],['speed',0],['speed',-1],['direction','up'],['position','arbitrary']])test('invalid crawl '+field+' '+value+' rejected',async t=>{const h=await harness(t);const event=crawl();event.payload[field]=value;assert.equal((await h.write('POST','/events',event)).status,422);});
test('late join after expiration never sees expired crawl',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(1000);h.tick(10000);assert.equal(visible(await (await h.stream()).next()),false);});

class Element {constructor(){this.children=[];this.style={};this.dataset={};this.parentNode=null;}appendChild(x){this.children.push(x);x.parentNode=this;}replaceChildren(...items){this.children.forEach(x=>x.parentNode=null);this.children=[];items.forEach(x=>this.appendChild(x));}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;}}
function dom(t){const before=globalThis.document;globalThis.document={createElement:()=>new Element()};t.after(()=>{if(before===undefined)delete globalThis.document;else globalThis.document=before;});}
const item=(patch={})=>({enabled:true,mode:'crawl',...crawl().payload,scheduled:{eventId:'a',startAt:stamp(0),endAt:stamp(10000)},...patch});
for(const position of ['top','bottom'])for(const prefix of ['studio','public'])test(prefix+' '+position+' uses shared safe text and elapsed animation phase',t=>{dom(t);const element=createTextCrawlElement(item({position}),{prefix,now:()=>epoch+5000});assert.match(element.className,new RegExp('--'+position));assert.equal(element.children[0].textContent,crawl().payload.text);assert.equal(element.children[0].style.animationDelay,'-5s');});
test('same logical crawl retains node and stale expiry callback cannot remove newer event',t=>{dom(t);const timers=[];const view=new TextCrawlView({now:()=>epoch+5000,setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer(){}});const a=view.node(item());assert.equal(view.node(item()),a);const b=view.node(item({text:'New'}));timers[0]();assert.equal(view.element,b);view.destroy();});
test('expiration removes once and same expired revision cannot resurrect DOM',t=>{dom(t);let now=epoch+5000,expire;const view=new TextCrawlView({now:()=>now,setTimer:fn=>{expire=fn;return 1;},clearTimer(){}});const parent=new Element(),element=view.node(item());parent.appendChild(element);now=epoch+10000;expire();assert.equal(parent.children.length,0);assert.equal(view.node(item()),null);view.destroy();});
test('server overlay revision rejects duplicate, stale and retired-server callbacks',()=>{const gate=new OutputRevisionGate();const snapshot=(sessionId,revision)=>({output:{sessionId,revision}});assert.equal(gate.accept(snapshot('a',2)),true);assert.equal(gate.accept(snapshot('a',1)),false);assert.equal(gate.accept(snapshot('a',2)),false);assert.equal(gate.accept(snapshot('b',1)),true);assert.equal(gate.accept(snapshot('a',3)),false);});
test('Control observer consumes effective overlay without Program/Preview commands',()=>{let listener,seen=[];const transport={subscribe:fn=>{listener=fn;return()=>{};},start(){},destroy(){}};const observer=new ControlCrawlObserver({layer:{setEffectiveCrawl:value=>seen.push(value)},transport});observer.start();listener({output:{sessionId:'server',revision:2},overlays:{textCrawl:item()}});listener({output:{sessionId:'server',revision:1},overlays:{}});assert.equal(seen.length,1);assert.equal(seen[0].text,crawl().payload.text);observer.destroy();});
test('Public/OBS accept same publisher revision when server composite advances',()=>{for(const outputMode of ['public','obs']){const controller=new PublicProgramController({outputMode});const base=program();assert.equal(controller.acceptSnapshotRevision({...base,output:{sessionId:'server',revision:1}}),true);assert.equal(controller.acceptSnapshotRevision({...base,output:{sessionId:'server',revision:2}}),true);assert.equal(controller.acceptSnapshotRevision({...base,output:{sessionId:'server',revision:1}}),false);}});
test('contract preserves safe timing metadata and rejects invalid timing/revision',()=>{const snapshot=program({overlays:{textCrawl:item()},output:{version:1,sessionId:'server',revision:1,overlayOnly:false}});assert.equal(validateProgramOutputSnapshot(snapshot).overlays.textCrawl.scheduled.startAt,stamp(0));assert.equal(validateProgramOutputSnapshot({...snapshot,output:{...snapshot.output,revision:0}}),null);assert.equal(validateProgramOutputSnapshot({...snapshot,overlays:{textCrawl:item({scheduled:{eventId:'a',startAt:stamp(10000),endAt:stamp(0)}})}}),null);});


test('publisher cannot forge server composite revision or scheduled timing',async t=>{const h=await harness(t);for(const patch of [{output:{version:1,sessionId:'fake',revision:999,overlayOnly:false}},{overlays:{textCrawl:item()}}]){const r=await fetch(h.base+'/api/program-output',{method:'POST',headers:{Authorization:'Bearer crawl-test-publisher','Content-Type':'application/json'},body:JSON.stringify(createProgramOutputEnvelope(program({revision:2,...patch})))});assert.equal(r.status,422);assert.equal(h.server.store.getCurrent().revision,1);}});
test('disabled future event stays hidden at its start',async t=>{const h=await harness(t);await h.write('POST','/events',crawl({enabled:false}));h.tick(1000);assert.equal(visible(h.current()),false);});
for(const outputMode of ['public','obs'])test(outputMode+' overlay-only revision never recreates or seeks Program media',()=>{
 const controller=new PublicProgramController({outputMode,now:()=>epoch+2000});let renders=0,seeks=0,overlays=0;
 const before=program();controller.current={snapshot:before};controller.renderSnapshot=()=>renders++;controller.reconcilePlayback=()=>seeks++;
 controller.renderGraphics=()=>{};controller.renderOverlays=()=>overlays++;controller.scheduleStaleState=()=>{};
 controller.handleSnapshot({...before,overlays:{textCrawl:item()},output:{version:1,sessionId:'server',revision:1,overlayOnly:false}},{livePublisher:true});
 controller.handleSnapshot({...before,overlays:{},output:{version:1,sessionId:'server',revision:2,overlayOnly:false}},{livePublisher:true});
 assert.equal(renders,0);assert.equal(seeks,0);assert.equal(overlays,2);
});
for(const editing of [false,true])test('Scheduler crawl '+(editing?'edit':'create')+' serializes supported fields through API',async t=>{
 const {default:UI}=await import('../public/js/ui/CrawlScheduleUI.js');const previous=globalThis.FormData;t.after(()=>{globalThis.FormData=previous;});
 const data=new Map(Object.entries({name:'Evening',text:'Plain <b>text</b>',startAt:'2026-09-12T20:00:00Z',endAt:'2026-09-12T20:10:00Z',priority:'5',position:'top',direction:'ltr',speed:'fast',enabled:'on',background:'on'}));
 globalThis.FormData=class{get(k){return data.get(k);}has(k){return data.has(k);}};
 let value,action,resets=0;const client={writable:true,create:async v=>{value=v;action='create';return{ok:true};},update:async(id,v)=>{assert.equal(id,'existing');value=v;action='update';return{ok:true};}};
 const ui=new UI({client});ui.form={reset(){resets++;}};ui.feedback={};ui.editId=editing?'existing':null;await ui.save();
 assert.equal(action,editing?'update':'create');assert.equal(value.name,'Evening');assert.equal(value.type,'overlay.crawl');assert.equal(value.payload.text,'Plain <b>text</b>');assert.equal(value.payload.direction,'ltr');assert.equal(value.payload.repeat,'continuous');assert.equal(value.enabled,true);assert.equal(value.endAt,'2026-09-12T20:10:00.000Z');assert.equal(resets,1);
});
test('Scheduler stale edit reports conflict and preserves draft without automatic retry',async()=>{
 const {default:UI}=await import('../public/js/ui/CrawlScheduleUI.js');const ui=new UI({client:{}});ui.feedback={};const r=await ui.mutate(Promise.resolve({ok:false,code:'REVISION_CONFLICT'}));assert.equal(r.ok,false);assert.match(ui.feedback.textContent,/SCHEDULE CHANGED/);
});
test('overlay-only restart snapshot cannot replace Control Program continuity identity',async t=>{
 const {default:Transport}=await import('../public/js/program-output/NetworkProgramOutputTransport.js');t.mock.timers.enable({apis:['setTimeout']});const stream=new EventTarget();stream.close=()=>{};
 const transport=new Transport({role:'publisher',subscribeUrl:'http://example.test/events',eventSourceFactory:()=>stream});const pending=transport.readRetained();
 stream.dispatchEvent(new MessageEvent('program',{data:JSON.stringify(createProgramOutputEnvelope(program({scene:null,source:null,output:{version:1,sessionId:'server',revision:1,overlayOnly:true}})))}));
 t.mock.timers.tick(2000);assert.equal(await pending,null);
});


test('late retained SSE supplies fresh server clock without changing output revision',async t=>{const h=await harness(t);await h.write('POST','/events',crawl());h.tick(1000);const revision=h.current().output.revision;h.tick(7000);const snapshot=await(await h.stream()).next();assert.equal(snapshot.output.serverTime,stamp(7000));assert.equal(snapshot.output.revision,revision);});
test('Public crawl phase corrects device clock skew using server receipt time',t=>{dom(t);const controller=new PublicProgramController({now:()=>epoch+900000});const layer=new Element();controller.getGraphicsLayer=()=>layer;controller.renderWaiting=()=>{};controller.scheduleStaleState=()=>{};controller.renderGraphics=()=>{};
 const snapshot=program({scene:null,source:null,overlays:{textCrawl:item()},output:{version:1,sessionId:'server',revision:1,overlayOnly:true,serverTime:stamp(5000)}});
 controller.handleSnapshot(snapshot,{livePublisher:true});assert.equal(layer.children[0].children[0].style.animationDelay,'-5s');controller.crawlView.destroy();
});

test('browser timer receiver contract holds for empty, active and destroyed crawl',t=>{
 dom(t);let starts=0,clears=0;
 function browserSetTimer(fn,ms){assert.equal(this,undefined,'Illegal invocation: timer receiver');starts++;return 1;}
 function browserClearTimer(id){assert.equal(this,undefined,'Illegal invocation: timer receiver');clears++;}
 const view=new TextCrawlView({now:()=>epoch+5000,setTimer:browserSetTimer,clearTimer:browserClearTimer});
 assert.equal(view.node(null),null);assert.ok(view.node(item()));view.destroy();
 assert.equal(starts,1);assert.equal(clears,3);
});
for(const kind of ['media','audio','hls','break'])test(kind+' complete merged fields validate and remain owned by publisher',async t=>{
 const h=await harness(t);let source={id:'source',kind,url:'https://example.test/media'};
 if(kind==='audio')source={id:'source',kind,audioUrl:'https://example.test/audio',motionUrl:'https://example.test/motion'};
 if(kind==='break')source={id:'source',kind,title:'BREAK',message:'Soon',logoUrl:'https://example.test/logo'};
 const base=program({revision:2,source,scene:{id:'scene',name:'Program',type:kind==='break'?'SLATE':'MEDIA'}});
 await h.publish(base);await h.write('POST','/events',crawl());h.tick(2000);
 const merged=h.current();assert.ok(validateProgramOutputSnapshot(merged));
 for(const field of ['scene','source','playback','committedAt','publisherSessionId','revision','graphics'])
 assert.deepEqual(merged[field],base[field],field);
});
for(const fault of ['invalid-payload','scheduler-throws'])test(fault+' never blocks accepted Program',async t=>{
 const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);
 h.server.scheduler.runtime.getSnapshot=()=>{if(fault==='scheduler-throws')throw Error('private details');
 return {activeEvents:[crawl({payload:{...crawl().payload,speed:'INVALID'}})]};};
 await h.publish(program({revision:2}));const snapshot=h.current();
 assert.ok(validateProgramOutputSnapshot(snapshot));assert.equal(snapshot.revision,2);
 assert.deepEqual(snapshot.source,program().source);assert.equal(visible(snapshot),false);
 assert.ok(h.server.effectiveOutput.diagnostics.snapshot().length<=100);
});
test('outward subscriber exception cannot reject an accepted publisher base',async t=>{
 const h=await harness(t);h.server.effectiveOutput.subscribe(()=>{throw Error('subscriber');});
 await h.publish(program({revision:2}));assert.equal(h.server.store.getCurrent().revision,2);
});
for(const outputMode of ['public','obs'])test(outputMode+' crawl rendering fault cannot escape into Program lifecycle',()=>{
 const controller=new PublicProgramController({outputMode});let cleared=0;
 controller.renderCrawlOverlay=()=>{throw Error('optional decoration');};
 controller.getGraphicsLayer=()=>({replaceChildren(){cleared++;}});
 assert.doesNotThrow(()=>controller.renderOverlays({textCrawl:item()}));assert.equal(cleared,1);
});
for(const outputMode of ['public','obs'])for(const kind of ['media','audio','hls'])test(outputMode+' '+kind+' start/end preserves active surface and transport',t=>{
 const controller=new PublicProgramController({outputMode,now:()=>epoch+2000});
 const before=program({source:kind==='audio'?{id:'source',kind,audioUrl:'https://example.test/audio'}:{id:'source',kind,url:'https://example.test/source'}});
 controller.current={snapshot:before};const surface=controller.current;let recreates=0,seeks=0;
 controller.renderSnapshot=()=>recreates++;controller.reconcilePlayback=()=>seeks++;
 controller.renderGraphics=()=>{};controller.renderOverlays=()=>{};controller.scheduleStaleState=()=>{};
 for(const [revision,overlays] of [[1,{textCrawl:item()}],[2,{}]])
 controller.handleSnapshot({...before,overlays,output:{version:1,sessionId:'server',revision,overlayOnly:false}},{livePublisher:true});
 assert.equal(controller.current,surface);assert.equal(recreates,0);assert.equal(seeks,0);
});

for(const outputMode of ['public','obs'])test(outputMode+' real preparation and overlay promotion accept HTTP merged Program',async t=>{
 const h=await harness(t);await h.write('POST','/events',crawl());h.tick(2000);
 const snapshot=await(await h.stream()).next();
 class Media extends EventTarget{
 constructor(tag){super();this.tag=tag;this.children=[];this.style={};this.dataset={};this.readyState=2;this.currentTime=0;this.duration=600;this.paused=true;}
 appendChild(child){child.parentNode=this;this.children.push(child);return child;}
 replaceChildren(...children){this.children=[];children.forEach(c=>this.appendChild(c));}
 querySelector(tag){return this.children.find(c=>c.tag===tag)||null;}
 setAttribute(){} removeAttribute(){}
 play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}load(){}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);}
 }
 const before=globalThis.document;globalThis.document={createElement:tag=>new Media(tag)};t.after(()=>{globalThis.document=before;});
 const controller=new PublicProgramController({outputMode,now:()=>epoch+2000});
 const baseRoot=new Media('div');controller.root={querySelector:()=>baseRoot};const overlayLayer=new Media('div');
 t.after(()=>{clearTimeout(controller.recoveryTimer);controller.crawlView?.destroy();controller.current?.cleanup();});
 controller.getGraphicsLayer=()=>overlayLayer;controller.renderGraphics=()=>{};
 await controller.renderSnapshot(snapshot);
 assert.equal(controller.current.snapshot.source.id,program().source.id);assert.equal(controller.current.layer.children[0].paused,false);
 assert.equal(overlayLayer.children[0].children[0].textContent,crawl().payload.text);
 controller.crawlView.destroy();controller.current.cleanup();
});

test('scheduler readiness reconciliation cannot duplicate unchanged raw Program delivery',async t=>{const h=await harness(t);let count=0;h.server.effectiveOutput.subscribe(()=>count++);h.server.effectiveOutput.reconcile();h.server.effectiveOutput.reconcile();assert.equal(count,0);await h.publish(program({revision:2}));assert.equal(count,1);h.server.effectiveOutput.reconcile();assert.equal(count,1);});
const sponsor=(patch={})=>({...crawl(),id:'sponsor-a',type:'overlay.sponsor',payload:{assetId:'asset-00000000-0000-4000-8000-000000000001',position:'top-right',sizePercent:12,opacity:0.8},...patch});
const logo={items:[{id:'channel',kind:'image',position:'top-left',url:'https://example.test/channel.png'}]};
for(const [name,events,graphics] of [
 ['sponsor only',[sponsor()],{items:[]}],['crawl only',[crawl()],{items:[]}],
 ['sponsor + crawl',[sponsor(),crawl()],{items:[]}],['channel logo + sponsor + crawl',[sponsor(),crawl()],logo]
])test('concurrency matrix: '+name,async t=>{
 const h=await harness(t);await h.publish(program({revision:2,graphics}));const base=h.server.store.getCurrent();
 for(const e of events)assert.equal((await h.write('POST','/events',e)).status,201);
 h.tick(2000);const s=h.current();assert.equal(!!s.overlays.sponsor?.enabled,events.some(e=>e.type==='overlay.sponsor'));
 assert.equal(visible(s),events.some(e=>e.type==='overlay.crawl'));assert.deepEqual(s.graphics,graphics);assert.deepEqual(h.server.store.getCurrent(),base);
 for(const key of ['scene','source','playback','revision','committedAt'])assert.deepEqual(s[key],base.snapshot[key]);
});
for(const first of ['sponsor','crawl'])test('concurrency matrix: '+first+' active, other starts and ends without resetting it',async t=>{
 const h=await harness(t);const early=first==='sponsor'?sponsor():crawl(),late=first==='sponsor'?crawl({startAt:stamp(3000),endAt:stamp(6000)}):sponsor({startAt:stamp(3000),endAt:stamp(6000)});
 for(const e of [early,late])await h.write('POST','/events',e);
 h.tick(2000);const key=first==='sponsor'?'sponsor':'textCrawl',before=h.current().overlays[key],base=h.server.store.getCurrent();
 h.tick(3000);assert.ok(h.current().overlays.sponsor.enabled&&visible(h.current()));assert.deepEqual(h.current().overlays[key],before);
 h.tick(6000);assert.deepEqual(h.current().overlays[key],before);assert.equal(!!h.current().overlays[first==='sponsor'?'textCrawl':'sponsor']?.enabled,false);
 assert.deepEqual(h.server.store.getCurrent(),base);
});
for(const phase of ['ENTRY','LOSS','BREAK'])test('concurrency matrix: '+phase+' and recovery of both deadlines',async t=>{
 const h=await harness(t);for(const e of [sponsor(),crawl()])await h.write('POST','/events',e);h.tick(2000);const before=h.current().overlays;
 const patch=phase==='LOSS'?{graphics:{items:[{id:AUTO_LIVE_LOSS_SLATE_ID,kind:'image',position:'top-left',url:'https://example.test/logo.png'}]}}:
 {scene:{id:phase==='ENTRY'?AUTO_LIVE_ENTRY_ID+'-session':'break',name:phase,type:'SLATE'},source:{id:phase==='ENTRY'?AUTO_LIVE_ENTRY_ID:'break',kind:'break',title:phase,message:phase,logoUrl:'https://example.test/logo.png'}};
 await h.publish(program({revision:2,...patch}));assert.equal(visible(h.current()),phase==='BREAK');assert.equal(h.current().overlays.sponsor.enabled,phase==='BREAK');
 h.tick(4000);await h.publish(program({revision:3}));assert.deepEqual(h.current().overlays,before);
 await h.publish(program({revision:4,...patch}));h.tick(10000);await h.publish(program({revision:5}));assert.equal(visible(h.current()),false);assert.equal(!!h.current().overlays.sponsor?.enabled,false);
});
for(const outputMode of ['public','obs'])test('concurrency matrix: '+outputMode+' matches Control; independent DOM, timers, Program and Preview',async t=>{
 const h=await harness(t);dom(t);await h.publish(program({revision:2,graphics:logo}));
 const control=new StudioGraphicsLayer({root:new Element(),consumer:'program',graphicsManager:{getVisibleGraphics:()=>[{graphic:{id:'channel',kind:'image',position:'top-left',asset:logo.items[0].url}}]}});
 const preview=new StudioGraphicsLayer({root:new Element(),consumer:'preview',graphicsManager:{getVisibleGraphics:()=>[]}});preview.render();const previewBefore=[...preview.root.children];
 const layers=new Map();const viewer=new PublicProgramController({outputMode,now:()=>h.clock.now});viewer.getGraphicsLayer=kind=>{if(!layers.has(kind))layers.set(kind,new Element());return layers.get(kind);};
 control.crawlView.now=()=>h.clock.now;control.sponsorView.now=()=>h.clock.now;
 t.after(()=>{control.crawlView.destroy();control.sponsorView.destroy();viewer.crawlView?.destroy();viewer.sponsorView?.destroy();});
 let receive;const observer=new ControlCrawlObserver({layer:control,transport:{subscribe:fn=>{receive=fn;return()=>{};},start(){},destroy(){}}});observer.start();
 viewer.current={snapshot:program({revision:2,graphics:logo})};const surface=viewer.current;
 viewer.renderGraphics=()=>{};viewer.scheduleStaleState=()=>{};
 viewer.renderSnapshot=()=>assert.fail('overlay changed Program surface');viewer.reconcilePlayback=()=>assert.fail('overlay changed playback');
 const render=()=>{const snapshot=h.current();receive({...snapshot,output:{...snapshot.output,serverTime:undefined}});viewer.handleSnapshot(snapshot,{livePublisher:true});assert.equal(viewer.current,surface);};
 await h.write('POST','/events',crawl());h.tick(2000);render();const cn=control.crawlView.element,vn=viewer.crawlView.element,phase=vn.children[0].style.animationDelay,ct=control.crawlView.timer;
 await h.write('POST','/events',sponsor());render();assert.equal(control.crawlView.element,cn);assert.equal(viewer.crawlView.element,vn);assert.equal(control.crawlView.timer,ct);assert.equal(vn.children[0].style.animationDelay,phase);
 const sn=control.sponsorView.element,vs=viewer.sponsorView.element,st=control.sponsorView.timer;
 assert.equal(sn.src,vs.src);assert.equal(sn.style.zIndex,'3');assert.equal(sn.style.right,'1.5%');assert.equal(control.root.children.length,3);
 await h.write('PATCH','/events/crawl-a',{enabled:false});render();assert.equal(control.sponsorView.element,sn);assert.equal(viewer.sponsorView.element,vs);assert.equal(control.sponsorView.timer,st);
 await h.write('PATCH','/events/crawl-a',{enabled:true});render();const restored=control.crawlView.element;await h.write('PATCH','/events/sponsor-a',{enabled:false});render();assert.equal(control.crawlView.element,restored);assert.equal(control.sponsorView.element,null);
 assert.deepEqual(preview.root.children,previewBefore);assert.deepEqual(h.server.store.getCurrent().snapshot,program({revision:2,graphics:logo}));observer.destroy();
});
test('missing sponsor asset does not suppress crawl or Program',async t=>{const h=await harness(t);await h.write('POST','/events',sponsor({payload:{...sponsor().payload,assetId:'missing'}}));await h.write('POST','/events',crawl());h.tick(2000);assert.equal(visible(h.current()),true);assert.equal(h.current().overlays.sponsor,undefined);});
