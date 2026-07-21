/*
====================================================

LIVEZONE Broadcast Engine
OverlayController.js

Version : 1.0
Build   : 1003 DEV

====================================================
*/

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class OverlayController{

    constructor(){

        this.overlay=document.getElementById("overlay");
        this.message=document.getElementById("overlay-message");
        this.countdown=document.getElementById("overlay-countdown");

        this.seconds=5;
        this.timer=null;

        this.bind();

    }

    bind(){

        EventBus.on(
            Events.STREAM_READY,
            ()=>this.hide()
        );

        EventBus.on(
            Events.STREAM_OFFLINE,
            ()=>this.show("Segnale assente")
        );

        EventBus.on(
            Events.STREAM_RECONNECT,
            ()=>this.show("Riconnessione automatica")
        );

        EventBus.on(
            Events.STREAM_ERROR,
            ()=>this.show("Errore stream")
        );

    }

    show(message){

        if(!this.overlay) return;

        if(this.message){

            this.message.textContent=message;

        }

        this.seconds=5;

        this.updateCountdown();

        clearInterval(this.timer);

        this.timer=setInterval(()=>{

            if(this.seconds>0){

                this.seconds--;

                this.updateCountdown();

            }

        },1000);

        this.overlay.classList.add(
            "overlay--visible"
        );

    }

    hide(){

        if(!this.overlay) return;

        clearInterval(this.timer);

        this.overlay.classList.remove(
            "overlay--visible"
        );

    }

    updateCountdown(){

        if(!this.countdown) return;

        const s=String(this.seconds)
            .padStart(2,"0");

        this.countdown.textContent=`00:${s}`;

    }

}