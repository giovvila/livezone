export default class Player{
 constructor(){this.video=document.getElementById('video');}
 async init(){
  if(!this.video) throw new Error('Video non trovato');
  const url='https://65f16f0fdfc51.streamlock.net/xibilive/livestream/playlist.m3u8';
  if(window.Hls && Hls.isSupported()){
    const hls=new Hls();
    hls.loadSource(url);
    hls.attachMedia(this.video);
    hls.on(Hls.Events.MANIFEST_PARSED,()=>this.video.play().catch(()=>{}));
    hls.on(Hls.Events.ERROR,(e,d)=>console.error('HLS',d));
  }else if(this.video.canPlayType('application/vnd.apple.mpegurl')){
    this.video.src=url;
    this.video.play().catch(()=>{});
  }
 }
}
