import EventBus from './EventBus.js';
import Events from './Events.js';
import Logger from '../utils/Logger.js';

export default class BroadcastController {
 constructor(){this.state='INIT';this._handlers={ready:()=>this.setState('ONLINE'),offline:()=>this.setState('OFFLINE'),reconnect:()=>this.setState('RECONNECTING'),error:()=>this.setState('ERROR')};}
 start(){EventBus.on(Events.STREAM_READY,this._handlers.ready);EventBus.on(Events.STREAM_OFFLINE,this._handlers.offline);EventBus.on(Events.STREAM_RECONNECT,this._handlers.reconnect);EventBus.on(Events.STREAM_ERROR,this._handlers.error);Logger.info?.('BroadcastController started');}
 destroy(){EventBus.off(Events.STREAM_READY,this._handlers.ready);EventBus.off(Events.STREAM_OFFLINE,this._handlers.offline);EventBus.off(Events.STREAM_RECONNECT,this._handlers.reconnect);EventBus.off(Events.STREAM_ERROR,this._handlers.error);}
 setState(s){if(this.state===s)return;this.state=s;EventBus.emit(Events.BROADCAST_STATE_CHANGED??'BROADCAST_STATE_CHANGED',s);Logger.info?.('Broadcast state: '+s);}
 getState(){return this.state;}
}
