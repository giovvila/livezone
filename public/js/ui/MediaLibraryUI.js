import {REFERENCE_AUTHORITY_CHANGED} from '../media-library/ReferenceAuthorityNotifications.js';
export default class MediaLibraryUI {
    constructor(root, manager, { storage, storageKey='livezone.control.mediaLibrary.collapsed.v1', defaultCollapsed=false, collapseTarget=null, onSelectAsset=null, manageCollapse=true } = {}) { Object.assign(this,{storageKey,defaultCollapsed,collapseTarget,onSelectAsset,manageCollapse});this.root = root; this.manager = manager; this.storage = storage === undefined ? this.getStorage() : storage; this.collapsed = false; this.handleFile = this.handleFile.bind(this); this.handleFilter = this.handleFilter.bind(this); this.handleToggle = this.handleToggle.bind(this); this.render = this.render.bind(this); }
    start() {
        if (!this.root || !this.manager || this.started) return false;
        this.input = this.root.querySelector("#media-library-input"); this.filter = this.root.querySelector("#media-library-filter"); this.list = this.root.querySelector("#media-library-list"); this.status = this.root.querySelector("#media-library-status"); this.toggle = this.root.querySelector("#media-library-toggle");
        if (!this.input || !this.filter || !this.list || !this.status || !this.toggle) return false;
        this.collapsed = this.loadCollapsed();
        const ownerDocument = this.root.ownerDocument || globalThis.document;
        if (ownerDocument) {
            this.authorityStatus=ownerDocument.createElement('p');this.authorityStatus.className='media-library-authority-status';this.authorityDetails=ownerDocument.createElement('details');this.authorityDetails.className='operator-diagnostics media-library-reference-details';
            const summary=ownerDocument.createElement('summary');summary.textContent='DETTAGLI TECNICI MEDIA LIBRARY';
            this.authorityReasons=ownerDocument.createElement('pre');
            this.authorityDetails.append(summary,this.authorityStatus,this.authorityReasons);
            this.authorityNotice=ownerDocument.createElement('p');this.authorityNotice.className='media-library-reference-notice';this.authorityNotice.setAttribute('role','status');
            this.status.after(this.authorityNotice,this.authorityDetails);
            this.usageFilter = ownerDocument.createElement('select'); this.usageFilter.setAttribute('aria-label', 'Media usage');
            for (const value of ['ALL','USED','UNUSED','UNKNOWN']) { const option=ownerDocument.createElement('option'); option.value=value; option.textContent=value; this.usageFilter.append(option); }
            this.filter.after(this.usageFilter); this.usageFilter.addEventListener('change', this.handleFilter);
        }
        this.input.addEventListener("change", this.handleFile); this.filter.addEventListener("change", this.handleFilter); if(this.manageCollapse)this.toggle.addEventListener("click", this.handleToggle);
        if(this.manageCollapse)this.applyCollapsed();
        this.refresh=()=>void this.refreshAuthority();
        this.authorityTarget=ownerDocument?.defaultView||globalThis;
        this.authorityTarget.addEventListener?.(REFERENCE_AUTHORITY_CHANGED,this.refresh);
        this.refreshButton=this.root.querySelector('#media-library-refresh');this.refreshButton?.addEventListener('click',this.refresh);
        this.focus=()=>this.refresh();globalThis.addEventListener?.('focus',this.focus);
        this.channel=globalThis.window?.BroadcastChannel?new window.BroadcastChannel('livezone.media-library.changed.v1'):null;
        if(this.channel)this.channel.onmessage=this.refresh;
        this.unsubscribe = this.manager.subscribe(this.render); this.started = true;
        // Control loads the library before catalog, logo and Preview adoption.
        // initialize() is memoized, so its old audit cannot serve as the UI boot audit.
        void this.manager.initialize().then(()=>this.refreshAuthority()).catch(() => {}); return true;
    }
    async refreshAuthority(){
        if(!this.started)return;
        if(this.authorityRefreshing){this.authorityRefreshAgain=true;return;}
        this.authorityRefreshing=true;
        try{do{this.authorityRefreshAgain=false;await this.manager.refresh().catch(()=>{});}while(this.started&&this.authorityRefreshAgain);}
        finally{this.authorityRefreshing=false;}
    }
    async handleFile() { const file = this.input.files?.[0]; if (!file) return; try { await this.manager.importAsset(file); this.input.value = "";this.channel?.postMessage('changed'); } catch {} }
    handleFilter() { this.render(this.manager.getSnapshot()); }
    handleToggle() { this.collapsed = !this.collapsed; this.persistCollapsed(); this.applyCollapsed(); }
    applyCollapsed() { (this.collapseTarget?this.root.querySelector(this.collapseTarget):this.list).hidden = this.collapsed; this.root.classList.toggle("is-collapsed", this.collapsed); this.toggle.setAttribute("aria-expanded", String(!this.collapsed)); this.toggle.textContent = this.collapsed ? "EXPAND ▼" : "COLLAPSE ▲"; }
    loadCollapsed() { try { const value = this.storage?.getItem(this.storageKey); return value==='true'?true:value==='false'?false:this.defaultCollapsed; } catch { return this.defaultCollapsed; } }
    persistCollapsed() { try { this.storage?.setItem(this.storageKey, String(this.collapsed)); } catch {} }
    getStorage() { try { return globalThis.localStorage; } catch { return null; } }
    render(snapshot) {
        if(this.authorityStatus){
            const inventory=snapshot.inventory;
            if(this.authorityNotice){
                this.authorityNotice.textContent=inventory?.state==='COMPLETE'?'RIFERIMENTI ● VERIFICATI':'RIFERIMENTI ● DA VERIFICARE';
                this.authorityNotice.dataset.referenceState=inventory?.state==='COMPLETE'?'complete':'incomplete';
            }
            if(this.authorityReasons)this.authorityReasons.textContent=JSON.stringify(inventory || {},null,2);
            const reasons=inventory?.reasons||[];
            const messages=[...new Set(reasons.map(referenceReasonMessage))];
            this.authorityStatus.textContent=inventory?.state==='COMPLETE'?'REFERENCE CHECK COMPLETE':'REFERENCE CHECK INCOMPLETE'+(messages.length?' — '+messages.join(' '):'');
        }
        const usage = asset => { const audit=snapshot.audits?.[asset.id]; return audit?.complete===true ? audit.referenceCount>0?'USED':audit.referenceCount===0&&audit.eligible===true?'UNUSED':'UNKNOWN' : 'UNKNOWN'; };
        const assets = snapshot.assets.filter((asset) => (!this.filter.value || asset.kind === this.filter.value) &&
            (!this.usageFilter || this.usageFilter.value==='ALL' || usage(asset)===this.usageFilter.value));
        this.status.textContent = snapshot.state === "uploading" ? `IMPORTING${snapshot.progress?.percent === null ? "" : ` · ${snapshot.progress?.percent}%`}` : snapshot.error ? `${snapshot.error.code} · ${snapshot.error.message}` : `${assets.length} ASSET${assets.length === 1 ? "" : "S"}`;
        this.list.replaceChildren(...assets.map((asset) => {
            const item = document.createElement("li"); item.className = "media-library-item";
            const title = document.createElement("strong"); title.textContent = asset.originalName;
            const meta = document.createElement("span"); meta.textContent = `${asset.kind.toUpperCase()} · ${asset.mimeType} · ${this.formatBytes(asset.size)}`;
            const id = document.createElement("code"); id.textContent = asset.id;
            const badge=document.createElement('span');badge.className='media-library-usage';badge.textContent=usage(asset);
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "media-library-item__delete"; remove.textContent = "DELETE / REMOVE"; remove.disabled = snapshot.state==='deleting'; remove.title = "Verifica utilizzi prima dell’eliminazione.";
            remove.addEventListener('click',()=>void this.reviewDelete(asset));
            item.append(title, meta, id, badge);
            if(usage(asset)==='UNKNOWN'){
                const message=document.createElement('span');message.textContent='Impossibile verificare tutti i riferimenti del media.';badge.title=message.textContent;item.append(message);
            }else{if(usage(asset)==='USED')remove.textContent='UTILIZZI';item.append(remove);}
            if(this.onSelectAsset&&asset.kind==='image'){
                const image=document.createElement('img');image.src=asset.url;image.alt=asset.originalName;image.loading='lazy';image.className='schedule-sponsor-thumbnail';item.prepend(image);
                const select=document.createElement('button');select.type='button';select.textContent='USA COME SPONSOR';select.addEventListener('click',()=>this.onSelectAsset(asset));item.append(select);
            }
            return item;
        }));
    }
    formatBytes(value) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 ** 2).toFixed(1)} MiB`; }
    async reviewDelete(asset) {
        this.deleteDialog?.remove();
        const root=document.createElement('div');root.className='media-library-picker';
        const dialog=document.createElement('div');dialog.className='media-library-picker__dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Eliminazione media');
        const title=document.createElement('h3');title.textContent='Eliminare definitivamente questo media?';
        const name=document.createElement('p');name.textContent=`${asset.originalName} · ${asset.kind.toUpperCase()} · ${this.formatBytes(asset.size)}`;
        const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Verifica utilizzi…';
        const list=document.createElement('ul'),confirm=document.createElement('button'),cancel=document.createElement('button');
        confirm.type=cancel.type='button';confirm.textContent='ELIMINA DEFINITIVAMENTE';confirm.disabled=true;cancel.textContent='ANNULLA';
        dialog.append(title,name);
        if(asset.kind==='image'){const image=document.createElement('img');image.src=asset.url;image.alt=asset.originalName;Object.assign(image.style,{maxWidth:'120px',maxHeight:'100px',objectFit:'contain'});dialog.append(image);}
        dialog.append(status,list,confirm,cancel);root.append(dialog);document.body.append(root);this.deleteDialog=root;
        const close=()=>{root.remove();if(this.deleteDialog===root)this.deleteDialog=null;};cancel.addEventListener('click',close);root.addEventListener('keydown',event=>{if(event.key==='Escape'&&!cancel.disabled)close();});cancel.focus();
        const describe=audit=>{list.replaceChildren();for(const ref of audit?.references||[]){const li=document.createElement('li');li.textContent=`${ref.type}: ${ref.name}`;list.append(li);}for(const name of audit?.unavailable||[]){const li=document.createElement('li');li.textContent='Audit incompleto: '+name;list.append(li);}};
        try {
            const audit=await this.manager.auditDelete(asset.id);if(this.deleteDialog!==root)return;
            describe(audit);confirm.disabled=!audit.eligible;status.textContent=audit.eligible?'Nessun riferimento. Operazione definitiva.':'IMPOSSIBILE ELIMINARE — Media utilizzato o inventario incompleto.';
        }catch{status.textContent='IMPOSSIBILE ELIMINARE — Audit non disponibile.';}
        confirm.addEventListener('click',async()=>{
            if(confirm.disabled)return;confirm.disabled=true;cancel.disabled=true;
            try{await this.manager.deleteAsset(asset.id);this.channel?.postMessage('changed');close();}
            catch(error){status.textContent='IMPOSSIBILE ELIMINARE — '+(error.code||'Errore');describe(error.details);cancel.disabled=false;}
        });
    }
    destroy() { this.authorityTarget?.removeEventListener?.(REFERENCE_AUTHORITY_CHANGED,this.refresh);this.authorityDetails?.remove();this.authorityNotice?.remove();this.authorityStatus?.remove(); this.usageFilter?.removeEventListener('change',this.handleFilter);this.usageFilter?.remove();this.deleteDialog?.remove();this.deleteDialog=null;this.channel?.close();globalThis.removeEventListener?.('focus',this.focus);this.refreshButton?.removeEventListener('click',this.refresh);this.unsubscribe?.(); this.unsubscribe = null; this.input?.removeEventListener("change", this.handleFile); this.filter?.removeEventListener("change", this.handleFilter); this.toggle?.removeEventListener("click", this.handleToggle); this.started = false; }
}

export function referenceReasonMessage(reason){
    const exact={
        LEGACY_CATALOG_PENDING:'A registered Studio client has not acknowledged its catalog.',
        LEGACY_CATALOG_CONFLICT:'Studio client revision/content conflict requires resolution.',
        LEGACY_CATALOG_INVALID:'A Studio client reported an invalid or conflicting catalog.',
        LEGACY_ALIASES_UNCONFIRMED:'A registered Studio client has not confirmed its asset aliases.',
        CLIENT_CAPABILITY_UNKNOWN:'A registered client connection is unconfirmed; current clients may already be reconciled.',
        AUTHENTICATED_CLIENT_UNCONFIRMED:'An authenticated session has no confirmed client.',
        CLIENT_CENSUS_RECONNECT_REQUIRED:'Clients have not confirmed this server session.'
    };
    return exact[reason]||(/CLIENT|CAPABILITY/.test(reason)?'Legacy client participation has not been resolved.':
        /Preview/i.test(reason)?'Preview ownership cannot currently be verified.':
        /Logo/i.test(reason)?'Channel Logo change awaits confirmation.':
        /CATALOG|ALIASES|Studio/.test(reason)?'Studio catalog reconciliation is required.':'An asset reference could not be verified.');
}
