import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Experiment from '../server/autolive/decoder/BrokeredShadowExperiment.js';
import SafeHttp from '../server/autolive/AutoLiveSafeHttp.js';
import {remoteReference} from '../server/autolive/decoder/HlsDecodeInputBroker.js';
import {generate,LOCAL_BACKEND} from '../test-support/DecoderLocalFixture.js';

async function fixture(t){
    const root=await mkdtemp(join(tmpdir(),'lz-shadow-cleanup-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await generate([
        '-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=5',
        '-f','lavfi','-i','sine=sample_rate=16000:duration=5',
        '-c:v','libx264','-preset','ultrafast','-g','10',
        '-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0',
        '-hls_segment_filename',join(root,'segment%d.ts'),
        join(root,'input.m3u8')
    ],{cwd:root});
    const manifest=(await readFile(join(root,'input.m3u8'),'utf8')).replace('#EXT-X-ENDLIST','');
    const server=createServer(async(req,res)=>{
        const name=req.url.slice(1);
        if(!/^(?:input\.m3u8|segment\d+\.ts)$/.test(name)){res.writeHead(404);return res.end();}
        try{
            res.end(name==='input.m3u8'?manifest:await readFile(join(root,name)));
        }catch{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
    const http=new SafeHttp({
        parseUrl:value=>new URL(remoteReference(value)),
        allowAddress:ip=>ip==='127.0.0.1',
        validateRedirect:remoteReference
    });
    return {
        endpoint:'http://127.0.0.1:'+server.address().port+'/input.m3u8',
        http
    };
}

test('shadow experiment reports successful cleanup normally',async t=>{
    const f=await fixture(t);
    const controller=new AbortController();
    const experiment=new Experiment({
        source:{sourceId:'fixture',endpoint:f.endpoint,fingerprint:'a'.repeat(64)},
        backend:LOCAL_BACKEND,
        durationMs:20000,
        http:f.http,
        signal:controller.signal,
        observe:value=>{if(value.pid)controller.abort();}
    });
    const result=await experiment.run();
    assert.equal(result.cleanup,true);
    assert.equal(result.cleanupReason,null);
    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
    assert.equal(result.transferReady,false);
});

test('shadow experiment returns bounded result when broker pending drain cannot complete',async t=>{
    const f=await fixture(t);
    const controller=new AbortController();
    let poisoned=false;
    const experiment=new Experiment({
        source:{sourceId:'fixture',endpoint:f.endpoint,fingerprint:'a'.repeat(64)},
        backend:LOCAL_BACKEND,
        durationMs:20000,
        http:f.http,
        signal:controller.signal,
        observe:value=>{
            if(value.pid&&!poisoned){
                poisoned=true;
                experiment.broker.pending=new Promise(()=>{});
                controller.abort();
            }
        }
    });
    const started=Date.now();
    const result=await experiment.run();
    const elapsed=Date.now()-started;
    assert.ok(elapsed<8000,'shadow cleanup was not bounded');
    assert.equal(result.cleanup,false);
    assert.equal(result.cleanupReason,'PENDING_DRAIN_TIMEOUT');
    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
    assert.equal(result.transferReady,false);
});