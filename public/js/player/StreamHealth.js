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

        return {

    online:
        !this.video.paused &&
        !this.video.ended,

    currentTime:
        this.video.currentTime,

    duration:
        Number.isFinite(this.video.duration)
            ? Number(this.video.duration.toFixed(2))
            : 0,

    buffer:
        Number(buffer.toFixed(2)),

    readyState:
        this.video.readyState,

    networkState:
        this.video.networkState,

    paused:
        this.video.paused,

    ended:
        this.video.ended,

    muted:
        this.video.muted,

    volume:
        Number(this.video.volume.toFixed(2)),

    playbackRate:
        this.video.playbackRate,

    seeking:
        this.video.seeking,
videoWidth:
    this.video.videoWidth,

videoHeight:
    this.video.videoHeight,

duration:
    Number.isFinite(this.video.duration)
        ? Number(this.video.duration.toFixed(2))
        : 0,

isLive:
    this.video.duration === Infinity,

playbackRate:
    this.video.playbackRate,

seeking:
    this.video.seeking,

muted:
    this.video.muted,

volume:
    Number(this.video.volume.toFixed(2)),
   
    videoWidth:
    this.video.videoWidth,

videoHeight:
    this.video.videoHeight,

aspectRatio:
    this.video.videoWidth && this.video.videoHeight
        ? Number(
            (
                this.video.videoWidth /
                this.video.videoHeight
            ).toFixed(3)
        )
        : 0,

hasVideo:
    this.video.videoWidth > 0,

isLive:
    this.video.duration === Infinity,

hasAudio:
    typeof this.video.mozHasAudio === "boolean"
        ? this.video.mozHasAudio
        : (
            this.video.audioTracks
                ? this.video.audioTracks.length > 0
                : true
        )
        

};

    }

}