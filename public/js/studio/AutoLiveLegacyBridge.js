import compareHealth from './AutoLiveShadowComparison.js';
// Only accepted server configuration is mirrored. ENTRY/TAKE/return stay legacy.
export default class AutoLiveLegacyBridge {
    constructor({client,config,runtimeState,root=null,lifecycle=globalThis}){
        Object.assign(this,{client,config,runtimeState,root,lifecycle});
        this.legacy={version:1,enabled:runtimeState.load().enabled,armed:config.getSnapshot().armed,
            sourceId:config.getSnapshot().authorizedSourceId};
        this.apply=this.apply.bind(this);this.refresh=()=>void client.refresh();
        config.authorityMutation=patch=>this.mutate({...(Object.hasOwn(patch,'armed')?{armed:patch.armed}:{}),
            ...(Object.hasOwn(patch,'authorizedSourceId')?{sourceId:patch.authorizedSourceId}:{})});
    }
    async start(){
        this.unsubscribe=this.client.subscribe(this.apply);
        this.lifecycle.addEventListener?.('focus',this.refresh);
        if(this.root){
            this.indicator=document.createElement('div');
            this.diagnosticsRoot=this.root.querySelector?.('#autolive-server-diagnostics') || this.root;
            this.notice=document.createElement('div');this.notice.setAttribute('role','status');this.root.append(this.notice);
            this.button=document.createElement('button');this.button.type='button';this.button.textContent='IMPORTA CONFIG AUTOLIVE';
            this.button.addEventListener('click',()=>void this.migrate());this.diagnosticsRoot.append(this.indicator);this.root.append(this.button);
            this.healthIndicator=document.createElement('div');this.diagnosticsRoot.append(this.healthIndicator);
        }
        const ok=await this.client.start();
        if(this.destroyed)return false;
        if(!ok&&!this.accepted){this.runtimeState.serverEnabled=false;this.config.update({armed:false,authorizedSourceId:null},{persist:false});}
        this.render();return ok;
    }
    attachEngine(engine){if(this.destroyed)return;this.engine=engine;this.apply(this.client.state);}
    setShadowProvider(provider){this.shadowProvider=provider;this.compare();}
    setBrowserStageProvider(provider){
        if(this.destroyed)return;
        this.browserStageProvider=provider;
        this.unsubscribeBrowserStage?.();this.unsubscribeBrowserStage=null;
        const source=provider?.();
        const controller=source?.controller;
        if(controller?.subscribe)this.unsubscribeBrowserStage=controller.subscribe(snapshot=>this.reportBrowserStage(snapshot));
        else this.reportBrowserStage(source?.snapshot);
    }
    reportBrowserStage(snapshot){
        if(this.destroyed)return;
        const live=Boolean(snapshot?.session);
        const stage=live?'LIVE':'INACTIVE';
        if(stage===this.lastBrowserStage)return;
        this.lastBrowserStage=stage;
        void this.client.observeBrowserStage?.(stage);
    }
    compare(){
        const sequence=this.comparisonSequence=(this.comparisonSequence||0)+1;
        let browser;try{browser=this.shadowProvider?.();}catch{return;}
        void compareHealth(this.client.state.snapshot?.runtime?.healthObservation,browser).then(value=>{
            if(this.destroyed||sequence!==this.comparisonSequence)return;this.shadowComparison=value;this.render();
        });
    }
    apply(state){
        if(this.destroyed)return;
        const snapshot=state.snapshot;
        if(state.connection==='online'&&snapshot&&!snapshot.migration.pristine){
            const config=snapshot.config;this.accepted=true;
            // Stop the acquisition gate before applying a simultaneous armed change.
            this.runtimeState.serverEnabled=config.enabled;
            if(!config.enabled)this.engine?.stop({persist:false});
            const previous=this.config.getSnapshot();
            if(previous.armed!==config.armed||previous.authorizedSourceId!==config.sourceId)
                this.config.update({armed:config.armed,authorizedSourceId:config.sourceId},{persist:false});
            if(config.enabled)this.engine?.start({persist:false});
        }
        this.compare();this.render();
    }
    async mutate(patch){
        if(this.client.state.snapshot?.migration.pristine){this.feedback='IMPORTAZIONE AUTOLIVE RICHIESTA';
            this.config.lastWrite={ok:false,reason:'MIGRATION_REQUIRED'};this.render();return {ok:false,code:'MIGRATION_REQUIRED'};}
        const result=await this.client.mutate(patch);this.config.lastWrite={ok:result.ok,reason:result.code||'SERVER_ACCEPTED'};
        this.feedback=result.ok?null:result.code;this.render();return result;
    }
    async migrate(){
        const result=await this.client.migrate(this.legacy);this.feedback=result.ok?null:result.code;
        this.config.lastWrite={ok:result.ok,reason:result.code||'MIGRATED'};this.render();return result;
    }
    render(){if(!this.indicator)return;const state=this.client.state;
        this.indicator.textContent=this.feedback || (state.connection!=='online'?'AUTOLIVE SERVER NON DISPONIBILE':
            state.snapshot?.migration.pristine?'CONFIG LEGACY — IMPORTAZIONE ESPLICITA':'Configurazione: server · Esecuzione AutoLive: Control · Decisioni server: osservazione (shadow)');
        if(this.notice) this.notice.textContent=this.feedback ? 'ATTENZIONE · CONFIGURAZIONE NON SALVATA' :
            state.connection!=='online' ? 'ATTENZIONE · SERVER NON DISPONIBILE' :
            state.snapshot?.migration.pristine ? 'IMPORTAZIONE CONFIGURAZIONE RICHIESTA' : '';
        this.button.hidden=!state.snapshot?.migration.pristine;this.button.disabled=state.connection!=='online';
        const runtime=state.snapshot?.runtime;
        const health=runtime?.healthObservation;
        if(this.healthIndicator)this.healthIndicator.textContent=health
            ?`SHADOW HEALTH · ${health.authority} · ${health.state} · LAST CHECK ${new Date(health.observedAt).toISOString()} · ${health.freshness} · ${health.reason} · CAPABILITIES presence=${health.capabilities.presenceEvidence}, playlist=${health.capabilities.playlistProgressEvidence}, segment=${health.capabilities.segmentReachabilityEvidence}, decoder=false`
            :'SHADOW HEALTH · UNKNOWN · NO ACTIVE DEMAND';
        if(this.healthIndicator&&runtime?.decisionMode==='shadow'){
            const at=Number.isFinite(runtime.shadowLastTransitionAt)?new Date(runtime.shadowLastTransitionAt).toISOString():'n/a';
            const diag=runtime.healthDiagnostics;
            const http=diag?.httpStatus?` · HTTP ${diag.httpStatus}${diag.httpStage?`/${diag.httpStage}`:''}`:'';
            const entryPhase=runtime.shadowLiveObserved?'historical':'active';
            this.healthIndicator.textContent+=` · DECISION ${runtime.shadowDecisionState} · TRANSITION ${runtime.shadowLastTransitionFrom??'NONE'}→${runtime.shadowLastTransitionTo??runtime.shadowDecisionState} @ ${at} · entry=${runtime.shadowEntryHealthyMs}ms (${entryPhase}) eligible=${runtime.shadowEntryEligible} · loss=${runtime.shadowLossMs}ms eligible=${runtime.shadowLossEligible}${http} · READY entry=${runtime.shadowReadyForEntry} loss=${runtime.shadowReadyForLoss} reason=${runtime.shadowReadinessReason} · execution=false`;
        }
        if(this.healthIndicator&&this.shadowComparison){const comparison=this.shadowComparison;
            this.healthIndicator.textContent+=` · COMPARE source=${comparison.sameSource}, endpoint=${comparison.endpointMatch}, state=${comparison.stateAgreement}, deltaMs=${comparison.timestampDeltaMs} · DECODER EQUIVALENCE NOT PROVEN`;}}
    destroy(){this.destroyed=true;this.unsubscribe?.();this.unsubscribeBrowserStage?.();this.lifecycle.removeEventListener?.('focus',this.refresh);this.client.destroy();
        this.notice?.remove();this.indicator?.remove();this.button?.remove();this.healthIndicator?.remove();
        // Keep the write barrier: a retired document must never fall back to local writes.
        this.config.authorityMutation=async()=>({ok:false,code:'AUTOLIVE_UNAVAILABLE'});}
}
