import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import ScheduleApiClient from '../public/js/scheduler/ScheduleApiClient.js';

// Real executable entrypoint, disk persistence, login, CSRF and HTTP stream.
// Node lacks the browser cookie jar: the bridge below supplies only its same-origin cookie.
// It does not fabricate API responses or send Authorization/query tokens to SSE.
test('production process supports browser cookie GET/SSE and editor save across restart', {timeout:30000}, async t=>{
 const dir=await mkdtemp(join(tmpdir(),'livezone-scheduler-production-'));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const base='http://127.0.0.1:'+port;
 const originalFetch=globalThis.fetch,originalLocation=globalThis.location;
 let child,client,cookie='',stream;
 const environment={...process.env,PORT:String(port),LIVEZONE_HTTP_HOST:'127.0.0.1',
  LIVEZONE_PROGRAM_OUTPUT_TOKEN:'isolated-test-publisher-value',LIVEZONE_OPERATOR_USERNAME:'scheduler-test',
  LIVEZONE_OPERATOR_PASSWORD:'isolated-test-password-value',LIVEZONE_OPERATOR_PASSWORD_SCRYPT:'',
  LIVEZONE_OPERATOR_AUTH_DISABLED:'false',LIVEZONE_OPERATOR_COOKIE_SECURE:'false',LIVEZONE_OPERATOR_ALLOWED_ORIGINS:'',
  LIVEZONE_SCHEDULE_PATH:join(dir,'schedule','schedule.json'),LIVEZONE_STUDIO_STATE_PATH:join(dir,'studio','state.json'),
  LIVEZONE_MEDIA_LIBRARY_ROOT:join(dir,'media')};
 async function stop(){client?.destroy();if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
 t.after(async()=>{await stop();globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;await rm(dir,{recursive:true,force:true});});
 async function start(){child=spawn(process.execPath,['server/program-output-server.js'],{env:environment,stdio:['ignore','pipe','pipe'],windowsHide:true});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout')),8000);child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited'));});child.stdout.on('data',data=>{if(String(data).includes('listening on')){clearTimeout(timer);resolve();}});});
 }
 async function login(){const r=await originalFetch(base+'/api/operator/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Livezone-Operator-Request':'1'},body:JSON.stringify({username:environment.LIVEZONE_OPERATOR_USERNAME,password:environment.LIVEZONE_OPERATOR_PASSWORD})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];}
 await start();
 for(const path of ['/api/studio/schedule','/api/studio/schedule/events'])assert.equal((await originalFetch(base+path)).status,401);
 await login();
 globalThis.location={href:base+'/control/schedule/',origin:base,pathname:'/control/schedule/',replace(){assert.fail('Unexpected login redirect');}};
 const urls=[];
 globalThis.fetch=(url,options={})=>{const target=new URL(url,base);assert.equal(target.origin,base);urls.push(target.pathname);const headers=new Headers(options.headers);headers.set('Cookie',cookie);if(options.method&&options.method!=='GET')headers.set('Origin',base);return originalFetch(target,{...options,headers});};
 class CookieEventSource extends EventTarget {
  constructor(url){super();this.abort=new AbortController();this.ready=this.connect(url);this.ready.catch(()=>{});}
  async connect(url){assert.equal(url,'/api/studio/schedule/events');assert.equal(new URL(url,base).search,'');
   const r=await originalFetch(base+url,{headers:{Cookie:cookie},signal:this.abort.signal});assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/event-stream/);
   this.reader=r.body.getReader();let buffer='';const first=await this.reader.read();buffer+=new TextDecoder().decode(first.value);
   assert.match(buffer,/event: schedule-state/);const line=buffer.split(String.fromCharCode(10)).find(l=>l.startsWith('data: '));
   this.dispatchEvent(new MessageEvent('schedule-state',{data:line.slice(6)}));
  }
  close(){this.abort.abort();}
 }
 client=new ScheduleApiClient({eventSourceFactory:url=>(stream=new CookieEventSource(url))});
 await client.start();await stream.ready;assert.equal(client.state.connection,'online');assert.equal(client.state.schedule.revision,0);assert.equal(client.writable,true);
 assert.ok(urls.includes('/api/studio/schedule'));assert.ok(urls.includes('/api/operator/session'));
 const plan={version:1,timezone:'Europe/Rome',items:[{id:'test-plan',title:'Operator title',startMode:'ABSOLUTE',behavior:'NORMAL',resumePolicy:'RESUME_SHIFT',start:'2026-09-14T12:00:00.000Z',durationSeconds:60,sceneId:'scene-a',transition:'CUT'}]};
 assert.equal((await client.saveProgramPlan(plan)).ok,true);assert.equal(client.state.schedule.revision,1);
 assert.equal(JSON.parse(await readFile(environment.LIVEZONE_SCHEDULE_PATH,'utf8')).programPlan.items[0].title,'Operator title');
 assert.equal(client.state.runtime.programPlan.execution,'SUSPENDED');
 await stop();await start();await login();
 const retained=await originalFetch(base+'/api/studio/schedule',{headers:{Cookie:cookie}});assert.equal(retained.status,200);
 const snapshot=await retained.json();assert.equal(snapshot.schedule.revision,1);assert.equal(snapshot.schedule.programPlan.items[0].title,'Operator title');
});
