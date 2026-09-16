const ENTRY_MS=30000;
const LOSS_MS=15000;

export default class AutoLiveDecisionShadow {
    constructor({clock=()=>Date.now()}={}){this.clock=clock;this.reset();}
    reset(){this.identity=null;this.onlineSince=null;this.lossSince=null;this.entryEligible=false;this.liveObserved=false;this.lossEligible=false;}
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
            if(online){if(this.onlineSince===null)this.onlineSince=now;this.entryEligible=now-this.onlineSince>=ENTRY_MS;}
            else if(offline){this.onlineSince=null;this.entryEligible=false;}
            return this.snapshot(now,this.entryEligible?'ENTRY_ELIGIBLE':online?'ENTRY_PENDING':'WAITING_HEALTH');
        }
        if(online){this.lossSince=null;this.lossEligible=false;return this.snapshot(now,'LIVE_OBSERVED');}
        if(offline){if(this.lossSince===null)this.lossSince=now;this.lossEligible=now-this.lossSince>LOSS_MS;
            return this.snapshot(now,this.lossEligible?'LOSS_ELIGIBLE':'LOSS_PENDING');}
        return this.snapshot(now,'LIVE_UNCERTAIN');
    }
    snapshot(now,state){return Object.freeze({version:1,state,sourceFingerprint:this.identity?.split(':').slice(1).join(':')||null,
        entryHealthyMs:this.onlineSince===null?0:Math.max(0,now-this.onlineSince),entryEligible:this.entryEligible,
        lossMs:this.lossSince===null?0:Math.max(0,now-this.lossSince),lossEligible:this.lossEligible,
        liveObserved:this.liveObserved,executionAllowed:false,serverTake:false});}
}

export {ENTRY_MS,LOSS_MS};
