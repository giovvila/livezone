import {randomUUID} from 'node:crypto';
import {createProgramOutputEnvelope} from '../../public/js/program-output/ProgramOutputEnvelope.js';
import {AUTO_LIVE_ENTRY_ID} from '../../public/js/program-output/AutoLiveEntrySlate.js';
import {AUTO_LIVE_LOSS_SLATE_ID} from '../../public/js/program-output/AutoLiveLossSlate.js';
import ScheduleDiagnostics from '../scheduler/ScheduleDiagnostics.js';
import {statSync} from 'node:fs';

// Sole merge owner. Control revisions are accepted by the ingress store unchanged.
// Only the outward composite has an independent server revision.
export default class EffectiveProgramOutput {
    constructor({store,scheduler,clock=()=>Date.now(),mediaAssetRepository}) {
        Object.assign(this,{store,scheduler,clock,mediaAssetRepository});this.sessionId=randomUUID();this.revision=0;
        this.listeners=new Set();this.current=null;this.projecting=false;
        this.diagnostics=new ScheduleDiagnostics({clock});
        this.offStore=store.subscribe(()=>this.reconcile());
        this.offSchedule=scheduler.subscribe(()=>this.reconcile());
        void scheduler.ready.then(()=>this.reconcile(),()=>this.reconcile());
    }
    reconcile(){
        if(this.closed)return;
        const raw=this.store.getCurrent();
        let winner=null,sponsor=null;
        try { const active=this.scheduler.runtime.getSnapshot()?.activeEvents||[];
            winner=active.find(e=>e.type==='overlay.crawl');sponsor=active.find(e=>e.type==='overlay.sponsor'); }
        catch { this.diagnostics.record('PROGRAM_EFFECTIVE_VALIDATION'); }
        this.effectiveCrawl=winner||null;
        this.effectiveSponsor=sponsor||null;
        const overlayKey=JSON.stringify([winner,sponsor]);
        if(overlayKey!==this.overlayKey){
            this.overlayKey=overlayKey;
            this.diagnostics.record('EFFECTIVE_OVERLAY_CHANGED');
            if(winner)this.diagnostics.record('SCHEDULE_CRAWL_ACTIVE');
        }
        const available=!!(raw?.snapshot.scene&&raw?.snapshot.source);
        if(available!==this.baseAvailable){this.baseAvailable=available;
            this.diagnostics.record(available?'PROGRAM_BASE_AVAILABLE':'PROGRAM_BASE_MISSING');}
        // The scheduler retains overlay authority, never invents a media publisher.
        if(!available){const changed=this.current!==raw;this.current=raw;this.fingerprint=null;if(raw&&changed)this.emit();return;}
        if(winner||sponsor)this.projecting=true;
        if(!this.projecting){const changed=this.current!==raw;this.current=raw;if(changed)this.emit();return;}
        const base=raw.snapshot;
        let overlays;
        try {
        const manual=base.overlays?.textCrawl;
        const suppressed=base.source?.id===AUTO_LIVE_ENTRY_ID||base.scene?.id===AUTO_LIVE_ENTRY_ID||base.graphics.items.some(g=>g.id===AUTO_LIVE_LOSS_SLATE_ID);
        const scheduled=winner?{enabled:!suppressed,mode:'crawl',text:winner.payload.text,
            position:winner.payload.position,direction:winner.payload.direction,speed:winner.payload.speed,
            background:winner.payload.background,scheduled:{eventId:winner.id,startAt:winner.startAt,endAt:winner.endAt}}:null;
        const effective=suppressed ? (scheduled||manual ? {...(scheduled||manual),enabled:false} : null) : manual?.enabled?manual:scheduled||manual;
        overlays={...(base.overlays||{})};if(effective)overlays.textCrawl=effective;else delete overlays.textCrawl;
        } catch { overlays=base.overlays; }
        overlays={...(overlays||{})};
        let sponsorStatus=sponsor?'SPONSOR_ASSET_MISSING':'SPONSOR_INACTIVE';
        try {
            const asset=sponsor && this.mediaAssetRepository?.get(sponsor.payload.assetId);
            const suppressed=base.source?.id===AUTO_LIVE_ENTRY_ID||base.scene?.id===AUTO_LIVE_ENTRY_ID||base.graphics.items.some(g=>g.id===AUTO_LIVE_LOSS_SLATE_ID);
            const fileAvailable=!asset||!this.mediaAssetRepository?.safeFilePath || statSync(this.mediaAssetRepository.safeFilePath(asset.kind,asset.storedName)).isFile();
            if(asset?.kind==='image'&&fileAvailable) {
                const candidate={enabled:!suppressed,url:asset.url,
                layout:sponsor.payload.layout||'CORNER',
                ...(sponsor.payload.layout==='FULLSCREEN'?{fit:sponsor.payload.fit}:{position:sponsor.payload.position,sizePercent:sponsor.payload.sizePercent}),opacity:sponsor.payload.opacity,
                scheduled:{eventId:sponsor.id,startAt:sponsor.startAt,endAt:sponsor.endAt}};
                // Validate this optional layer alone. A bad sponsor must not discard a valid crawl.
                if(createProgramOutputEnvelope({...base,overlays:{sponsor:candidate}})) {
                    overlays.sponsor=candidate;sponsorStatus=suppressed?'SPONSOR_SUPPRESSED':'SPONSOR_PROJECTED';
                } else {delete overlays.sponsor;sponsorStatus='SPONSOR_ASSET_INVALID';}
            } else {delete overlays.sponsor;if(asset)sponsorStatus='SPONSOR_ASSET_INVALID';}
        } catch { delete overlays.sponsor;sponsorStatus='SPONSOR_ASSET_UNAVAILABLE'; }
        if(sponsorStatus!==this.sponsorStatus){this.sponsorStatus=sponsorStatus;this.diagnostics.record(sponsorStatus);}
        const fingerprint=JSON.stringify([raw,overlays]);if(fingerprint===this.fingerprint)return;
        this.fingerprint=fingerprint;
        this.diagnostics.record('PROGRAM_EFFECTIVE_MERGE');
        const output={version:1,sessionId:this.sessionId,revision:++this.revision,overlayOnly:false};
        this.current=createProgramOutputEnvelope({...base,overlays,output:{version:1,sessionId:this.sessionId,
            revision:this.revision,overlayOnly:false}});
        this.diagnostics.record('PROGRAM_EFFECTIVE_VALIDATION',{revision:this.revision});
        // Invalid optional crawl must never suppress an accepted Program base.
        if(!this.current)this.current=createProgramOutputEnvelope({...base,output});
        this.emit();
    }
    emit(){const current=this.getCurrent();if(current){
        this.diagnostics.record('PROGRAM_EFFECTIVE_PUBLISH',{revision:this.revision});
        for(const fn of this.listeners)try{fn(current);}catch{/* Isolate consumers from publisher acceptance. */}
    }}
    getCurrent(){
        if(!this.current?.snapshot.output)return this.current;
        return createProgramOutputEnvelope({...this.current.snapshot,output:{...this.current.snapshot.output,
            serverTime:new Date(this.clock()).toISOString()}});
    }
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    close(){this.closed=true;this.offStore();this.offSchedule();this.listeners.clear();}
}
