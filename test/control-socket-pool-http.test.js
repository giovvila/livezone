import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

const token='socket-pool-test-publisher';
const capabilities=['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'];
const snapshot={version:1,revision:1,publisherSessionId:'socket-test',publishedAt:'2026-09-14T22:00:00.000Z',
    committedAt:'2026-09-14T22:00:00.000Z',scene:{id:'break',name:'BREAK',type:'SLATE'},
    source:{id:'break',kind:'break',title:'LIVEZONE',message:'Back soon',logoUrl:'https://example.test/logo.svg'},
    playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:'2026-09-14T22:00:00.000Z'},
    graphics:{items:[]},transition:{type:'cut',durationMs:0}};

async function fixture(t) {
    const root=await mkdtemp(join(tmpdir(),'lz-socket-pool-'));
    const mediaPath=join(root,'capacity.bin'),file=await open(mediaPath,'w');
    await file.truncate(32*1024*1024);await file.close();
    // Only test-owned data is served; the byte content is irrelevant to socket allocation.
    const assets=[{id:'asset-00000000-0000-4000-8000-000000000001',kind:'video',storedName:'capacity.mp4',mimeType:'video/mp4'},
        {id:'asset-00000000-0000-4000-8000-000000000002',kind:'audio',storedName:'capacity.mp3',mimeType:'audio/mpeg'}];
    const make=()=>createProgramOutputServer({publisherToken:token,operatorAuth:new OperatorAuth({disabled:true}),
        studioStatePath:join(root,'studio.json'),schedulePath:join(root,'schedule.json'),
        mediaAssetRepository:{initialize:async()=>{},safeFilePath:()=>mediaPath,list:({kind}={})=>assets.filter(a=>!kind||a.kind===kind),get:()=>null}});
    let owner=make();
    await new Promise(resolve=>owner.server.listen(0,'127.0.0.1',resolve));await owner.scheduler.ready;
    owner.store.accept(createProgramOutputEnvelope(snapshot));
    let origin='http://127.0.0.1:'+owner.server.address().port;
    const agent=new http.Agent({keepAlive:true,maxSockets:6}),obsAgent=new http.Agent({keepAlive:true,maxSockets:6});
    const responses=[];
    const request=(path,{method='GET',body,headers={},pool=agent}={})=>new Promise((resolve,reject)=>{
        const payload=body===undefined?null:JSON.stringify(body);
        const req=http.request(origin+path,{agent:pool,method,headers:{...headers,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
            responses.push(res);resolve(res);
        });
        req.on('error',reject);req.end(payload);
    });
    const json=async(path,options)=>{
        const res=await request(path,options);let data='';for await(const chunk of res)data+=chunk;
        return {status:res.statusCode,body:JSON.parse(data)};
    };
    const registration=await json('/api/media-library/reference-clients',{method:'POST',body:{role:'CONTROL',version:3,capabilities}});
    assert.equal(registration.status,201);
    const identity=registration.body.client;
    const query=`referenceClient=${identity.clientId}&referenceGeneration=${identity.generation}`;
    const headers={'X-Livezone-Reference-Client':identity.clientId,'X-Livezone-Reference-Generation':String(identity.generation)};
    t.after(async()=>{
        // Drain bounded media; close SSE explicitly. No production media or services are touched.
        await Promise.all(responses.map(res=>{
            if(res.destroyed||res.complete)return;
            if(res.headers['content-type']?.includes('event-stream')){res.destroy();return;}
            return new Promise(resolve=>{res.on('end',resolve);res.on('close',resolve);res.on('error',resolve);res.resume();});
        }));
        agent.destroy();obsAgent.destroy();owner.server.closeAllConnections();
        await new Promise(resolve=>owner.server.close(resolve));await rm(root,{recursive:true,force:true});
    });
    const media=async(pool=agent,kind='video')=>{
        const res=await request(`/media-library/files/${kind}/capacity.${kind==='audio'?'mp3':'mp4'}`,{pool,headers:{Range:'bytes=0-'}});
        assert.equal(res.statusCode,206);assert.equal(res.complete,false);return res;
    };
    return {get owner(){return owner;},request,json,agent,obsAgent,identity,query,headers,media,
        async restart(){
            for(const response of responses)response.destroy();agent.destroy();obsAgent.destroy();
            owner.server.closeAllConnections();await new Promise(resolve=>owner.server.close(resolve));
            owner=make();await new Promise(resolve=>owner.server.listen(0,'127.0.0.1',resolve));await owner.scheduler.ready;
            origin='http://127.0.0.1:'+owner.server.address().port;
        }};
}

function events(response) {
    let buffer='';const queue=[],waiters=[];
    response.on('data',chunk=>{
        buffer+=chunk;let boundary;
        while((boundary=buffer.indexOf('\n\n'))>=0){
            const packet=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const type=packet.split('\n').find(line=>line.startsWith('event: '))?.slice(7);
            const data=packet.split('\n').find(line=>line.startsWith('data: '))?.slice(6);
            if(!type||!data)continue;
            const entry={type,value:JSON.parse(data)},index=waiters.findIndex(w=>w.type===type);
            if(index<0)queue.push(entry);else waiters.splice(index,1)[0].resolve(entry.value);
        }
    });
    return {next(type){const index=queue.findIndex(e=>e.type===type);
        return index<0?new Promise(resolve=>waiters.push({type,resolve})):Promise.resolve(queue.splice(index,1)[0].value);}};
}

for(const name of ['VIDEO','AUDIO','VIDEO + Preview VIDEO'])test(`HTTP/1.1 budget: Control ${name}, Public media and API progress with six slots`,{timeout:15000},async t=>{
    const h=await fixture(t);
    const control=await h.request('/api/media-library/reference-presence?'+h.query+'&controlEvents=1');
    assert.equal(control.statusCode,200);const feed=events(control);
    assert.equal((await feed.next('presence')).state,'CURRENT_CAPABLE');
    assert.deepEqual((await feed.next('program')).snapshot,snapshot);
    assert.equal((await feed.next('schedule-state')).programPlan.execution,'SUSPENDED');
    await h.media(h.agent,name==='AUDIO'?'audio':'video');if(name.includes('Preview'))await h.media();
    const publicResponse=await h.request('/api/program-output/events');
    assert.deepEqual((await events(publicResponse).next('program')).snapshot,snapshot);
    await h.media();
    const mutation=await h.json('/api/media-library/reference-clients/'+h.identity.clientId,
        {method:'PUT',headers:h.headers,body:{generation:h.identity.generation,catalog:'INVALID'}});
    assert.equal(mutation.status,200,'mutation must obtain the spare slot');
    assert.equal(h.owner.referenceClients.snapshot().state,'INCOMPLETE','UNKNOWN is never made deletable');
    assert.equal(Object.values(h.agent.requests).flat().length,0,'no queued HTTP requests');
    assert.equal(Object.values(h.agent.sockets).flat().length,name.includes('Preview')?5:4);
    // OBS has its own Chromium network context/process, not an extra Edge tab.
    const obs=await h.request('/api/program-output/events',{pool:h.obsAgent});
    assert.deepEqual((await events(obs).next('program')).snapshot,snapshot);await h.media(h.obsAgent);
    assert.equal(Object.values(h.obsAgent.requests).flat().length,0);
});

test('multiplexed Control gets live authoritative schedule/overlay revisions and retained reconnect',{timeout:15000},async t=>{
    const h=await fixture(t);
    const response=await h.request('/api/media-library/reference-presence?'+h.query+'&controlEvents=1');
    const feed=events(response);await feed.next('presence');await feed.next('program');await feed.next('schedule-state');
    const now=Date.now();const value={id:'socket-crawl',version:1,type:'overlay.crawl',name:'Socket test',enabled:true,
        startAt:new Date(now-1000).toISOString(),endAt:new Date(now+60000).toISOString(),priority:1,
        payload:{text:'Authoritative crawl',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}};
    const result=await h.json('/api/studio/schedule/events',{method:'POST',headers:{...h.headers,'If-Match':'"schedule-0"'},body:value});
    assert.equal(result.status,201,JSON.stringify(result.body));
    const state=await feed.next('schedule-state');assert.equal(state.scheduleRevision,1);
    assert.equal(state.programPlan.execution,'SUSPENDED');
    const program=await feed.next('program');assert.equal(program.snapshot.overlays.textCrawl.text,value.payload.text);
    assert.deepEqual(program.snapshot.playback,snapshot.playback);
    assert.deepEqual(h.owner.store.getCurrent().snapshot,snapshot,'transport must not become publisher authority');
    response.destroy();
    const reconnect=events(await h.request('/api/media-library/reference-presence?'+h.query+'&controlEvents=1'));
    const replay=await reconnect.next('program');
    assert.equal(replay.snapshot.output.revision,program.snapshot.output.revision);
    assert.deepEqual(replay.snapshot.overlays,program.snapshot.overlays);
    assert.deepEqual(replay.snapshot.playback,program.snapshot.playback);
    assert.equal((await reconnect.next('schedule-state')).scheduleRevision,1);
});

test('multiplex opt-in cannot bypass reference capability; disconnect remains fail-closed',{timeout:15000},async t=>{
    const h=await fixture(t);
    const rejected=await h.json('/api/media-library/reference-presence?controlEvents=1');assert.equal(rejected.status,409);
    const response=await h.request('/api/media-library/reference-presence?'+h.query+'&controlEvents=1');
    await events(response).next('presence');response.destroy();
    // Wait for the server's serialized close callback, with a finite deadline.
    for(let n=0;n<100&&h.owner.referenceClients.clients.get(h.identity.clientId).confirmed;n++)
        await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(h.owner.referenceClients.clients.get(h.identity.clientId).confirmed,false);
    assert.equal(h.owner.referenceClients.snapshot().state,'INCOMPLETE');
});

test('legacy reference-presence remains presence-only and does not subscribe to output',{timeout:15000},async t=>{
    const h=await fixture(t),response=await h.request('/api/media-library/reference-presence?'+h.query);
    const first=await new Promise(resolve=>response.once('data',resolve));
    assert.match(first.toString(),/event: presence/);assert.doesNotMatch(first.toString(),/event: program|event: schedule-state/);
});

test('real server restart restores the Program channel without falsely confirming the reference epoch',{timeout:15000},async t=>{
    const h=await fixture(t);await h.restart();
    assert.equal(h.owner.referenceClients.epochConfirmed,false);
    const stream=events(await h.request('/api/media-library/reference-presence?'+h.query+'&controlEvents=1'));
    assert.equal((await stream.next('presence')).state,'UNKNOWN');
    assert.equal((await stream.next('schedule-state')).programPlan.execution,'SUSPENDED');
    const publication=await h.json('/api/program-output',{method:'POST',headers:{...h.headers,Authorization:'Bearer '+token},
        body:createProgramOutputEnvelope(snapshot)});
    assert.equal(publication.status,202);assert.deepEqual((await stream.next('program')).snapshot,snapshot);
    assert.equal(h.owner.referenceClients.epochConfirmed,false);
    assert.equal(h.owner.referenceClients.snapshot().state,'INCOMPLETE');
    const reopened=await h.json('/api/media-library/reference-clients',{method:'POST',body:{role:'CONTROL',version:3,capabilities,
        resumeId:h.identity.clientId,resumeGeneration:h.identity.generation,resumeToken:h.identity.resumeToken}});
    assert.equal(reopened.status,201);const identity=reopened.body.client;
    const replacement=events(await h.request(`/api/media-library/reference-presence?referenceClient=${identity.clientId}&referenceGeneration=${identity.generation}&controlEvents=1`));
    assert.equal((await replacement.next('presence')).state,'CURRENT_CAPABLE');
    assert.equal(h.owner.referenceClients.epochConfirmed,true);
    assert.equal(h.owner.referenceClients.snapshot().state,'INCOMPLETE','catalog/legacy confirmation is still required');
});
