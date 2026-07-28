/*=====================================================

LIVEZONE Broadcast Engine

LifecycleManager.js

Version : 1.0
Build   : 1007.2

=====================================================*/

import EventBus from "./EventBus.js";
import Events from "./Events.js";

import StateManager,{STATES} from "./StateManager.js";

class LifecycleManager{

    constructor(){

        this.initialized=false;

    }

    init(){

        if(this.initialized){

            return;

        }

        this.initialized=true;

        console.log("[Lifecycle] initialized");

        EventBus.on(Events.ENGINE_START,()=>{

            StateManager.setState(STATES.BOOT);

        });

        EventBus.on(Events.CONFIG_LOADED,()=>{

            StateManager.setState(STATES.INIT);

        });

        EventBus.on(Events.UI_READY,()=>{

            console.log("[Lifecycle] UI READY");

        });

        EventBus.on(Events.STREAM_RECONNECT,()=>{

            StateManager.setState(STATES.CONNECTING);

        });

        EventBus.on(Events.STREAM_READY,()=>{

            StateManager.setState(STATES.ONLINE);

        });

        EventBus.on(Events.STREAM_BUFFERING,()=>{

            StateManager.setState(STATES.BUFFERING);

        });

        EventBus.on(Events.STREAM_OFFLINE,()=>{

            StateManager.setState(STATES.OFFLINE);

        });

        EventBus.on(Events.STREAM_ERROR,()=>{

            StateManager.setState(STATES.ERROR);

        });

    }

}

export default new LifecycleManager();