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
    }

    async connect(video,url){

        this.video=video;
        this.url=url;
        this.destroyed=false;
        this.clearRetry();

        this.state=PlayerState.CONNECTING;
        EventBus.emit(Events.STREAM_RECONNECT);

        if(!window.Hls || !Hls.isSupported()){

            if(video.canPlayType("application/vnd.apple.mpegurl")){
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

        this.hls.loadSource(url);
        this.hls.attachMedia(video);

        this.hls.on(Hls.Events.MANIFEST_PARSED, async () => {

    try {
        await video.play();
    } catch (e) {}

    this.state = PlayerState.CONNECTED;

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

}
