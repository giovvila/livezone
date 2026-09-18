const ENTRY_MS=30000;
const LOSS_MS=15000;

export default class AutoLiveDecisionShadow {
    constructor({clock=()=>Date.now()}={}){this.clock=clock;this.reset();}
    reset(){this.identity=null;this.onlineSince=null;this.onlineAccumulated=0;this.lossSince=null;this.lossAccumulated=0;this.entryEligible=false;this.liveObserved=false;this.lossEligible=false;this.lastTransitionAt=null;this.lastTransitionFrom=null;this.lastTransitionTo=null;}
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
    snapshot(now,state){
        if(state!==this.lastState){this.lastTransitionAt=now;this.lastTransitionFrom=this.lastState??null;this.lastTransitionTo=state;this.lastState=state;}
        const readyForEntry=state==='ENTRY_ELIGIBLE'&&this.entryEligible===true&&!this.liveObserved;
        const readyForLoss=state==='LOSS_ELIGIBLE'&&this.lossEligible===true&&this.liveObserved;
        const readinessReason=readyForEntry?'ENTRY_HEALTH_MATURED':readyForLoss?'LOSS_CONFIRMED':
            state==='DISARMED'?'CONSENT_OR_SOURCE_MISSING':state==='WAITING_HEALTH'?'HEALTH_NOT_READY':
            state==='ENTRY_PENDING'?'ENTRY_HEALTH_ACCUMULATING':state==='LIVE_OBSERVED'?'LIVE_HEALTHY':
            state==='LIVE_UNCERTAIN'?'LIVE_HEALTH_UNCERTAIN':state==='LOSS_PENDING'?'LOSS_GRACE_ACCUMULATING':'NOT_READY';
        return Object.freeze({version:1,state,sourceFingerprint:this.identity?.split(':').slice(1).join(':')||null,
        entryHealthyMs:this.entryMs(now),entryEligible:this.entryEligible,lossMs:this.lossMs(now),lossEligible:this.lossEligible,
        liveObserved:this.liveObserved,lastTransitionAt:this.lastTransitionAt,lastTransitionFrom:this.lastTransitionFrom,lastTransitionTo:this.lastTransitionTo,
        readyForEntry,readyForLoss,readinessReason,executionAllowed:false,serverTake:false});}
}

export {ENTRY_MS,LOSS_MS};
