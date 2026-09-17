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
const short=value=>typeof value==='string'?value.slice(0,12):value;
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
        const backwardsMedia=Boolean(previous&&current.end<previous.end);
        const backwardsDiscontinuity=Boolean(previous&&current.discontinuity<previous.discontinuity);
        const dateRegressed=Boolean(previous&&current.date!==null&&previous.date!==null&&current.date<=previous.date);
        const forwardProgress=Boolean(previous&&current.end>previous.end&&current.uri!==previous.uri&&!dateRegressed);
        // Some Wowza deployments rotate or redirect the effective media-playlist URL
        // while the live window itself continues monotonically. URL identity alone is
        // therefore not a reset signal. We only fail closed on backwards media or
        // discontinuity progression. A rotated playlist URL with no proven forward
        // progression remains UNCERTAIN rather than becoming ONLINE.
        const resetCause=!previous?null:backwardsMedia?'MEDIA_SEQUENCE_BACKWARDS':backwardsDiscontinuity?'DISCONTINUITY_BACKWARDS':null;
        const reset=Boolean(resetCause);
        const advances=!reset&&forwardProgress;
        const playlistChanged=Boolean(previous&&previous.playlist!==current.playlist);
        this.previous=current;
        if(!previous||reset||advances)this.lastAdvance=now;
        const stale=now-this.lastAdvance>Math.max(15000,playlist.target*3000);
        const reason=playlist.byteRange?'BYTE_RANGE_UNSUPPORTED':playlist.endlist?'ENDLIST_NONLIVE':playlist.vod?'VOD_NONLIVE':reset?'SEQUENCE_RESET':stale?'PLAYLIST_STALLED':advances?'PLAYLIST_ADVANCING':playlistChanged?'PLAYLIST_IDENTITY_CHANGED':'AWAITING_PROGRESSION';
        const diagnostics={resetCause,playlistChanged,
            previous:previous?{playlist:short(previous.playlist),end:previous.end,discontinuity:previous.discontinuity,date:previous.date,uri:short(previous.uri)}:null,
            current:{playlist:short(current.playlist),end:current.end,discontinuity:current.discontinuity,date:current.date,uri:short(current.uri)}};
        return {state:reason==='PLAYLIST_ADVANCING'?'ONLINE':'UNCERTAIN',reason,publisherPresent:null,playbackAvailable:true,
            playlistProgressing:advances&&!playlist.endlist&&!playlist.vod&&!playlist.byteRange,segmentReachable:true,readiness:'transport-only',diagnostics};
    }
}
