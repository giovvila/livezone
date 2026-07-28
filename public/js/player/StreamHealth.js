/*=====================================================

LIVEZONE Broadcast Engine

StreamHealth.js

Version : 1.0
Build   : 1007.4

=====================================================*/

export default class StreamHealth {

    constructor(video){

        this.video=video;

    }

    getStatus(){

        if(!this.video){

            return null;

        }

        let buffer=0;

        if(this.video.buffered.length){

            buffer=

                this.video.buffered.end(

                    this.video.buffered.length-1

                )-this.video.currentTime;

        }

        return{

            online:
                !this.video.paused &&
                !this.video.ended,

            currentTime:
                this.video.currentTime,

            buffer:
                Number(buffer.toFixed(2)),

            readyState:
                this.video.readyState,

            networkState:
                this.video.networkState,

            paused:
                this.video.paused,

            ended:
                this.video.ended

        };

    }

}