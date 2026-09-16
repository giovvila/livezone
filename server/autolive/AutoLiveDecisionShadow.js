const ENTRY_MS=30000;
const LOSS_MS=15000;

export default class AutoLiveDecisionShadow {
    constructor({clock=()=>Date.now()}={}){this.clock=clock;this.reset();}
    reset(){this.identity=null;this.onlineSince=null;this.onlineAccumulated=0;this.lossSince=null;this.lossAccumulated=0;this.entryEligible=false;this.liveObserved=false;this.lossEligible=false;}
    update({enabled=false,armed=false,sourceId=null,sourceFingerprint=null,health=null,browserStage=null}={}){
        const now=this.clock();
        const identity=enabled&&armed&&sourceId&&sourceFingerprint?`${sourceId}:${sourceFingerprint}`:null;
        if(identity!==this.identity){this.reset();this.identity=identity;}
        if(!identity)return this.snapshot(now,'DISARMED');
        const fresh=health?.freshness==='FRESH'&&now<=health.validUntil;
        const online=fresh&&health.state==='ONLINE';
        const offline=fresh&&health.state==='OFFLINE';
        if(browserStage==='LIVE')this.liveObserved=true;
        if(!this.liveObserved){
            if(online){if(this.onlineSince===null)this.onlineSince=now;this.entryEligible=this.entryMs(now)>=ENTRY_MS;}
            else if(offline){this.onlineSince=null;this.onlineAccumulated=0;this.entryEligible=false;}
            else if(this.onlineSince!==null){this.onlineAccumulated+=Math.max(0,now-this.onlineSince);this.onlineSince=null;this.entryEligible=false;}
            return this.snapshot(now,this.entryEligible?'ENTRY_ELIGIBLE':online?'ENTRY_PENDING':'WAITING_HEALTH');
        }
        if(online){this.lossSince=null;this.lossAccumulated=0;this.lossEligible=false;return this.snapshot(now,'LIVE_OBSERVED');}
        if(offline){if(this.lossSince===null)this.lossSince=now;this.lossEligible=this.lossMs(now)>LOSS_MS;
            return this.snapshot(now,this.lossEligible?'LOSS_ELIGIBLE':'LOSS_PENDING');}
        if(this.lossSince!==null){this.lossAccumulated+=Math.max(0,now-this.lossSince);this.lossSince=null;this.lossEligible=false;}
        return this.snapshot(now,'LIVE_UNCERTAIN');
    }
    entryMs(now){return this.onlineAccumulated+(this.onlineSince===null?0:Math.max(0,now-this.onlineSince));}
    lossMs(now){return this.lossAccumulated+(this.lossSince===null?0:Math.max(0,now-this.lossSince));}
    snapshot(now,state){return Object.freeze({version:1,state,sourceFingerprint:this.identity?.split(':').slice(1).join(':')||null,
        entryHealthyMs:this.entryMs(now),entryEligible:this.entryEligible,lossMs:this.lossMs(now),lossEligible:this.lossEligible,
        liveObserved:this.liveObserved,executionAllowed:false,serverTake:false});}
}

export {ENTRY_MS,LOSS_MS};
