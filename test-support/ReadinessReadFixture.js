import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,lstat,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {observer} from './PureScheduleReadFixture.js';
const {default:Readiness}=await import('../server/runtime/RuntimeReadiness.js');
const source=await readFile(new URL('../server/program-output-server.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const helpers=slice('function classifySecurityPath(', 'function safeOperatorReturn(')+
    slice('function parseRequestUrl(', 'function parseByteRange(')+slice('function sendJson(', 'function parseOrigins(');
const prefix=slice('            const url = parseRequestUrl(', '            if (url.pathname === "/api/operator/session"');
assert.ok(prefix.includes('["GET", "HEAD"].includes(request.method)'));
assert.ok(!prefix.includes('identifyReferenceRequest'));
export async function readinessReadFixture(t,{mediaReady=Promise.resolve(),studioStatus='VALID',ingest='offline',storageObserver}={}){
    const root=await mkdtemp(join(tmpdir(),'lz-era28-readiness-')),directory=join(root,'.tmp');await mkdir(directory);
    t.after(async()=>{observer.disable();const r=relative(tmpdir(),root);assert.ok(r.startsWith('lz-era28-readiness-')&&!r.startsWith('..')&&!isAbsolute(r));await rm(root,{recursive:true,force:true});});
    const repository={tempRoot:directory};
    const runtimeReadiness=new Readiness({mediaReady,mediaAssetRepository:repository,mediaIngestStatusClient:{getStatus:async()=>({state:ingest})},...(storageObserver?{storageObserver}:{})});
    const handle=new Function('runtimeReadiness','studioStateReady','studioStateCoordinator',helpers+
        'return async(request,response)=>{try{'+prefix+'sendJson(response,404,{ok:false});}catch(error){sendJson(response,400,{ok:false});}};')
        (runtimeReadiness,Promise.resolve(),{getStatus:()=>({status:studioStatus})});
    return {root,directory,repository,runtimeReadiness,handle,
        async request(method='GET',url='/readyz'){
            let status,body,headers,ended=false;
            await handle({method,url,headers:{host:'fixture.invalid'}},{writeHead(code,value){status=code;headers=value;},end(value){ended=true;body=value??'';}});
            assert.equal(ended,true);return {status,headers,body,payload:body?JSON.parse(body):null};
        },
        async bytes(){const result={};async function walk(dir){for(const name of (await readdir(dir)).sort()){const p=join(dir,name),s=await lstat(p);if(s.isDirectory())await walk(p);else if(s.isFile())result[relative(root,p)]=createHash('sha256').update(await readFile(p)).digest('hex');}}await walk(root);return result;},
        async observe(fn){const before=await this.bytes();for(const key of Object.keys(observer.counts))observer.counts[key]=0;observer.enable();let result;try{result=await fn();}finally{observer.disable();}assert.deepEqual(observer.counts,Object.fromEntries(Object.keys(observer.counts).map(k=>[k,0])));assert.deepEqual(await this.bytes(),before);return result;}
    };
}
export {observer};
