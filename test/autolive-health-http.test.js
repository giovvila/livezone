import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import SafeHttp,{publicAddress,externalUrl} from '../server/autolive/AutoLiveSafeHttp.js';
import HlsObserver,{parsePlaylist} from '../server/autolive/AutoLiveHlsObserver.js';
import {resolveHealthSource} from '../server/autolive/AutoLiveHealthContract.js';

export const media=(sequence=1,{end=false,discontinuity=0}={})=>`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuity}\n#EXTINF:2,\nsegment-${sequence}.ts\n${end?'#EXT-X-ENDLIST':''}`;
async function fixture(t,handler){
    const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
    return {server,url:`http://127.0.0.1:${server.address().port}/index.m3u8`};
}
// Explicit fixture-only trust injection. Production construction has no local exception.
const fixtureHttp=(options={})=>new SafeHttp({parseUrl:v=>new URL(v),allowAddress:ip=>ip==='127.0.0.1',...options});
for(const address of ['0.0.0.0','10.1.2.3','100.64.1.1','127.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::','2001::1'])test('A2 SSRF address blocked '+address,()=>assert.equal(publicAddress(address),false));
for(const address of ['8.8.8.8','93.184.216.34','185.105.4.51','2606:4700:4700::1111'])test('A2 public address accepted '+address,()=>assert.equal(publicAddress(address),true));
for(const url of ['file:///etc/passwd','ftp://example.com/x','data:text/plain,x','javascript:alert(1)','http://u:p@example.com/x','http://localhost/x','http://sub.localhost/x','http://example.com:9997/x','http://example.com/'+ 'a'.repeat(2050)])test('A2 unsafe URL rejected '+url.slice(0,60),()=>assert.throws(()=>externalUrl(url)));
test('A3 DNS resolver failure is DNS_ERROR, not ADDRESS_FORBIDDEN',async()=>{
    const http=new SafeHttp({resolve:async()=>{const e=new Error('resolver refused');e.code='ECONNREFUSED';throw e;}});
    await assert.rejects(http.read('https://public.example.com/live.m3u8'),{code:'ECONNREFUSED'});
});
test('A3 empty DNS answer is DNS_ERROR, not ADDRESS_FORBIDDEN',async()=>{
    const http=new SafeHttp({resolve:async()=>[]});
    await assert.rejects(http.read('https://public.example.com/live.m3u8'),{code:'DNS_ERROR'});
});
test('A2 DNS private or mixed answers never open a connection',async()=>{
    for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]]){
        const http=new SafeHttp({resolve:async()=>addresses});await assert.rejects(http.read('https://host.example.com/live'),{code:'ADDRESS_FORBIDDEN'});
    }
});
test('A2 actual socket uses validated pinned DNS answer, not second lookup',async t=>{
    let calls=0;const h=await fixture(t,(req,res)=>res.end(media()));
    const http=fixtureHttp({resolve:async()=>{calls++;return [{address:'127.0.0.1',family:4}];}});
    const url=h.url.replace('127.0.0.1','public.example.com');assert.match((await http.read(url)).body,/#EXTM3U/);assert.equal(calls,1);
});
test('A2 validated multi-address answers retry network failure without DNS re-resolution',async()=>{
    let resolves=0;const attempts=[];
    const addresses=[{address:'2606:4700:4700::1111',family:6},{address:'8.8.8.8',family:4}];
    const http=new SafeHttp({resolve:async()=>{resolves++;return addresses;}});
    http.request=async(url,address)=>{attempts.push(address.address);if(attempts.length===1){const e=new Error('network');e.code='NETWORK_ERROR';throw e;}return {body:'#EXTM3U',bytes:7};};
    assert.equal((await http.read('https://public.example.com/live.m3u8')).body,'#EXTM3U');
    assert.equal(resolves,1);assert.deepEqual(attempts,addresses.map(value=>value.address));
});
test('A2 multi-address fallback never retries policy or HTTP failures',async()=>{
    const addresses=[{address:'8.8.8.8',family:4},{address:'93.184.216.34',family:4}];let attempts=0;
    const http=new SafeHttp({resolve:async()=>addresses});
    http.request=async()=>{attempts++;const e=new Error('http');e.code='HTTP_ERROR';throw e;};
    await assert.rejects(http.read('https://public.example.com/live.m3u8'),{code:'HTTP_ERROR'});assert.equal(attempts,1);
});
test('A2 redirects are bounded and revalidate destination',async t=>{
    const h=await fixture(t,(req,res)=>{if(req.url==='/ok'){res.end(media());return;}res.writeHead(302,{Location:req.url==='/index.m3u8'?'/ok':req.url==='/forbidden'?'http://10.0.0.1/x':'/loop'});res.end();});
    const http=fixtureHttp();assert.match((await http.read(h.url)).body,/#EXTM3U/);
    await assert.rejects(http.read(new URL('/forbidden',h.url).href),{code:'ADDRESS_FORBIDDEN'});
    await assert.rejects(http.read(new URL('/loop',h.url).href),{code:'REDIRECT_LIMIT'});
});
test('A2 HTTP body, timeout and abort are bounded',async t=>{
    const h=await fixture(t,(req,res)=>{if(req.url==='/large')res.end('x'.repeat(140000));else if(req.url==='/compressed'){res.writeHead(200,{'Content-Encoding':'gzip'});res.end('x');}});
    const http=fixtureHttp({timeoutMs:40});await assert.rejects(http.read(new URL('/large',h.url).href),{code:'BODY_LIMIT'});
    await assert.rejects(http.read(new URL('/compressed',h.url).href),{code:'ENCODING_UNSUPPORTED'});
    await assert.rejects(http.read(h.url),{code:'ABORTED'});
    const abort=new AbortController();const reading=http.read(h.url,{signal:abort.signal});abort.abort();await assert.rejects(reading,{code:'ABORTED'});
});
test('A2 external master, repeated live advance, stall, reset and endlist',async t=>{
    let sequence=1,end=false,discontinuity=0,clock=1000,segmentReads=0,highReads=0;
    const h=await fixture(t,(req,res)=>{
        if(req.url==='/index.m3u8')return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8');
        if(req.url==='/high.m3u8')highReads++;
        if(req.url==='/low.m3u8')return res.end(media(sequence,{end,discontinuity}));
        segmentReads++;assert.equal(req.headers.range,'bytes=0-0');res.writeHead(206);res.end('x');
    });
    const observer=new HlsObserver({http:fixtureHttp(),clock:()=>clock});const source=resolveHealthSource({id:'live',kind:'hls',url:h.url});
    assert.equal((await observer.sample(source)).state,'UNCERTAIN');sequence++;clock+=3000;
    assert.equal((await observer.sample(source)).reason,'PLAYLIST_ADVANCING');sequence++;clock+=3000;
    assert.equal((await observer.sample(source)).playlistProgressing,true);clock+=16000;
    assert.equal((await observer.sample(source)).reason,'PLAYLIST_STALLED');sequence=0;discontinuity++;
    assert.equal((await observer.sample(source)).reason,'SEQUENCE_RESET');end=true;
    assert.equal((await observer.sample(source)).reason,'ENDLIST_NONLIVE');assert.equal(highReads,0);assert.equal(segmentReads,6);
});
test('A2 external errors and network recovery never infer healthy playback from HTTP 200',async t=>{
    let mode='manifest404',sequence=1;
    const h=await fixture(t,(req,res)=>{if(mode==='manifest404'||mode==='segment404'&&req.url.includes('.ts')){res.writeHead(404);res.end();return;}
        res.end(req.url.includes('.ts')?'x':mode==='malformed'?'not a playlist':media(sequence));});
    const observer=new HlsObserver({http:fixtureHttp()});const source=resolveHealthSource({id:'x',kind:'hls',url:h.url});
    await assert.rejects(observer.sample(source),{code:'HTTP_ERROR'});mode='segment404';await assert.rejects(observer.sample(source),{code:'HTTP_ERROR'});
    mode='malformed';await assert.rejects(observer.sample(source),{code:'PLAYLIST_INVALID'});mode='ok';assert.equal((await observer.sample(source)).state,'UNCERTAIN');
    sequence++;assert.equal((await observer.sample(source)).state,'ONLINE');
});
for(const text of ['#EXTM3U','#EXTM3U\n#EXT-X-STREAM-INF:NO=1\nx','#EXTM3U\n#EXT-X-TARGETDURATION:NaN\n#EXTINF:2,\nx',media(-1),media().replace('#EXTINF:2,','#EXTINF:-1,')])test('A2 malformed HLS fails closed '+text.slice(-30),()=>assert.throws(()=>parsePlaylist(text,'https://example.com/live')));
test('A2 byte-range playlist explicitly unsupported; no decoder equivalence',async t=>{
    const h=await fixture(t,(req,res)=>res.end(req.url.includes('.ts')?'x':media().replace('#EXTINF:2,','#EXT-X-BYTERANGE:10@5\n#EXTINF:2,')));
    const observer=new HlsObserver({http:fixtureHttp()});const sample=await observer.sample(resolveHealthSource({id:'x',kind:'hls',url:h.url}));assert.equal(sample.reason,'BYTE_RANGE_UNSUPPORTED');assert.equal(sample.playlistProgressing,false);
});
test('A2 declared VOD cannot become live even if an invalid publisher advances it',async t=>{
    let sequence=1;
    const h=await fixture(t,(req,res)=>res.end(req.url.includes('.ts')?'x':media(sequence)+'\n#EXT-X-PLAYLIST-TYPE:VOD'));
    const observer=new HlsObserver({http:fixtureHttp()});const source=resolveHealthSource({id:'x',kind:'hls',url:h.url});
    assert.equal((await observer.sample(source)).reason,'VOD_NONLIVE');sequence++;
    const next=await observer.sample(source);assert.equal(next.state,'UNCERTAIN');assert.equal(next.playlistProgressing,false);
});
test('A2 overflowing HLS identity and bandwidth fail closed',()=>{
    assert.throws(()=>parsePlaylist(media(Number.MAX_SAFE_INTEGER)+'\n#EXTINF:2,\nnext.ts','https://example.com/live'));
    assert.throws(()=>parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=999999999999999999999\nx','https://example.com/live'));
});
