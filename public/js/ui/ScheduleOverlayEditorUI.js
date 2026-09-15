import MediaLibraryPickerUI from './MediaLibraryPickerUI.js';
import {eventMode,eventLabel,overlayFromEditor,overlayToEditor,sponsorAsset} from '../scheduler/ScheduleEventEditorAdapter.js';

export default class ScheduleOverlayEditorUI {
    constructor(workspace) {
        this.workspace=workspace;this.root=workspace.root;this.form=workspace.form;
        this.client=workspace.store.client;this.manager=workspace.mediaLibraryManager;
        this.selector=this.root.querySelector('#schedule-event-type');
        this.generation=0;this.editId=null;
    }
    start() {
        if(!this.selector)return;
        this.program=this.root.querySelector('#schedule-program-fields');
        this.overlay=this.root.querySelector('#schedule-overlay-fields');
        this.crawl=this.root.querySelector('#schedule-crawl-fields');
        this.sponsor=this.root.querySelector('#schedule-sponsor-fields');
        this.pick=this.root.querySelector('#schedule-sponsor-pick');
        // Reuse the library picker, restricted to runtime-supported managed images.
        this.picker=new MediaLibraryPickerUI({listAssets:()=>this.manager?.listAssets({kind:'image'}).filter(sponsorAsset)||[],getAsset:id=>this.manager?.getAsset(id)});
        this.picker.start();
        this.change=()=>this.setMode(this.selector.value);
        this.choose=()=>void this.chooseAsset();
        this.selector.addEventListener('change',this.change);this.pick.addEventListener('click',this.choose);
        this.layoutChange=()=>this.applyState();
        this.form.elements.sponsorLayout?.addEventListener('change',this.layoutChange);
        this.applyState();
    }
    get mode(){return this.selector?.value||'PROGRAMMA';}
    setMode(mode='PROGRAMMA') {
        ++this.generation;this.picker?.finish(null);this.editId=null;
        ++this.workspace.durationProbeGeneration;
        this.workspace.autoPrefilledValue=null;
        this.workspace.editingId=null;this.workspace.editingLegacySceneId=false;
        this.form.reset();this.selector.value=mode;
        this.form.elements.sponsorAssetId.value='';
        this.form.elements.date.value=this.workspace.selectedDate||'';
        this.form.elements.overlayDate.value=this.workspace.selectedDate||'';
        this.workspace.updateEditorState();this.applyState();this.renderAsset();
        this.workspace.showFeedback('',false);
    }
    applyState() {
        if(!this.selector)return;
        const writable=this.workspace.store.writable && !this.workspace.readOnly && !this.busy;
        this.program.hidden=this.mode!=='PROGRAMMA';this.program.disabled=!writable||this.program.hidden;
        this.overlay.hidden=this.mode==='PROGRAMMA';this.overlay.disabled=!writable||this.overlay.hidden;
        this.crawl.hidden=this.mode!=='CRAWL';this.crawl.disabled=this.crawl.hidden||!writable;
        this.sponsor.hidden=this.mode!=='SPONSOR';this.sponsor.disabled=this.sponsor.hidden||!writable;
        const fullscreen=this.form.elements.sponsorLayout?.value==='FULLSCREEN';
        for(const [selector,hidden] of [['[data-sponsor-corner]',fullscreen],['[data-sponsor-fit]',!fullscreen]])this.sponsor.querySelectorAll(selector).forEach(label=>{label.hidden=hidden;label.querySelectorAll('input,select').forEach(input=>{input.disabled=hidden||!writable;});});
        this.selector.disabled=!writable;
        this.form.querySelectorAll('.schedule-form-actions button').forEach(node=>{node.disabled=!writable;});
        this.root.querySelector('[data-overlay-timezone]').textContent=this.workspace.schedule?.timezone||'Europe/Rome';
        if(!writable)this.picker?.finish(null);
    }
    async chooseAsset() {
        if(!this.client?.writable||this.mode!=='SPONSOR')return;
        const generation=this.generation;
        try {
            await this.manager.refresh();
            if(generation!==this.generation||!this.client.writable||this.mode!=='SPONSOR')return;
            const asset=await this.picker.choose({kind:'image',selectedId:this.form.elements.sponsorAssetId.value});
            if(asset&&generation===this.generation&&this.client.writable&&this.mode==='SPONSOR') {
                this.form.elements.sponsorAssetId.value=asset.id;this.renderAsset();
            }
        } catch {this.workspace.showFeedback('Media Library non disponibile. Riprovare.',true);}
    }
    renderAsset() {
        const asset=this.manager?.getAsset(this.form.elements.sponsorAssetId.value);
        const image=this.root.querySelector('#schedule-sponsor-thumbnail');
        image.hidden=!sponsorAsset(asset);
        if(!image.hidden)image.src=asset.url;else image.removeAttribute('src');
        this.root.querySelector('#schedule-sponsor-asset-name').textContent=asset?.originalName||'Nessuna immagine selezionata';
    }
    useAsset(asset) {
        if(!this.client?.writable||this.busy||!sponsorAsset(asset))return;
        if(this.mode!=='SPONSOR')this.setMode('SPONSOR');
        this.form.elements.sponsorAssetId.value=asset.id;this.renderAsset();this.selector.focus();
    }
    async save() {
        if(!this.client?.writable||this.busy)return;
        if(this.mode==='SPONSOR') {
            const generation=this.generation;
            this.busy=true;this.applyState();
            try {await this.manager.refresh();}catch{return this.workspace.showFeedback('ASSET NON DISPONIBILE',true);}
            finally{this.busy=false;this.applyState();}
            if(generation!==this.generation||!this.client.writable)return;
            if(!sponsorAsset(this.manager.getAsset(this.form.elements.sponsorAssetId.value)))return this.workspace.showFeedback('ASSET NON DISPONIBILE',true);
        }
        let value;
        try {value=overlayFromEditor(this.mode,new FormData(this.form),{timezone:this.workspace.schedule.timezone,mediaLibraryManager:this.manager});}
        catch(error){return this.workspace.showFeedback(error.message,true);}
        const id=this.editId,mode=this.mode,generation=this.generation;
        await this.mutate(()=>id?this.client.update(id,value):this.client.create({...value,id:'overlay-'+this.workspace.uuidFactory(),version:1}),()=>{
            if(generation===this.generation)this.setMode(mode);
        });
    }
    async mutate(operation,onSuccess=()=>{}) {
        if(!this.client?.writable||this.busy)return;
        this.busy=true;this.applyState();
        try {
            const result=await operation();
            if(result.ok)onSuccess();
            this.workspace.showFeedback(result.ok?'Salvato sul server':['ASSET_UNAVAILABLE','ASSET_TYPE_MISMATCH'].includes(result.code)?'ASSET NON DISPONIBILE':result.code==='REVISION_CONFLICT'?'SCHEDULE CHANGED — REFRESHED. Verificare i valori prima di salvare nuovamente.':'Salvataggio non riuscito.',!result.ok);
            return result;
        } finally {this.busy=false;this.workspace.render();this.applyState();}
    }
    handleListClick(button) {
        const item=this.client?.state.schedule?.events.find(e=>e.id===button.dataset.id);
        if(!item||!this.client.writable||this.busy)return;
        if(button.dataset.action==='edit') {
            this.setMode(eventMode(item));this.editId=item.id;
            for(const [key,value] of Object.entries(overlayToEditor(item,this.workspace.schedule.timezone))) {
                const input=this.form.elements[key];if(typeof value==='boolean')input.checked=value;else input.value=value;
            }
            this.renderAsset();this.applyState();this.workspace.showFeedback('Modifica: '+(item.name||item.id),false);
            this.selector.focus();
        } else void this.mutate(()=>button.dataset.action==='remove'?this.client.delete(item.id):this.client.setEnabled(item.id,!item.enabled),()=>{
            if(button.dataset.action==='remove'&&this.editId===item.id)this.setMode(this.mode);
        });
    }
    dayEvents(metrics) {
        return (this.client?.state.schedule?.events||[]).filter(event=>Date.parse(event.startAt)<metrics.endMs&&Date.parse(event.endAt)>metrics.startMs);
    }
    createItem(item) {
        const row=document.createElement('li');row.className='schedule-item schedule-item--overlay';row.dataset.eventType=eventMode(item);
        const cell=(tag,css,text)=>{const node=document.createElement(tag);node.className=css;node.textContent=text;return node;};
        const time=new Intl.DateTimeFormat('it-IT',{timeZone:this.workspace.schedule.timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(item.startAt));
        const summary=cell('div','schedule-item__program','');summary.append(cell('strong','schedule-item__title',item.name||item.id));
        const status=this.client.state.runtime?.events?.find(e=>e.id===item.id)?.status|| (item.enabled?'ENABLED':'DISABLED');
        summary.append(cell('span','schedule-item__scene',status));
        const actions=cell('div','schedule-item__actions','');
        for(const [action,label] of [['edit','EDIT'],['toggle',item.enabled?'DISABILITA':'ABILITA'],['remove','×']]) {
            const button=cell('button','',label);button.type='button';button.dataset.action=action;button.dataset.id=item.id;button.dataset.overlay='true';button.disabled=!this.client.writable||this.busy;
            actions.append(button);
        }
        row.append(cell('time','schedule-item__start',time),cell('span','schedule-item__duration',((Date.parse(item.endAt)-Date.parse(item.startAt))/1000)+'s'),summary,
            cell('strong','schedule-item__type',eventLabel(item)),cell('span','schedule-item__transition','—'),cell('strong','schedule-item__policy','P '+item.priority),actions);
        return row;
    }
    destroy(){this.form.elements.sponsorLayout?.removeEventListener('change',this.layoutChange);++this.generation;this.selector?.removeEventListener('change',this.change);this.pick?.removeEventListener('click',this.choose);this.picker?.destroy();}
}
