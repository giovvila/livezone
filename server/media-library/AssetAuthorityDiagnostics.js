const EVENTS = new Set(['ASSET_INVENTORY_COMPLETE','ASSET_INVENTORY_INCOMPLETE','LEGACY_CATALOG_FOUND',
    'LEGACY_CATALOG_RECONCILED','CLIENT_CAPABILITY','PREVIEW_OWNERSHIP_ACTIVE',
    'PREVIEW_OWNERSHIP_UNCERTAIN','PREVIEW_OWNERSHIP_RELEASED','DELETE_ELIGIBILITY']);
export default class AssetAuthorityDiagnostics {
    constructor({limit=100,clock=()=>Date.now()}={}) { this.limit=limit;this.clock=clock;this.entries=[]; }
    record(event,{count=0,complete=false}={}) {
        if(!EVENTS.has(event))return;
        this.entries.push(Object.freeze({event,time:this.clock(),count:Number.isSafeInteger(count)?count:0,complete:complete===true}));
        if(this.entries.length>this.limit)this.entries.shift();
    }
    snapshot(){return [...this.entries];}
}
