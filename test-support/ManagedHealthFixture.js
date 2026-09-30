import Config from '../server/media-ingest/MediaIngestConfig.js';
import Client from '../server/media-ingest/MediaIngestStatusClient.js';
import {managedHttp} from '../server/autolive/ManagedIngestTransport.js';

// Substitute network responses only. Parsing, trust checks, producers, status
// validation and registry publication all remain production code.
export function managedFixture() {
    const config=new Config({mediaPath:'camera',playbackHlsUrl:'http://127.0.0.1:18181/camera/index.m3u8'});
    const state={sequence:10,present:true,onlineTime:'2026-09-30T16:00:00Z',calls:[],segment:true};
    const media=()=>`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${state.sequence}\n#EXTINF:2,\nsegment-${state.sequence}.mp4\n`;
    const client=new Client({config,fetchImplementation:async url=>{
        state.calls.push(new URL(url).pathname);
        return new Response(JSON.stringify({items:state.present?[{name:config.mediaPath,online:true,
            source:{type:'rtmpConn'},tracks2:['H264'],onlineTime:state.onlineTime}]:[]}));
    }});
    const http=managedHttp(config);
    http.request=async(url,address,signal,segment)=>{
        state.calls.push(url.pathname);
        if(signal.aborted)throw Object.assign(Error(),{code:'ABORTED'});
        if(segment){
            if(!state.segment)throw Object.assign(Error(),{code:'HTTP_ERROR'});
            return {bytes:1};
        }
        if(state.failure)throw Object.assign(Error(),{code:state.failure});
        return {body:state.body??media(),bytes:100};
    };
    return {config,client,http,state,media};
}
