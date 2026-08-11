/**
 * LIVEZONE Broadcast Suite
 * HLSAdapter v1.1
 */
import PlayerState from "./PlayerState.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class HLSAdapter {

    constructor(){
        this.hls=null;
        this.video=null;
        this.url=null;
        this.state=PlayerState.IDLE;
        this.retryDelay=5000;
        this.retryTimer=null;
        this.destroyed=false;
        this.usesNativeHls=false;
        this.streamDiagnostics={type:"UNKNOWN",source:"NONE"};
        this.proMode="NONE";
        this.livePlaylist=false;
        this.hasLoadedMediaFragment=false;
    }

    async connect(video,url){

        this.video=video;
        this.url=url;
        this.destroyed=false;
        this.usesNativeHls=false;
        this.resetStreamDiagnostics();
        this.resetProDiagnostics();
        this.clearRetry();

        this.state=PlayerState.CONNECTING;
        EventBus.emit(Events.STREAM_RECONNECT);

        if(!window.Hls || !Hls.isSupported()){

            if(video.canPlayType("application/vnd.apple.mpegurl")){
                this.usesNativeHls=true;
                this.resetStreamDiagnostics("NATIVE_UNKNOWN");
                this.proMode="NATIVE_HLS";
                video.src=url;
                try{ await video.play(); }catch(e){}

                this.state = PlayerState.CONNECTED;
                //EventBus.emit(Events.STREAM_READY);
                return;
            }

            this.state=PlayerState.ERROR;
            EventBus.emit(Events.STREAM_ERROR,"HLS unsupported");
            return;
        }

        if(this.hls){
            this.hls.destroy();
        }

        this.hls=new Hls({
            enableWorker:true,
            lowLatencyMode:true,
            backBufferLength:90
        });
        this.proMode="HLS_JS";

        this.hls.loadSource(url);
        this.hls.attachMedia(video);

        this.hls.on(Hls.Events.MANIFEST_PARSED, async () => {

    try {
        await video.play();
    } catch (e) {}

    this.state = PlayerState.CONNECTED;

});

        this.hls.on(Hls.Events.LEVEL_LOADED, (event,data) => {
            this.updateStreamDiagnostics(data?.details);
        });

        this.hls.on(Hls.Events.LEVEL_UPDATED, (event,data) => {
            this.updateStreamDiagnostics(data?.details);
        });

        this.hls.on(Hls.Events.FRAG_LOADED, (event,data) => {
            if(data?.frag?.type==="main"){
                this.hasLoadedMediaFragment=true;
            }
        });

        this.hls.on(Hls.Events.ERROR,(event,data)=>{

            if(!data.fatal) return;

            if(data.type===Hls.ErrorTypes.MEDIA_ERROR){
                try{
                    this.hls.recoverMediaError();
                    return;
                }catch(e){}
            }

            this.goOffline();

        });

    }

    goOffline(){

        if(this.destroyed) return;

        this.state=PlayerState.OFFLINE;
        EventBus.emit(Events.STREAM_OFFLINE);

        if(this.hls){
            this.hls.destroy();
            this.hls=null;
        }

        this.scheduleReconnect();

    }

    scheduleReconnect(){

        if(this.retryTimer || this.destroyed) return;

        this.retryTimer=setTimeout(async()=>{

            this.retryTimer=null;

            if(this.destroyed) return;

            await this.connect(this.video,this.url);

        },this.retryDelay);

    }

    clearRetry(){

        if(this.retryTimer){
            clearTimeout(this.retryTimer);
            this.retryTimer=null;
        }

    }

    disconnect(){
        this.destroy();
    }

    destroy(){

        this.destroyed=true;
        this.usesNativeHls=false;
        this.resetStreamDiagnostics();
        this.resetProDiagnostics();
        this.clearRetry();

        if(this.hls){
            this.hls.destroy();
            this.hls=null;
        }

        this.state=PlayerState.DESTROYED;

    }

    isConnected(){
        return this.state===PlayerState.CONNECTED;
    }

    getState(){
        return this.state;
    }

    getStreamDiagnostics(){
        if(this.usesNativeHls && this.video?.duration===Infinity){
            return {type:"LIVE",source:"MEDIA_DURATION"};
        }

        return {...this.streamDiagnostics};
    }

    resetStreamDiagnostics(source="NONE"){
        this.streamDiagnostics={type:"UNKNOWN",source};
    }

    updateStreamDiagnostics(details){
        let type="UNKNOWN";

        this.livePlaylist=details?.live===true;

        if(details?.type==="EVENT"){
            type="EVENT";
        }
        else if(details?.type==="VOD" && details.live===false){
            type="VOD";
        }
        else if(details?.live===true){
            type="LIVE";
        }

        this.streamDiagnostics={type,source:"HLS_LEVEL_DETAILS"};
    }

    getProDiagnostics(){
        return {
            mode:this.getProMode(),
            liveEdge:this.getLiveEdgeDiagnostics(),
            videoFrames:this.getVideoFrameDiagnostics(),
            hlsBandwidth:this.getHlsBandwidthDiagnostics()
        };
    }

    getProMode(){
        if(this.proMode==="HLS_JS" && this.hls){
            return "HLS_JS";
        }

        if(this.proMode==="NATIVE_HLS" && this.usesNativeHls){
            return "NATIVE_HLS";
        }

        return "NONE";
    }

    resetProDiagnostics(){
        this.proMode="NONE";
        this.livePlaylist=false;
        this.hasLoadedMediaFragment=false;
    }

    getLiveEdgeDiagnostics(){
        const unavailable={
            available:false,
            distanceSeconds:null,
            source:"UNAVAILABLE"
        };

        if(!this.isActivelyLive() || !this.video){
            return unavailable;
        }

        const seekable=this.video.seekable;

        if(!seekable || seekable.length===0){
            return unavailable;
        }

        let seekableEnd;

        try{
            seekableEnd=seekable.end(seekable.length-1);
        }catch(e){
            return unavailable;
        }

        const currentTime=this.video.currentTime;

        if(!Number.isFinite(seekableEnd) || !Number.isFinite(currentTime)){
            return unavailable;
        }

        return {
            available:true,
            distanceSeconds:Math.max(0,seekableEnd-currentTime),
            source:"MEDIA_SEEKABLE"
        };
    }

    getVideoFrameDiagnostics(){
        const unavailable={
            available:false,
            droppedVideoFrames:null,
            totalVideoFrames:null,
            source:"UNAVAILABLE"
        };

        if(!this.video || typeof this.video.getVideoPlaybackQuality!=="function"){
            return unavailable;
        }

        const quality=this.video.getVideoPlaybackQuality();
        const droppedVideoFrames=quality?.droppedVideoFrames;
        const totalVideoFrames=quality?.totalVideoFrames;

        if(!Number.isFinite(droppedVideoFrames) || droppedVideoFrames<0 ||
            !Number.isFinite(totalVideoFrames) || totalVideoFrames<0){
            return unavailable;
        }

        return {
            available:true,
            droppedVideoFrames,
            totalVideoFrames,
            source:"VIDEO_PLAYBACK_QUALITY"
        };
    }

    getHlsBandwidthDiagnostics(){
        const bitsPerSecond=this.hls?.bandwidthEstimate;

        if(this.getProMode()!=="HLS_JS" || !this.hasLoadedMediaFragment ||
            !Number.isFinite(bitsPerSecond) || bitsPerSecond<=0){
            return {
                available:false,
                bitsPerSecond:null,
                source:"UNAVAILABLE"
            };
        }

        return {
            available:true,
            bitsPerSecond,
            source:"HLS_BANDWIDTH_ESTIMATE"
        };
    }

    isActivelyLive(){
        return this.getProMode()==="HLS_JS"
            ? this.livePlaylist
            : this.getProMode()==="NATIVE_HLS" && this.video?.duration===Infinity;
    }


    classifyError(error) {
        if (!error) return "UNKNOWN_ERROR";
        if (error.fatal) return "FATAL_ERROR";
        switch (error.type) {
            case "networkError":
                return "NETWORK_ERROR";
            case "mediaError":
                return "MEDIA_ERROR";
            default:
                return "UNKNOWN_ERROR";
        }
    }

}
