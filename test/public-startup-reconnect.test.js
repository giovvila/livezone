import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import {createProgramOutputTransport} from '../public/js/program-output/ProgramOutputTransportFactory.js';
import {bootstrapPublicProgram,maintainPublicPage} from '../public/js/public/PublicProgramBootstrap.js';
import PublicProgramController from '../public/js/public/PublicProgramController.js';
import NetworkProgramOutputTransport from '../public/js/program-output/NetworkProgramOutputTransport.js';
import ControlCrawlObserver from '../public/js/program-output/ControlCrawlObserver.js';

const settle=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.ok(predicate(),'state did not converge');};
// Real HTTP SSE reader, exposing EventSource's native reconnect/terminal states.
class Stream extends EventTarget {
    constructor(url){super();this.url=url;this.readyState=0;this.open();}
    async open(){this.abort=new AbortController();try{const response=await fetch(this.url,{signal:this.abort.signal});assert.equal(response.status,200);this.readyState=1;this.dispatchEvent(new Event('open'));let buffer='';const reader=response.body.getReader();while(true){const r=await reader.read();if(r.done)break;buffer+=new TextDecoder().decode(r.value);let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(block.includes('event: program')){const e=new Event('program');e.data=block.split('\n').find(x=>x.startsWith('data: ')).slice(6);this.dispatchEvent(e);}}}}catch(e){if(e.name!=='AbortError'){this.readyState=2;this.dispatchEvent(new Event('error'));}}}
    close(){this.readyState=2;this.abort.abort();}
}
async function fixture(t,outputMode='public'){
    const asset={id:'asset-00000000-0000-4000-8000-000000000001',kind:'image',url:'/media-library/files/image/fixture.png'};
    const owner=createProgramOutputServer({operatorAuth:new OperatorAuth({disabled:true}),publisherToken:'public-startup-fixture-only',mediaAssetRepository:{initialize:async()=>{},list:()=>[asset],get:id=>id===asset.id?asset:null}});
    await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));await owner.scheduler.ready;
    const origin='http://127.0.0.1:'+owner.server.address().port;
    const dom=new JSDOM('<div id="root"><div data-public-base></div><div data-public-graphics></div></div><p id="status"></p>',{url:origin});const prior=globalThis.document;globalThis.document=dom.window.document;
    const proto=dom.window.HTMLMediaElement.prototype;Object.defineProperty(proto,'readyState',{get:()=>2});Object.defineProperty(proto,'duration',{get:()=>600});Object.defineProperty(proto,'currentTime',{get(){return this.cue||0;},set(v){this.cue=v;queueMicrotask(()=>this.dispatchEvent(new dom.window.Event('seeked')));}});proto.load=()=>{};proto.pause=()=>{};proto.play=()=>Promise.resolve();proto.canPlayType=()=> 'probably';
    const streams=[];let controller,stopBoot;
    const start=()=>{stopBoot=bootstrapPublicProgram({retryMs:10,createTransport:configSignal=>createProgramOutputTransport({role:'subscriber',configSignal,configUrl:origin+'/config/program-output.json',baseUrl:origin,eventSourceFactory:url=>{const stream=new Stream(url);streams.push(stream);return stream;}}),onConnected:transport=>{transport.retryDelays=[10];controller=new PublicProgramController({root:document.querySelector('#root'),status:document.querySelector('#status'),transport,outputMode});controller.start();}});};
    const stop=()=>{stopBoot?.();controller?.destroy();controller=null;};
    t.after(async()=>{stop();streams.forEach(s=>s.close());owner.server.closeAllConnections();await new Promise(r=>owner.server.close(r));dom.window.close();globalThis.document=prior;});
    const publish=(kind='media',revision=1,session='fixture',overlays={})=>{const at=new Date().toISOString();const source=kind==='break'?{id:kind,kind,title:'Break',message:'Waiting',logoUrl:'https://example.test/logo.png'}:kind==='audio'?{id:kind,kind,audioUrl:'https://example.test/audio.mp3'}:{id:kind,kind,url:'https://example.test/video.mp4'};const snapshot={version:1,revision,publisherSessionId:session,publishedAt:at,committedAt:at,scene:{id:kind,name:kind,type:kind==='break'?'SLATE':'MEDIA'},source,playback:{initialTime:0,duration:600,playing:true,ended:false,state:'playing',startedAt:at},graphics:{items:[]},overlays,transition:{type:'cut',durationMs:0}};const envelope=createProgramOutputEnvelope(snapshot);assert.ok(envelope);return {snapshot,envelope,result:owner.store.accept(envelope)};};
    return {owner,origin,dom,streams,start,stop,publish,asset,get controller(){return controller;}};
}

test('Control output monitor and overlay observer stay idle as Public and OBS join (10 seconds per phase)', async t => {
    const h = await fixture(t);
    const seed = h.publish('break');
    let attempts = 0, overlayUpdates = 0, obsSnapshots = 0;
    const streamFactory = url => { const stream = new Stream(url); h.streams.push(stream); return stream; };
    const subscriber = () => new NetworkProgramOutputTransport({role:'subscriber',
        subscribeUrl:h.origin+'/api/program-output/events',eventSourceFactory:streamFactory});
    // Actual server SSE and production transports. Publication ingress is replaced
    // with the store boundary: this fixture does not register an operator writer.
    const publisher = new NetworkProgramOutputTransport({role:'publisher',
        publishUrl:h.origin+'/api/program-output',subscribeUrl:h.origin+'/api/program-output/events',
        tokenProvider:()=> 'isolated-fixture-only',eventSourceFactory:streamFactory,
        fetchImplementation:async (_url,options)=>{
            attempts++;
            const result=h.owner.store.accept(JSON.parse(options.body));
            assert.equal(result.accepted,true);
            return {ok:true,status:202};
        }});
    const observer = new ControlCrawlObserver({transport:subscriber(),
        layer:{setEffectiveOverlays(){overlayUpdates++;}}});
    const obs = subscriber();
    t.after(()=>{obs.destroy();observer.destroy();publisher.destroy();});
    publisher.start(); observer.start();
    publisher.publish({...seed.snapshot,revision:2}); await publisher.publishQueue;
    await settle(()=>h.streams.length===2&&h.streams.every(s=>s.readyState===1)&&overlayUpdates>0);
    const stableOverlayUpdates=overlayUpdates;
    for(const phase of ['Control output transports','+ Public','+ OBS transport']){
        if(phase==='+ Public'){h.start();await settle(()=>h.controller?.current);}
        if(phase==='+ OBS transport'){obs.subscribe(()=>obsSnapshots++);obs.start();await settle(()=>obsSnapshots===1);}
        await new Promise(resolve=>setTimeout(resolve,10000));
        assert.equal(attempts,1,phase+' must not cause publication churn');
        assert.equal(overlayUpdates,stableOverlayUpdates,phase+' must not rebroadcast overlays');
        assert.equal(h.owner.store.getCurrent().revision,2);
        t.diagnostic(phase+': 0 additional publications in 10 seconds');
    }
    assert.equal(h.streams.length,4,'two Control output streams, one Public, one OBS');
});
test('GET HTML/config then connected SSE with no retained Program waits and first delayed publication recovers',async t=>{const h=await fixture(t);assert.equal((await fetch(h.origin+'/')).status,200);h.start();await settle(()=>h.streams[0]?.readyState===1);assert.match(document.querySelector('[data-public-base]').textContent,/WAITING/);assert.equal(h.controller.current,null);h.publish();await settle(()=>h.controller.current?.snapshot.source.kind==='media');});
for(const mode of ['public','obs'])for(const kind of ['media','audio','hls','break'])test(mode+' late join renders retained '+kind,async t=>{const h=await fixture(t,mode);h.publish(kind);h.start();await settle(()=>h.controller?.current?.snapshot.source.kind===kind);assert.equal(h.controller.pendingRender,null);});
test('BFCache pagehide/pageshow reconnects and renders new retained Program without refresh',async t=>{const h=await fixture(t);h.publish();const dispose=maintainPublicPage({start:h.start,stop:h.stop,eventTarget:h.dom.window});t.after(dispose);await settle(()=>h.controller?.current);h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide',{persisted:true}));assert.equal(h.controller,null);h.publish('audio',2);h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow',{persisted:true}));await settle(()=>h.controller?.current?.snapshot.source.kind==='audio');assert.equal(h.streams.length,2);h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow',{persisted:true}));assert.equal(h.streams.length,2);});
test('terminal SSE closure reconnects to retained snapshot, native CONNECTING does not duplicate streams',async t=>{const h=await fixture(t);h.publish();h.start();await settle(()=>h.controller?.current);const stream=h.streams[0];stream.readyState=0;stream.dispatchEvent(new Event('error'));await new Promise(r=>setTimeout(r,25));assert.equal(h.streams.length,1);stream.close();stream.dispatchEvent(new Event('error'));await settle(()=>h.streams.length===2&&h.streams[1].readyState===1);h.publish('audio',2);await settle(()=>h.controller.current.snapshot.source.kind==='audio');});
test('fresh server after restart has no retained base, delayed new publisher restores Public',async t=>{const h=await fixture(t);assert.equal(h.owner.store.getCurrent(),null);h.start();await settle(()=>h.streams[0]?.readyState===1);h.publish('break',1,'new-process-publisher');await settle(()=>h.controller.current?.snapshot.source.kind==='break');});
test('stale revision ignored and newer accepted on live transport',async t=>{const h=await fixture(t);h.publish('media',2);h.start();await settle(()=>h.controller?.current);const current=h.controller.current;const old=h.publish('audio',1);assert.equal(old.result.accepted,false);h.controller.transport.handleProgram({data:JSON.stringify(old.envelope)});assert.equal(h.controller.current,current);h.publish('audio',3);await settle(()=>h.controller.current.snapshot.source.kind==='audio');});
test('initial renderer failure shows safe state and retries without a newer revision',async t=>{const h=await fixture(t);h.start();await settle(()=>h.controller);const create=h.controller.createSource.bind(h.controller);let attempts=0;h.controller.createSource=(...args)=>++attempts===1?Promise.reject(Error('temporary media unavailable')):create(...args);h.publish();await settle(()=>attempts===1);assert.match(document.querySelector('[data-public-base]').textContent,/UNAVAILABLE/);await settle(()=>h.controller.current);assert.equal(attempts,2);});
for(const present of [false,true])test('crawl '+(present?'present':'absent')+' does not change startup recovery',async t=>{const h=await fixture(t);h.publish('break',1,'fixture',present?{textCrawl:{enabled:true,mode:'crawl',text:'News',position:'bottom',direction:'rtl',speed:'medium',background:true}}:{});h.start();await settle(()=>h.controller?.current);assert.equal(!!document.querySelector('.public-text-crawl'),present);});
test('bootstrap disposes failed transport before retrying asynchronous controller initialization',async()=>{let attempts=0,destroyed=0,connected=false;const stop=bootstrapPublicProgram({retryMs:1,createTransport:async()=>({destroy(){destroyed++;}}),onConnected:async()=>{if(++attempts===1)throw Error('initial start failure');connected=true;}});try{await settle(()=>connected);assert.equal(destroyed,1);assert.equal(attempts,2);}finally{stop();}});

for(const layout of ['CORNER','FULLSCREEN'])test('late join with scheduled '+layout+' Sponsor and crawl uses ordinary startup',async t=>{const h=await fixture(t);h.publish('break',1,'fixture',{textCrawl:{enabled:true,mode:'crawl',text:'News',position:'bottom',direction:'rtl',speed:'medium',background:true}});const result=await h.owner.scheduler.store.insert({id:'sponsor',version:1,type:'overlay.sponsor',enabled:true,startAt:new Date(Date.now()-1000).toISOString(),endAt:new Date(Date.now()+60000).toISOString(),priority:1,payload:{assetId:h.asset.id,layout,...(layout==='CORNER'?{position:'top-right',sizePercent:12}:{fit:'CONTAIN'}),opacity:1}},0);assert.equal(result.ok,true);h.start();await settle(()=>h.controller?.current&&document.querySelector('.scheduled-sponsor'));assert.ok(document.querySelector('.public-text-crawl'));});
test('terminal reconnect retries when replacement EventSource constructor temporarily throws',async t=>{const h=await fixture(t);h.publish();h.start();await settle(()=>h.controller?.current);const transport=h.controller.transport,make=transport.eventSourceFactory;let attempts=0;transport.eventSourceFactory=url=>{if(++attempts===1)throw Error('temporary connection creation failure');return make(url);};h.streams[0].close();h.streams[0].dispatchEvent(new Event('error'));await settle(()=>h.streams.length===2&&h.streams[1].readyState===1);assert.equal(attempts,2);});
