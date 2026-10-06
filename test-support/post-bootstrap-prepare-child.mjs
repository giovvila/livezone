import assert from 'node:assert/strict';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {RecoveryWorkflow} from '../server/recovery/RecoveryWorkflow.js';
import {reserve8080} from '../server/recovery/WindowsRecoveryHost.js';
import {paths,capture,artifact,BRANCH} from '../server/recovery/RecoveryContract.js';

// Exercise the production reservation with real TCP peers, but never bind 8080.
// Only this disposable fixture child redirects the two listeners to OS ports.
const original=net.createServer,servers=[];
net.createServer=(...args)=>{
    const server=original(...args),listen=server.listen;
    server.listen=function(options,callback){
        assert.equal(options.port,8080);assert.equal(options.exclusive,true);
        assert.equal(options.ipv6Only,options.host==='::');
        return listen.call(this,{...options,port:0},callback);
    };
    servers.push(server);return server;
};
syncBuiltinESMExports();
const [root,head]=process.argv.slice(2),p=paths(root),before=await capture(p);
const service=before.maintenance.value.Original;
const host={
    inspect:async()=>({root,head,branch:BRANCH,administrator:true,
        service:{...service,State:'Stopped',StartMode:'Disabled'},media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},
        proof:{absent:true},ports:[],bootstrapPermission:false}),
    proveOffline:async()=>({absent:true}),
    reserve:async()=>{
        const start=servers.length,release=await reserve8080();
        for(const server of servers.slice(start)){
            const contender=original(),address=server.address();
            const refused=once(contender,'error');
            contender.listen({host:address.address,port:address.port,exclusive:true,ipv6Only:address.family==='IPv6'});
            assert.equal((await refused)[0].code,'EADDRINUSE');
            const accepted=once(server,'connection');
            const client=net.connect({host:server.address().family==='IPv6'?'::1':'127.0.0.1',port:server.address().port});
            client.on('error',()=>{});
            // Deliberately never end the peer: health probes must not hold release open.
            await accepted;
        }
        return async()=>{console.log('RELEASE_ENTER');await release();console.log('RELEASE_RETURN');};
    }
};
const w=new RecoveryWorkflow({root,runId:'fixture-run',host,expectedHead:head,
    hook:async stage=>{if(stage==='adopted'){assert.ok(await artifact(w.audit));console.log('AUDIT_DURABLE_ADOPTED');}}});
assert.equal((await w.begin()).scheduled,'ABSENT');
const auditHash=(await artifact(w.audit)).hash;
// Cleanup also returns when work throws after the durable audit/adoption.
w.hook=stage=>{if(stage==='adopted')throw Error('FIXTURE_AFTER_ADOPTION');};
await assert.rejects(w.begin(),/FIXTURE_AFTER_ADOPTION/);
w.hook=()=>{};
// Same-HEAD begin retry preserves the durable audit and adopted maintenance.
await w.begin();assert.equal((await artifact(w.audit)).hash,auditHash);
assert.deepEqual(await w.autoPlan(),{args:[]});
await w.scheduled();assert.equal((await w.prepared()).prepared,true);
assert.ok(await artifact(w.audit+'.prepared'));
const preparedEvidence=await capture(p);
for(const key of Object.keys(before).filter(k=>!k.startsWith('migration')))assert.deepEqual(preparedEvidence[key],before[key]);
assert.equal(preparedEvidence.migrationIntent.value.state,'INTENT');
assert.equal(await artifact(w.audit+'.disarm'),null);
assert.equal(await artifact(w.audit+'.start'),null);
console.log('PREPARED_UNCHANGED');
// No process.exit(): successful exit proves all reservation sockets were released.
