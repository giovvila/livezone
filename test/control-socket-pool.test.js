import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ControlEventStream from '../public/js/core/ControlEventStream.js';
import ReferenceClient from '../public/js/studio/ReferenceClient.js';
import NetworkProgramOutputTransport from '../public/js/program-output/NetworkProgramOutputTransport.js';
import ControlCrawlObserver from '../public/js/program-output/ControlCrawlObserver.js';
import ScheduleApiClient from '../public/js/scheduler/ScheduleApiClient.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

const baseUrl = 'http://127.0.0.1:8080/control/';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const program = () => ({version:1, revision:1, publisherSessionId:'control-test',
    publishedAt:'2026-09-14T22:00:00.000Z', committedAt:'2026-09-14T22:00:00.000Z',
    scene:{id:'break',name:'BREAK',type:'SLATE'},
    source:{id:'break',kind:'break',title:'LIVEZONE',message:'Back soon',logoUrl:'https://example.test/logo.svg'},
    playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:'2026-09-14T22:00:00.000Z'},
    graphics:{items:[]},transition:{type:'cut',durationMs:0}});
const runtime = (generation = 1) => ({sessionId:'scheduler',generation,scheduleRevision:0,
    status:'READY',activeEvents:[],programPlan:{execution:'SUSPENDED'}});

class Source extends EventTarget {
    readyState = 0;
    closeCount = 0;
    close() { this.readyState = 2; this.closeCount++; }
    send(type, value) {
        if (type === 'open') this.readyState = 1;
        this.dispatchEvent(value === undefined ? new Event(type) : new MessageEvent(type,{data:JSON.stringify(value)}));
    }
}

function harness(t) {
    const sources = [], timers = new Map(), lifecycle = new EventTarget();
    let nextTimer = 0;
    const owner = new ControlEventStream({baseUrl, lifecycle,
        eventSourceFactory:url => {const source = new Source(); source.url = url; sources.push(source); return source;},
        setTimer:fn => {timers.set(++nextTimer, fn); return nextTimer;}, clearTimer:id => timers.delete(id)});
    t.after(() => owner.destroy());
    const presence = owner.presenceSource('/api/media-library/reference-presence?referenceClient=test&referenceGeneration=1');
    return {owner,presence,sources,timers,lifecycle,runRetry() {
        const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn());
    }};
}

test('production Control call sites inject the canonical channel into every persistent consumer', async () => {
    const entry = await readFile(new URL('../public/js/entries/control-room-app.js',import.meta.url),'utf8');
    assert.equal((entry.match(/new ControlEventStream\(/g)||[]).length,1);
    assert.match(entry,/new ReferenceClient\(\{role:'CONTROL',eventSourceFactory:controlEvents.presenceSource\}/);
    assert.match(entry,/createProgramOutputTransport\(\{ role: "publisher",\s*eventSourceFactory: controlEvents.eventSource/);
    assert.match(entry,/new NetworkProgramOutputTransport\(\{role:'subscriber',[\s\S]*?eventSourceFactory:controlEvents.eventSource/);
    assert.match(entry,/new ScheduleApiClient\(\{eventSourceFactory:controlEvents.eventSource\}/);
    assert.match(entry,/'pagehide', destroyControlRoom/);
    assert.match(entry,/if \(event.persisted\) globalThis.location.reload\(\)/);
});

test('real Control consumers, including retained bootstrap, own exactly one physical EventSource', async t => {
    const h = harness(t); h.presence.close();
    const reference = new ReferenceClient({role:'CONTROL',storage:null,eventSourceFactory:h.owner.presenceSource,
        request:async () => ({ok:true,json:async()=>({ok:true,client:{clientId:'test',generation:1}})})});
    await reference.initialize();
    const publisher = new NetworkProgramOutputTransport({role:'publisher',baseUrl,
        subscribeUrl:'/api/program-output/events',tokenProvider:()=> 'test-token',eventSourceFactory:h.owner.eventSource});
    const retained = publisher.readRetained();
    const source = h.sources.at(-1);
    source.send('open'); source.send('program',createProgramOutputEnvelope(program()));
    assert.deepEqual(await retained,program());
    publisher.start();
    const overlays = [];
    const observer = new ControlCrawlObserver({layer:{setEffectiveOverlays:value=>overlays.push(value)},
        transport:new NetworkProgramOutputTransport({role:'subscriber',baseUrl,subscribeUrl:'/api/program-output/events',eventSourceFactory:h.owner.eventSource})});
    observer.start(); observer.start();
    const schedule = new ScheduleApiClient({eventSourceFactory:h.owner.eventSource,
        request:async()=>({ok:true,json:async()=>({schedule:{revision:0,events:[]},runtime:runtime()})})});
    await schedule.start(); await flush();
    source.send('schedule-state',runtime(2));
    assert.equal(h.sources.filter(s=>s.readyState!==2).length,1);
    assert.equal(h.owner.leases.size,4);
    assert.equal(overlays.length,1,'retained overlay reaches a late consumer exactly once');
    assert.equal(schedule.state.runtime.generation,2);
    assert.equal(schedule.state.runtime.programPlan.execution,'SUSPENDED');
    observer.destroy(); publisher.destroy(); schedule.destroy();
    assert.equal(source.readyState,1,'reference presence still owns the channel');
    await reference.close(); assert.equal(source.readyState,2);
});

test('native reconnect is shared; CLOSED replacement has one timer and ignores zombie events', async t => {
    const h = harness(t), a = h.owner.eventSource('/api/program-output/events'), b = h.owner.eventSource('/api/studio/schedule/events');
    let seen = 0; a.addEventListener('program',()=>seen++);
    const old = h.sources[0]; old.send('open'); old.readyState = 0; old.send('error');
    assert.equal(h.sources.length,1); assert.equal(h.timers.size,0);
    old.send('open'); old.readyState = 2; old.send('error'); old.send('error');
    assert.equal(a.readyState,0); assert.equal(b.readyState,0); assert.equal(h.timers.size,1);
    h.runRetry(); assert.equal(h.sources.length,2); assert.equal(old.closeCount,1);
    old.send('program',{}); assert.equal(seen,0);
    h.sources[1].send('open'); h.sources[1].send('program',{}); assert.equal(seen,1);
    a.close(); b.close(); h.presence.close(); assert.equal(h.sources[1].closeCount,1);
});

test('publisher reconnect replays latest publication through shared monitor without another SSE', async t => {
    const h = harness(t); let writes = 0;
    const publisher = new NetworkProgramOutputTransport({role:'publisher',baseUrl,publishUrl:'/api/program-output',
        subscribeUrl:'/api/program-output/events',tokenProvider:()=> 'test-token',eventSourceFactory:h.owner.eventSource,
        fetchImplementation:async()=>{writes++;return {ok:true,status:202};}});
    t.after(()=>publisher.destroy()); publisher.start(); h.sources[0].send('open');
    publisher.publish(program()); await flush(); assert.equal(writes,1);
    h.sources[0].readyState=0;h.sources[0].send('error');h.sources[0].send('open');await flush();
    assert.equal(writes,2);assert.equal(h.sources.length,1);
});

test('pagehide closes all leases and retry; pageshow cannot resurrect a destroyed document', t => {
    const h = harness(t);h.owner.eventSource('/api/program-output/events');
    h.sources[0].readyState=2;h.sources[0].send('error');
    h.lifecycle.dispatchEvent(new Event('pagehide'));h.lifecycle.dispatchEvent(new Event('pageshow'));h.runRetry();
    assert.equal(h.owner.leases.size,0);assert.equal(h.timers.size,0);assert.equal(h.sources.length,1);
    assert.throws(()=>h.owner.eventSource('/api/program-output/events'),/unavailable/);
});

test('last lease release and component recreation reopens only one connection', t => {
    const h = harness(t);h.presence.close();
    const a=h.owner.eventSource('/api/program-output/events'),b=h.owner.eventSource('/api/program-output/events');
    assert.equal(h.sources.length,2);a.close();assert.equal(h.sources[1].closeCount,0);b.close();
    assert.equal(h.sources[1].closeCount,1);assert.equal(h.owner.leases.size,0);
});

test('late retained replay is cancelled when a lease closes or a newer revision arrives', async t => {
    const h=harness(t);h.sources[0].send('program',{revision:1});
    const a=h.owner.eventSource('/api/program-output/events'),received=[];
    a.addEventListener('program',e=>received.push(JSON.parse(e.data).revision));
    h.sources[0].send('program',{revision:2});await flush();assert.deepEqual(received,[2]);
    const b=h.owner.eventSource('/api/program-output/events');b.addEventListener('program',()=>assert.fail('closed replay'));b.close();await flush();
});

test('destroy before publisher.start cancels retained bootstrap lease and resolves pending read', async t => {
    const h=harness(t),publisher=new NetworkProgramOutputTransport({role:'publisher',baseUrl,
        subscribeUrl:'/api/program-output/events',eventSourceFactory:h.owner.eventSource});
    const retained=publisher.readRetained();assert.equal(h.owner.leases.size,2);publisher.destroy();
    assert.equal(await retained,null);assert.equal(h.owner.leases.size,1);
});

test('schedule destroy/restart during pending GET cannot open a zombie stream', async t => {
    const h=harness(t);let resolveFirst,calls=0;
    const response={ok:true,json:async()=>({schedule:{revision:0,events:[]},runtime:runtime()})};
    const client=new ScheduleApiClient({eventSourceFactory:h.owner.eventSource,
        request:()=>++calls===1?new Promise(resolve=>resolveFirst=resolve):Promise.resolve(response)});
    const first=client.start();client.destroy();await client.start();resolveFirst(response);await first;
    assert.equal(h.owner.leases.size,2);client.destroy();assert.equal(h.owner.leases.size,1);
});

test('Public and OBS retain independent EventSources and work without a Control owner', t => {
    const sources=[];
    for(const name of ['Public','OBS']) {
        const transport=new NetworkProgramOutputTransport({role:'subscriber',baseUrl,subscribeUrl:'/api/program-output/events',
            eventSourceFactory:()=>{const source=new Source();sources.push(source);return source;}});
        t.after(()=>transport.destroy());let seen=0;transport.subscribe(()=>seen++);transport.start();
        sources.at(-1).send('program',createProgramOutputEnvelope(program()));assert.equal(seen,1,name);
    }
    assert.equal(sources.length,2);
});

test('shared stream rejects a different authority instead of silently consuming local revisions', t => {
    const h=harness(t);
    assert.throws(()=>h.owner.eventSource('https://other.test/api/program-output/events'),/canonical same-origin/);
    assert.equal(h.sources.length,1);
});

test('late scheduler subscriber observes a disconnected channel instead of retaining writable GET state', async t => {
    const h=harness(t);h.sources[0].send('open');h.sources[0].readyState=0;h.sources[0].send('error');
    const schedule=new ScheduleApiClient({eventSourceFactory:h.owner.eventSource,
        request:async()=>({ok:true,json:async()=>({schedule:{revision:0,events:[]},runtime:runtime()})})});
    await schedule.start();await flush();assert.equal(schedule.writable,false);schedule.destroy();
});
