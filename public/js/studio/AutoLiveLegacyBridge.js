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
            this.indicator=document.createElement('div');this.indicator.setAttribute('role','status');
            this.button=document.createElement('button');this.button.type='button';this.button.textContent='IMPORTA CONFIG AUTOLIVE';
            this.button.addEventListener('click',()=>void this.migrate());this.root.append(this.indicator,this.button);
        }
        const ok=await this.client.start();
        if(this.destroyed)return false;
        if(!ok&&!this.accepted){this.runtimeState.serverEnabled=false;this.config.update({armed:false,authorizedSourceId:null},{persist:false});}
        this.render();return ok;
    }
    attachEngine(engine){if(this.destroyed)return;this.engine=engine;this.apply(this.client.state);}
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
        this.render();
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
            state.snapshot?.migration.pristine?'CONFIG LEGACY — IMPORTAZIONE ESPLICITA':'CONFIG SERVER · ESECUZIONE CONTROL');
        this.button.hidden=!state.snapshot?.migration.pristine;this.button.disabled=state.connection!=='online';}
    destroy(){this.destroyed=true;this.unsubscribe?.();this.lifecycle.removeEventListener?.('focus',this.refresh);this.client.destroy();
        this.indicator?.remove();this.button?.remove();
        // Keep the write barrier: a retired document must never fall back to local writes.
        this.config.authorityMutation=async()=>({ok:false,code:'AUTOLIVE_UNAVAILABLE'});}
}
