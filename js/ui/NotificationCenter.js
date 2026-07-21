/*export default class NotificationCenter{
  show(message){
    console.log("[NOTIFY]",message);
  }
}*/
/*
====================================================

LIVEZONE Broadcast Engine
NotificationCenter.js

Version : 1.0
Build   : 1003 DEV

====================================================
*/

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class NotificationCenter{

   constructor(){

    this.container = document.getElementById("notification-center");

    if(!this.container){

        this.container = document.createElement("div");

        this.container.id = "notification-center";
        this.container.className = "notification-center";

        document.body.appendChild(this.container);

    }

    this.bind();

}

    bind(){

        EventBus.on(
            Events.STREAM_READY,
            ()=>this.success(
                "LIVEZONE",
                "Stream connesso"
            )
        );

        EventBus.on(
            Events.STREAM_OFFLINE,
            ()=>this.error(
                "LIVEZONE",
                "Segnale assente"
            )
        );

        EventBus.on(
            Events.STREAM_RECONNECT,
            ()=>this.warning(
                "LIVEZONE",
                "Riconnessione..."
            )
        );

    }

    success(title,message){

        this.show(title,message,"success");

    }

    warning(title,message){

        this.show(title,message,"warning");

    }

    error(title,message){

        this.show(title,message,"error");

    }

    show(title,message,type){

        const toast=document.createElement("div");

        toast.className=`notification notification--${type}`;

        toast.innerHTML=`

            <div class="notification__title">

                ${title}

            </div>

            <div class="notification__message">

                ${message}

            </div>

        `;

        this.container.appendChild(toast);
        console.log("Container:", this.container);
        console.log("Toast:", toast);
        console.log("Parent:", toast.parentElement);

        requestAnimationFrame(()=>{

            toast.classList.add("notification--visible");

        });

        setTimeout(()=>{

            toast.classList.remove("notification--visible");

            setTimeout(()=>{

                toast.remove();

            },350);

        },3000);

    }

}