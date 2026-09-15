import NetworkProgramOutputTransport from './NetworkProgramOutputTransport.js';
import OutputRevisionGate from './OutputRevisionGate.js';
import trace, {programTraceFields} from '../core/RuntimeTrace.js';
export default class ControlCrawlObserver {
    constructor({layer,transport=new NetworkProgramOutputTransport({role:'subscriber',subscribeUrl:'/api/program-output/events'})}) {
        Object.assign(this,{layer,transport});this.gate=new OutputRevisionGate();
    }
    start(){if(this.off)return;this.off=this.transport.subscribe(snapshot=>{
        if(snapshot.output&&!this.gate.accept(snapshot))return;
        if(snapshot.output?.serverTime && this.layer?.crawlView){
            const offset=Date.parse(snapshot.output.serverTime)-Date.now();
            this.layer.crawlView.now=()=>Date.now()+offset;
            if(this.layer.sponsorView)this.layer.sponsorView.now=()=>Date.now()+offset;
        }
        if(this.layer?.setEffectiveOverlays)this.layer.setEffectiveOverlays(snapshot.overlays||{});
        else this.layer?.setEffectiveCrawl(snapshot.overlays?.textCrawl||null);
        trace.record('control','CONTROL_CRAWL_ACCEPT',programTraceFields(snapshot));
    });this.transport.start();}
    destroy(){this.off?.();this.off=null;this.transport.destroy();}
}
