import {error} from './AutoLiveContract.js';
import {hashIdentity} from './AutoLiveHealthContract.js';
import AutoLiveSafeHttp from './AutoLiveSafeHttp.js';

export function parsePlaylist(text,base){
    const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(s=>s.trim());
    if(lines[0]!=='#EXTM3U'||lines.length>8192)throw error('PLAYLIST_INVALID');
    const variants=[],segments=[];let sequence=0,discontinuity=0,target=0,duration=null,variant=null,date=null,endlist=false,byteRange=false,vod=false;
    for(const line of lines.slice(1)){
        if(line.startsWith('#EXT-X-STREAM-INF:')){const match=line.match(/(?:^|[:,])BANDWIDTH=(\d+)(?:,|$)/);if(!match)throw error('PLAYLIST_INVALID');variant=Number(match[1]);if(!Number.isSafeInteger(variant)||variant<=0)throw error('PLAYLIST_INVALID');}
        else if(line.startsWith('#EXT-X-TARGETDURATION:'))target=Number(line.split(':')[1]);
        else if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))sequence=Number(line.split(':')[1]);
        else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))discontinuity=Number(line.split(':')[1]);
        else if(line==='#EXT-X-DISCONTINUITY')discontinuity++;
        else if(line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')){date=Date.parse(line.slice(25));if(!Number.isFinite(date))throw error('PLAYLIST_INVALID');}
        else if(line.startsWith('#EXTINF:'))duration=Number(line.slice(8).split(',')[0]);
        else if(line==='#EXT-X-ENDLIST')endlist=true;
        else if(line==='#EXT-X-PLAYLIST-TYPE:VOD')vod=true;
        else if(line.startsWith('#EXT-X-BYTERANGE:'))byteRange=true;
        else if(line&&!line.startsWith('#')){
            let uri;try{uri=new URL(line,base).href;}catch{throw error('PLAYLIST_INVALID');}
            if(variant!==null){variants.push({uri,bandwidth:variant});variant=null;}
            else {if(!Number.isFinite(duration)||duration<=0)throw error('PLAYLIST_INVALID');segments.push({uri,date,discontinuity});if(date!==null)date+=duration*1000;duration=null;}
        }
    }
    if(variant!==null||duration!==null||variants.length&&segments.length)throw error('PLAYLIST_INVALID');
    if(variants.length)return {variants:variants.sort((a,b)=>a.bandwidth-b.bandwidth||a.uri.localeCompare(b.uri))};
    if(!Number.isInteger(target)||target<=0||target>3600||!Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(discontinuity)||discontinuity<0||!segments.length)throw error('PLAYLIST_INVALID');
    if(sequence>Number.MAX_SAFE_INTEGER-(segments.length-1))throw error('PLAYLIST_INVALID');
    return {segments,target,sequence,endlist,byteRange,vod};
}
export default class AutoLiveHlsObserver {
    constructor({http=new AutoLiveSafeHttp(),clock=()=>Date.now()}={}){Object.assign(this,{http,clock});}
    async sample(source,signal){
        let url=source.endpoint,playlist;
        for(let depth=0;depth<3;depth++){
            const response=await this.http.read(url,{signal});url=response.url;playlist=parsePlaylist(response.body,url);
            if(!playlist.variants)break;if(depth===2)throw error('VARIANT_DEPTH');url=playlist.variants[0].uri;
        }
        const last=playlist.segments.at(-1),now=this.clock();
        const segment=await this.http.read(last.uri,{signal,segment:true});if(!segment.bytes)throw error('SEGMENT_EMPTY');
        const current={playlist:hashIdentity(url),end:playlist.sequence+(playlist.segments.length-1),discontinuity:last.discontinuity,date:last.date,uri:hashIdentity(last.uri)};
        const previous=this.previous;
        // HLS discontinuity sequence is allowed to move forward as a discontinuity
        // passes through (or ages out of) a live sliding window. Treating every
        // discontinuity change as a reset kept valid Wowza live playlists permanently
        // UNCERTAIN. A backwards discontinuity identity is still fail-closed, as are
        // playlist identity changes and backwards media progression.
        const reset=previous&&(previous.playlist!==current.playlist||current.end<previous.end||current.discontinuity<previous.discontinuity);
        const advances=!!previous&&!reset&&current.end>previous.end&&current.uri!==previous.uri&&
            !(current.date!==null&&previous.date!==null&&current.date<=previous.date);
        this.previous=current;
        if(!previous||reset||advances)this.lastAdvance=now;
        const stale=now-this.lastAdvance>Math.max(15000,playlist.target*3000);
        const reason=playlist.byteRange?'BYTE_RANGE_UNSUPPORTED':playlist.endlist?'ENDLIST_NONLIVE':playlist.vod?'VOD_NONLIVE':reset?'SEQUENCE_RESET':stale?'PLAYLIST_STALLED':advances?'PLAYLIST_ADVANCING':'AWAITING_PROGRESSION';
        return {state:reason==='PLAYLIST_ADVANCING'?'ONLINE':'UNCERTAIN',reason,publisherPresent:null,playbackAvailable:true,
            playlistProgressing:advances&&!playlist.endlist&&!playlist.vod&&!playlist.byteRange,segmentReachable:true,readiness:'transport-only'};
    }
}
