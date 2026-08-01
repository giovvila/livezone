import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import BroadcastState from "./BroadcastState.js";

export default class BroadcastController{
constructor(){
this.state=BroadcastState.INIT;
this.onReady=this.onReady.bind(this);
this.onBuffering=this.onBuffering.bind(this);
this.onReconnect=this.onReconnect.bind(this);
this.onOffline=this.onOffline.bind(this);
this.onError=this.onError.bind(this);
}
start(){
EventBus.on(Events.STREAM_READY,this.onReady);
EventBus.on(Events.STREAM_BUFFERING,this.onBuffering);
EventBus.on(Events.STREAM_RECONNECT,this.onReconnect);
EventBus.on(Events.STREAM_OFFLINE,this.onOffline);
EventBus.on(Events.STREAM_ERROR,this.onError);
}
destroy(){
EventBus.off(Events.STREAM_READY,this.onReady);
EventBus.off(Events.STREAM_BUFFERING,this.onBuffering);
EventBus.off(Events.STREAM_RECONNECT,this.onReconnect);
EventBus.off(Events.STREAM_OFFLINE,this.onOffline);
EventBus.off(Events.STREAM_ERROR,this.onError);
}
setState(s){this.state=s;}
getState(){return this.state;}
isOnline(){return this.state===BroadcastState.ONLINE;}
onReady(){this.setState(BroadcastState.ONLINE);}
onBuffering(){this.setState(BroadcastState.BUFFERING);}
onReconnect(){this.setState(BroadcastState.CONNECTING);}
onOffline(){this.setState(BroadcastState.OFFLINE);}
onError(){this.setState(BroadcastState.ERROR);}
}
