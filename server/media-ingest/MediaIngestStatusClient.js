export default class MediaIngestStatusClient {
    constructor({ config, fetchImplementation = globalThis.fetch } = {}) {
        if (!config || typeof fetchImplementation !== "function") {
            throw new TypeError("MediaIngestStatusClient requires config and fetch.");
        }
        this.config = config;
        this.fetchImplementation = fetchImplementation;
    }

    async getStatus({ sourceOnly = false, signal } = {}) {
        const safe = this.config.toPublic();
        try {
            const payload = await this.fetchJson(
                new URL("/v3/paths/list", this.config.apiOrigin).href, signal
            );
            if (!payload || !Array.isArray(payload.items)) return this.errorStatus(safe);
            const path = payload.items.find((item) => item?.name === this.config.mediaPath);
            // An incomplete list cannot establish absence of the configured path.
            if (!path && payload.pageCount > 1) return this.errorStatus(safe);
            if (!path || path.online === false) return this.status(safe, "offline", false, false, null);
            if (path.online !== true || !path.source || typeof path.source.type !== "string" ||
                !path.source.type || !Array.isArray(path.tracks2)) {
                return this.errorStatus(safe);
            }
            const publisherPresent = path.tracks2.length > 0;
            if (!publisherPresent) return this.status(safe, "connecting", false, false,
                validTimestamp(path.onlineTime));
            // Ownership probes must not wait for (or trust) buffered HLS.
            const hlsAvailable = sourceOnly ? false : await this.probeHls(signal);
            return this.status(safe, hlsAvailable ? "live" : "connecting", true,
                hlsAvailable, validTimestamp(path.onlineTime));
        } catch {
            return this.errorStatus(safe);
        }
    }

    async fetchJson(url, signal) {
        return this.readBounded(url,'json',signal);
    }

    async probeHls(signal) {
        try {
            return (await this.readBounded(this.config.playbackHlsUrl,'text',signal)).trimStart().startsWith("#EXTM3U");
        } catch { return false; }
    }

    async readBounded(url,kind,signal){
        const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)controller.abort();const timer=setTimeout(abort,this.config.timeoutMs);let reader,onAbort;
        const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(new Error('Media ingest request aborted'));controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();});
        try{return await Promise.race([cancelled,(async()=>{
            const response=await this.fetchImplementation(url,{headers:{Accept:kind==='json'?'application/json':'application/vnd.apple.mpegurl'},cache:'no-store',signal:controller.signal});
            if(!response?.ok)throw new Error('Media ingest unavailable');
            if(!response.body?.getReader){const value=await (kind==='json'?response.json():response.text());if(JSON.stringify(value).length>131072)throw new Error('Media ingest body limit');return value;}
            reader=response.body.getReader();const chunks=[];let size=0;
            for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>131072)throw new Error('Media ingest body limit');chunks.push(value);}
            const text=new TextDecoder().decode(Buffer.concat(chunks));return kind==='json'?JSON.parse(text):text;
        })()]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);controller.abort();void reader?.cancel().catch(()=>{});}
    }

    async fetchWithTimeout(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            return await this.fetchImplementation(url, { ...options, signal: controller.signal });
        } finally { clearTimeout(timer); }
    }

    errorStatus(safe) { return this.status(safe, "error", false, false, null); }
    status(safe, state, publisherPresent, hlsAvailable, lastSeenAt) {
        return Object.freeze({ ...safe, state, lastSeenAt,
            health: Object.freeze({ publisherPresent, hlsAvailable }) });
    }
}

function validTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
