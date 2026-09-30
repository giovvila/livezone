import SafeHttp from './AutoLiveSafeHttp.js';
import {error} from './AutoLiveContract.js';
import {hashIdentity} from './AutoLiveHealthContract.js';

// The configured origin is operator-owned trust, not a general private-network
// exception. Every selected variant/resource stays below its configured directory.
export function managedResource(value, base, canonical) {
    const raw = String(value).split(/[?#]/,1)[0];
    if(/[\u0000-\u0020\u007f\\]/.test(raw) || /%(?:2e|2f|5c|25)/i.test(raw) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw))
        throw error('URL_FORBIDDEN');
    let url;
    try { url = new URL(value,base); } catch { throw error('URL_FORBIDDEN'); }
    const root = new URL(canonical);
    const directory = root.pathname.slice(0,root.pathname.lastIndexOf('/')+1);
    if(url.origin !== root.origin || !url.pathname.startsWith(directory) ||
        url.username || url.password || url.hash || url.href.length > 2048)
        throw error('URL_FORBIDDEN');
    return url;
}

export function managedHttp(config) {
    return new SafeHttp({
        parseUrl:value=>managedResource(value,config.playbackHlsUrl,config.playbackHlsUrl),
        // Only the configured authority is reachable; SafeHttp pins each socket
        // to its resolved address. Redirects cannot extend that authority.
        allowAddress:()=>true,
        validateRedirect:()=>{throw error('REDIRECT_INVALID');},
        timeoutMs:config.timeoutMs
    });
}

function attributes(text) {
    const result = {};
    const pattern = /([A-Z0-9-]+)=("[^"\r\n]*"|[^,\r\n]+)(?:,|$)/gy;
    let at=0,match;
    while((match=pattern.exec(text))){
        if(Object.hasOwn(result,match[1]))throw error('PLAYLIST_INVALID');
        result[match[1]]=match[2].replace(/^"|"$/g,'');at=pattern.lastIndex;
    }
    if(at!==text.length)throw error('PLAYLIST_INVALID');
    return result;
}

// MediaMTX media playlists contain complete segments and, in lowLatency mode,
// EXT-X-PARTs. PRELOAD-HINT is deliberately not evidence of published media.
export function parseManagedPlaylist(text) {
    const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(v=>v.trim());
    if(lines[0]!=='#EXTM3U'||lines.length>8192)throw error('PLAYLIST_INVALID');
    let sequence=0,discontinuity=0,target=0,segments=0,parts=0,current=null;
    let duration=null,variant=null,nonlive=false,unsupported=false;
    const variants=[];
    for(const line of lines.slice(1)){
        if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))sequence=Number(line.slice(22));
        else if(line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))discontinuity=Number(line.slice(30));
        else if(line==='#EXT-X-DISCONTINUITY')discontinuity++;
        else if(line.startsWith('#EXT-X-TARGETDURATION:'))target=Number(line.slice(22));
        else if(line.startsWith('#EXT-X-STREAM-INF:')){
            variant=Number(attributes(line.slice(18)).BANDWIDTH);
            if(!Number.isSafeInteger(variant)||variant<=0)throw error('PLAYLIST_INVALID');
        }
        else if(line.startsWith('#EXTINF:')){
            duration=Number(line.slice(8).split(',')[0]);
            if(!Number.isFinite(duration)||duration<=0)throw error('PLAYLIST_INVALID');
        }
        else if(line.startsWith('#EXT-X-PART:')){
            const a=attributes(line.slice(12));
            if(!a.URI||!Number.isFinite(Number(a.DURATION))||Number(a.DURATION)<=0)throw error('PLAYLIST_INVALID');
            if(a.BYTERANGE||a.GAP==='YES')unsupported=true;
            current={msn:sequence+segments,part:parts++,uri:a.URI,discontinuity};
        }
        else if(line==='#EXT-X-ENDLIST'||line==='#EXT-X-PLAYLIST-TYPE:VOD')nonlive=true;
        else if(line.startsWith('#EXT-X-BYTERANGE:')||line==='#EXT-X-GAP'||line.startsWith('#EXT-X-SKIP:'))unsupported=true;
        else if(line&&!line.startsWith('#')){
            if(variant!==null){variants.push({uri:line,bandwidth:variant});variant=null;}
            else {
                if(duration===null)throw error('PLAYLIST_INVALID');
                current={msn:sequence+segments++,part:Number.MAX_SAFE_INTEGER,uri:line,discontinuity};
                duration=null;parts=0;
            }
        }
    }
    if(variant!==null||duration!==null||variants.length&&current)throw error('PLAYLIST_INVALID');
    if(variants.length)return {variant:variants.sort((a,b)=>a.bandwidth-b.bandwidth||a.uri.localeCompare(b.uri))[0].uri};
    if(!current||!Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(discontinuity)||discontinuity<0||
        !Number.isSafeInteger(current.msn)||!Number.isInteger(target)||target<=0||target>3600)throw error('PLAYLIST_INVALID');
    return {current,nonlive,unsupported};
}

export default class ManagedIngestTransport {
    constructor(config,{http=managedHttp(config)}={}) { this.config=config;this.http=http; }
    reset(){this.previous=null;}
    async sample(signal){
        let url=this.config.playbackHlsUrl,playlist;
        try {
            for(let depth=0;depth<3;depth++){
                const result=await this.http.read(url,{signal,stage:depth?'variant':'manifest'});
                playlist=parseManagedPlaylist(result.body);
                if(!playlist.variant)break;
                if(depth===2)throw error('VARIANT_DEPTH');
                url=managedResource(playlist.variant,url,this.config.playbackHlsUrl).href;
            }
        }catch(e){
            this.reset();
            const code=['HTTP_ERROR','PLAYLIST_INVALID','BODY_LIMIT','ABORTED','URL_FORBIDDEN','REDIRECT_INVALID','VARIANT_DEPTH','ENCODING_UNSUPPORTED'].includes(e.code)?e.code:'PLAYLIST_UNREACHABLE';
            return {playbackAvailable:false,playlistProgressing:null,segmentReachable:null,reason:code};
        }
        const token={...playlist.current,uri:hashIdentity(playlist.current.uri),playlist:hashIdentity(url)};
        const previous=this.previous;
        const reset=previous&&(token.playlist!==previous.playlist||token.discontinuity!==previous.discontinuity||
            token.msn<previous.msn||token.msn===previous.msn&&token.part<previous.part);
        const advanced=Boolean(previous&&!reset&&token.uri!==previous.uri&&
            (token.msn>previous.msn||token.msn===previous.msn&&token.part>previous.part));
        this.previous=playlist.nonlive||playlist.unsupported?null:token;
        let reason=playlist.nonlive?'ENDLIST_NONLIVE':playlist.unsupported?'PLAYLIST_UNSUPPORTED':
            reset?'SEQUENCE_RESET':!previous?'PLAYLIST_FIRST_OBSERVATION':advanced?'TRANSPORT_READY':'PLAYLIST_STALLED';
        const progressing=playlist.nonlive||playlist.unsupported||reset?false:!previous?null:advanced;
        let reachable=false;
        try {
            const resource=managedResource(playlist.current.uri,url,this.config.playbackHlsUrl).href;
            const segment=await this.http.read(resource,{signal,segment:true,stage:'segment'});
            reachable=segment.bytes>0;
            if(!reachable)reason='SEGMENT_UNREACHABLE';
        }catch(e){reason=e.code==='URL_FORBIDDEN'?'URL_FORBIDDEN':e.code==='ABORTED'?'ABORTED':'SEGMENT_UNREACHABLE';}
        return {playbackAvailable:true,playlistProgressing:progressing,segmentReachable:reachable,reason};
    }
}
