import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createProgramOutputServer } from '../test-support/ReferenceAuthorityTestServer.js';

for(const name of ['demo.mp4','demo3.mp4','demo2.mp4']) test(`production byte ranges and Content-Length: ${name}`, {skip:!existsSync(`public/media/${name}`)}, async () => {
    const path=resolve('public/media',name), size=statSync(path).size;
    const repository={initialize:async()=>{},list:()=>[{storedName:name,mimeType:'video/mp4'}],safeFilePath:()=>path};
    const {server}=createProgramOutputServer({publisherToken:'large-video-test-token-only',mediaAssetRepository:repository});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}`;
    const observations=[];
    try {
        for(const route of [`/media/${name}`,`/media-library/files/video/${name}`]) {
            const head=await fetch(base+route,{method:'HEAD'});
            assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(size));
            assert.equal(head.headers.get('accept-ranges'),'bytes');
            for(const start of [0,Math.floor(size/2),size-128]) {
                const end=start+127;
                const response=await fetch(base+route,{headers:{Range:`bytes=${start}-${end}`}});
                assert.equal(response.status,206);
                assert.equal(response.headers.get('accept-ranges'),'bytes');
                assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${size}`);
                assert.equal(response.headers.get('content-length'),'128');
                const bytes=Buffer.from(await response.arrayBuffer()),expected=Buffer.alloc(128);
                const fd=openSync(path,'r');try{readSync(fd,expected,0,128,start);}finally{closeSync(fd);}
                assert.deepEqual(bytes,expected);
                observations.push({route,start,end,status:response.status,size});
            }
            const invalid=await fetch(base+route,{headers:{Range:`bytes=${size}-`}});
            assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),`bytes */${size}`);
            await invalid.arrayBuffer();
        }
        writeFileSync(`var/large-video-range-${name}.json`,JSON.stringify(observations,null,2));
    } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
