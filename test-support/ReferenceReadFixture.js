import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
// Reuse the already installed observer before importing production bindings.
import {observer} from './PureScheduleReadFixture.js';
const {default:Registry}=await import('../server/media-library/ReferenceClientRegistry.js');
const {default:Coordinator}=await import('../server/media-library/AssetMutationCoordinator.js');
const {default:MediaRoutes}=await import('../server/media-library/MediaLibraryRoutes.js');
const {default:StudioRoutes}=await import('../server/studio/StudioStateRoutes.js');
const {default:OperatorAuth}=await import('../server/auth/OperatorAuth.js');
const {default:Guard}=await import('../server/auth/OperatorRequestGuard.js');
const {identifyReferenceRequest}=await import('../server/media-library/ReferenceRequestIdentity.js');
const source=await readFile(new URL('../server/program-output-server.js',import.meta.url),'utf8');
const wrapper=source.slice(source.indexOf('const identifyReferenceRequest='),source.indexOf('    const previewOwnership ='));
assert.equal(wrapper.trim(),'const identifyReferenceRequest=(request,session)=>readReferenceRequestIdentity(request,session,referenceClients);');
const branch=(begin,end)=>source.slice(source.indexOf(begin),source.indexOf(end,source.indexOf(begin)));
const mediaBranch=branch('            if (url.pathname.startsWith("/api/media-library/"))','            if (url.pathname.startsWith("/api/studio/state"))');
const studioBranch=branch('            if (url.pathname.startsWith("/api/studio/state"))',"            if (url.pathname === '/api/studio/autolive'");
const scheduleBranch=branch('            if (url.pathname === "/api/studio/schedule"',"            if (url.pathname === '/api/studio/execution-ownership')");
assert.ok(mediaBranch.includes('await identifyReferenceRequest'));assert.ok(studioBranch.includes('await identifyReferenceRequest'));assert.ok(scheduleBranch.includes('await identifyReferenceRequest'));
export const capabilities=['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'];
export async function referenceReadFixture(t,{initial,registryPath,scheduleRoutes,unreadable=false}={}){
 const root=await mkdtemp(join(tmpdir(),'lz-era27-reference-')),path=registryPath??join(root,'clients.json');
 t.after(async()=>{observer.disable();mediaRoutes.presenceConnections?.clear();studioStateRoutes.close();const r=relative(tmpdir(),root);assert.ok(r.startsWith('lz-era27-reference-')&&!r.startsWith('..')&&!isAbsolute(r));await rm(root,{recursive:true,force:true});});
 if(initial!==undefined)await writeFile(path,initial);
 const coordinator=new Coordinator();let registry;
 const originalRead=fs.promises.readFile;
 if(unreadable){fs.promises.readFile=function(target,...args){if(target===path)return Promise.reject(Object.assign(new Error('fixture EACCES'),{code:'EACCES'}));return originalRead.call(this,target,...args);};syncBuiltinESMExports();}
 try{registry=new Registry({coordinator,path,coverageProven:true,minimumVersion:3,requireEpoch:true});await registry.ready;}
 finally{if(unreadable){fs.promises.readFile=originalRead;syncBuiltinESMExports();}}
 let mutationCalls=0;const mutate=registry.mutate.bind(registry);registry.mutate=fn=>{mutationCalls++;return mutate(fn);};
 const auth=new OperatorAuth({username:'operator',password:'test-password-only',secureCookie:false});
 const session=auth.authenticate('operator','test-password-only'),cookie=auth.createCookie(session).split(';')[0];
 const principal=createHash('sha256').update(session.id).digest('hex');
 registry.authenticatedPrincipals=()=>[principal];registry.isSessionRevoked=p=>p!==principal;
 const operatorGuard=new Guard({auth,allowedOrigins:new Set(['http://fixture.invalid'])});
 const repository={list:()=>[],get:()=>null};
 const mediaRoutes=new MediaRoutes({repository});mediaRoutes.referenceClients=registry;
 mediaRoutes.previewOwnership={revokePrincipal:async()=>{},disconnect:async()=>{}};
 mediaRoutes.referenceAudit={globalCompleteness:async()=>registry.snapshot()};
 const studioStateRoutes=new StudioRoutes({coordinator:{subscribe:()=>()=>{},getSnapshot:()=>({version:1,revision:0,sources:[],scenes:[]})}});
 studioStateRoutes.referenceClients=registry;
 const schedule=scheduleRoutes??{handle:async(req,res)=>{res.writeHead(req.method==='GET'?200:405);res.end(JSON.stringify({ok:req.method==='GET'}));}};
 const identify=(req,s)=>identifyReferenceRequest(req,s,registry);
 // Exact current production branch text, actual guard/prefilter/route components;
 // no application launch, sockets, services or protected H1 import.
 const handle=new Function('operatorGuard','identifyReferenceRequest','mediaReady','previewOwnership','channelLogoAuthority','mediaRoutes','studioStateReady','studioStateRoutes','scheduleRoutes',
  'return async(request,response,url)=>{'+mediaBranch+studioBranch+scheduleBranch+'response.writeHead(404);response.end(JSON.stringify({ok:false}));};')
  (operatorGuard,identify,Promise.resolve(),{ready:Promise.resolve()},{ready:Promise.resolve()},mediaRoutes,Promise.resolve(),studioStateRoutes,schedule);
 const h={root,path,registry,coordinator,session,principal,mediaRoutes,studioStateRoutes,identify,
  async request(method='GET',url='/api/studio/schedule',{headers={},body,authenticated=true,mutationAuthorized=true}={}){
   const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),res=new EventEmitter();Object.assign(req,{method,url,headers:{host:'fixture.invalid',...(authenticated?{cookie}:{}),...(mutationAuthorized?{origin:'http://fixture.invalid','x-livezone-operator-request':'1','x-livezone-csrf':session.csrfToken}:{}),'content-type':'application/json',...headers}});
   let status,payload;const chunks=[];Object.assign(res,{writeHead(code){status=code;},end(value){if(value)payload=JSON.parse(value);},write(value){chunks.push(value);return true;}});
   const work=handle(req,res,new URL(url,'http://fixture.invalid'));
   await work;return {status,body:payload,chunks,req,res};
  },
  async register(){const r=await this.request('POST','/api/media-library/reference-clients',{body:{role:'CONTROL',version:3,capabilities}});assert.equal(r.status,201);return r.body.client;},
  headers(client){return {'x-livezone-reference-client':client.clientId,'x-livezone-reference-generation':String(client.generation)};},
  async bytes(){const result={};async function walk(dir){for(const name of (await readdir(dir)).sort()){const p=join(dir,name),s=await lstat(p);if(s.isDirectory())await walk(p);else if(s.isFile())result[relative(root,p)]=createHash('sha256').update(await readFile(p)).digest('hex');}}await walk(root);return result;},
  async observe(fn){const before=await this.bytes(),records=structuredClone([...registry.clients]),calls=mutationCalls;for(const k of Object.keys(observer.counts))observer.counts[k]=0;observer.enable();let result;try{result=await fn();}finally{observer.disable();}assert.deepEqual(observer.counts,Object.fromEntries(Object.keys(observer.counts).map(k=>[k,0])));assert.deepEqual(await this.bytes(),before);assert.deepEqual([...registry.clients],records);assert.equal(mutationCalls,calls);return result;}
 };return h;
}
export {observer};
