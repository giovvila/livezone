import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import ScheduleWorkspacePanels from '../public/js/ui/ScheduleWorkspacePanels.js';
import MediaLibraryUI,{referenceReasonMessage} from '../public/js/ui/MediaLibraryUI.js';
import MediaLibraryManager from '../public/js/media-library/MediaLibraryManager.js';
import ScheduleWorkspaceUI from '../public/js/ui/ScheduleWorkspaceUI.js';
import ReferenceClientRegistry from '../server/media-library/ReferenceClientRegistry.js';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
import AuthoritativeStateRepository from '../server/studio/AuthoritativeStateRepository.js';
import StudioStateCoordinator from '../server/studio/StudioStateCoordinator.js';

const capabilities=['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'];
async function authority(t){
    const root=await mkdtemp(join(tmpdir(),'lz-studio-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const coordinator=new AssetMutationCoordinator(),registry=new ReferenceClientRegistry({coordinator,coverageProven:true,minimumVersion:3,requireEpoch:true});await registry.ready;
    const studio=new StudioStateCoordinator({repository:new AuthoritativeStateRepository({path:join(root,'studio.json')})});await studio.initialize();studio.mutationCoordinator=coordinator;
    const register=(role,resume={})=>registry.register({role,version:3,capabilities,...resume},'test-operator');
    const reconcile=async c=>{
        const result=await studio.reconcileCatalog({version:1,revision:studio.getSnapshot().revision,sources:[],scenes:[]});
        await registry.update(c.clientId,c.generation,{catalog:'RECONCILED'},'test-operator');
        const aliases=await registry.updateLegacy(c.clientId,c.generation,{assets:[],complete:true},'test-operator');
        await registry.confirmLegacy(c.clientId,c.generation,aliases.revision,'test-operator');return result;
    };
    return {registry,studio,register,reconcile};
}
for(const role of ['CONTROL','SCHEDULER']){
    test(role+' current boot reconciles without source or scene edits',async t=>{const h=await authority(t),c=await h.register(role);await h.reconcile(c);assert.equal(h.registry.snapshot().state,'COMPLETE');assert.deepEqual(h.studio.getSnapshot().sources,[]);assert.deepEqual(h.studio.getSnapshot().scenes,[]);});
    test(role+' equal catalog no-op confirms the first reconnect',async t=>{const h=await authority(t),c=await h.register(role);await h.reconcile(c);const revision=h.studio.getSnapshot().revision;
        const next=await h.register(role,{resumeId:c.clientId,resumeGeneration:c.generation,resumeToken:c.resumeToken});assert.equal(h.registry.snapshot().state,'INCOMPLETE');
        assert.equal((await h.reconcile(next)).status,'SAME');assert.equal(h.registry.snapshot().state,'COMPLETE');assert.equal(h.studio.getSnapshot().revision,revision);
    });
    test(role+' positive supersession replaces older generation rather than leaving a veto',async t=>{const h=await authority(t),old=await h.register(role);
        const next=await h.register(role,{resumeId:old.clientId,resumeGeneration:old.generation,resumeToken:old.resumeToken});await h.reconcile(next);
        assert.equal(h.registry.clients.size,1);assert.equal(next.generation,old.generation+1);assert.equal(h.registry.snapshot().state,'COMPLETE');
        await assert.rejects(h.registry.update(old.clientId,old.generation,{catalog:'INVALID'},'test-operator'),{code:'CLIENT_GENERATION_CONFLICT'});
    });
}
test('both current clients confirm one canonical equal catalog',async t=>{const h=await authority(t),control=await h.register('CONTROL'),scheduler=await h.register('SCHEDULER');await h.reconcile(control);assert.equal(h.registry.snapshot().state,'INCOMPLETE');await h.reconcile(scheduler);assert.equal(h.registry.snapshot().state,'COMPLETE');assert.equal(h.studio.getSnapshot().revision,1);});
test('different Scheduler IDs sharing authentication are not proof of supersession',async t=>{const h=await authority(t),old=await h.register('SCHEDULER'),current=await h.register('SCHEDULER');await h.reconcile(current);assert.notEqual(old.clientId,current.clientId);assert.ok(h.registry.snapshot().reasons.includes('LEGACY_CATALOG_PENDING'));assert.equal(h.registry.snapshot().state,'INCOMPLETE');});
test('registered source-editor Scheduler cannot be exempted from catalog reconciliation',async t=>{const h=await authority(t),control=await h.register('CONTROL');await h.reconcile(control);await h.register('SCHEDULER');assert.ok(h.registry.snapshot().reasons.includes('LEGACY_ALIASES_UNCONFIRMED'));});
test('network silence is not positive supersession',async t=>{const h=await authority(t),c=await h.register('SCHEDULER');await h.registry.presence(c.clientId,c.generation,'test-operator',false);assert.ok(h.registry.snapshot().reasons.includes('CLIENT_CAPABILITY_UNKNOWN'));assert.equal(h.registry.clients.get(c.clientId).active,true);});
for(const [reason,pattern] of [['LEGACY_CATALOG_PENDING',/not acknowledged its catalog/],['LEGACY_CATALOG_CONFLICT',/conflict/],['CLIENT_CAPABILITY_UNKNOWN',/current clients may already be reconciled/]])test('precise operator explanation for '+reason,()=>{assert.match(referenceReasonMessage(reason),pattern);assert.doesNotMatch(referenceReasonMessage(reason),/Control\/Scheduler requires reload/);});

async function panel(t,{stored=null}={}){
    const html=await readFile('public/control/schedule/index.html','utf8'),dom=new JSDOM(html,{url:'http://localhost/control/schedule/'});
    const previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:dom.window,document:dom.window.document});
    const storage=dom.window.localStorage;if(stored!==null)storage.setItem('livezone.scheduler.mediaLibrary.collapsed.v1',stored);
    const workspace=document.querySelector('#schedule-workspace'),panels=new ScheduleWorkspacePanels(workspace,{storage});panels.start();
    let assets=[{id:'image-test',originalName:'test.png',kind:'image',mimeType:'image/png',size:8,url:'/test.png'}],imports=0,selected=null;
    const manager=new MediaLibraryManager({list:async()=>({assets,audits:{},inventory:{state:'INCOMPLETE',reasons:['LEGACY_CATALOG_PENDING']}}),import:async file=>{imports++;return {asset:{...assets[0],id:'imported',originalName:file.name}};} });
    const ui=new MediaLibraryUI(document.querySelector('#media-library'),manager,{manageCollapse:false,storage,storageKey:'livezone.scheduler.mediaLibrary.collapsed.v1',defaultCollapsed:true,collapseTarget:'#schedule-media-body',onSelectAsset:asset=>{selected=asset;}});
    const button=document.querySelector('#media-library-toggle'),body=document.querySelector('#schedule-media-body');
    t.after(async()=>{ui.destroy();while(ui.authorityRefreshing)await new Promise(r=>setImmediate(r));panels.destroy();dom.window.close();Object.assign(globalThis,previous);});
    const start=async()=>{ui.start();await manager.initialize();while(ui.authorityRefreshing)await new Promise(r=>setImmediate(r));};
    return {dom,workspace,panels,manager,ui,button,body,storage,start,get imports(){return imports;},get selected(){return selected;}};
}
test('production Scheduler has unique Media Library button and body IDs',async t=>{const h=await panel(t);assert.equal(document.querySelectorAll('#media-library-toggle').length,1);assert.equal(document.querySelectorAll('#schedule-media-body').length,1);assert.equal(h.button.getAttribute('aria-controls'),h.body.id);});
test('Media Library starts collapsed independently of network bootstrap',async t=>{const h=await panel(t);assert.equal(h.body.hidden,true);assert.equal(h.button.getAttribute('aria-expanded'),'false');assert.equal(h.button.textContent,'EXPAND ▼');});
test('EXPAND works before MediaLibraryUI or a network request has started',async t=>{const h=await panel(t);h.button.click();assert.equal(h.body.hidden,false);assert.equal(h.button.getAttribute('aria-expanded'),'true');assert.equal(h.button.textContent,'COLLAPSE ▲');assert.equal(h.body.parentElement.classList.contains('is-collapsed'),false);});
test('late MediaLibraryUI start cannot undo an earlier expansion',async t=>{const h=await panel(t);h.button.click();await h.start();assert.equal(h.body.hidden,false);});
test('one click after full UI boot expands rather than double toggling',async t=>{const h=await panel(t);await h.start();h.button.click();assert.equal(h.body.hidden,false);assert.equal(h.button.getAttribute('aria-expanded'),'true');});
test('COLLAPSE hides body and restores label and aria state',async t=>{const h=await panel(t);await h.start();h.button.click();h.button.click();assert.equal(h.body.hidden,true);assert.equal(h.button.getAttribute('aria-expanded'),'false');assert.equal(h.button.textContent,'EXPAND ▼');});
test('existing persisted expanded preference is preserved',async t=>{const h=await panel(t,{stored:'false'});assert.equal(h.body.hidden,false);await h.start();assert.equal(h.body.hidden,false);});
test('collapse preference uses the existing Scheduler storage key',async t=>{const h=await panel(t);h.button.click();assert.equal(h.storage.getItem('livezone.scheduler.mediaLibrary.collapsed.v1'),'false');h.button.click();assert.equal(h.storage.getItem('livezone.scheduler.mediaLibrary.collapsed.v1'),'true');});
test('restarting panel bindings restores expanded state without duplicate listeners',async t=>{const h=await panel(t);h.button.click();h.panels.destroy();h.panels.start();h.panels.start();assert.equal(h.body.hidden,false);h.button.click();assert.equal(h.body.hidden,true);});
for(const name of ['configured','live'])test(name+' panel remains independent when Media Library expands',async t=>{const h=await panel(t),other=h.workspace.querySelector('[data-schedule-panel='+name+'] [data-panel-body]');h.button.click();assert.equal(other.hidden,true);h.workspace.querySelector('[data-schedule-panel='+name+'] [data-panel-toggle]').click();h.button.click();assert.equal(other.hidden,false);});
test('library refresh/rerender preserves expanded body and filter nodes',async t=>{const h=await panel(t);await h.start();h.button.click();const input=h.ui.input,filter=h.ui.filter;await h.manager.refresh();assert.equal(h.body.hidden,false);assert.equal(h.ui.input,input);assert.equal(h.ui.filter,filter);});
test('media kind filter remains functional after expand',async t=>{const h=await panel(t);await h.start();h.button.click();h.ui.filter.value='audio';h.ui.filter.dispatchEvent(new window.Event('change'));assert.equal(h.ui.list.children.length,0);h.ui.filter.value='image';h.ui.filter.dispatchEvent(new window.Event('change'));assert.equal(h.ui.list.children.length,1);});
test('upload handler remains functional after independent panel expansion',async t=>{const h=await panel(t);await h.start();h.button.click();const file=Object.assign(new Blob(['image']),{name:'new.png'});Object.defineProperty(h.ui.input,'files',{value:[file]});await h.ui.handleFile();assert.equal(h.imports,1);assert.ok(h.manager.getAsset('imported'));assert.equal(h.body.hidden,false);});
test('Sponsor picker image selection remains connected after expand',async t=>{const h=await panel(t);await h.start();h.button.click();const button=[...h.ui.list.querySelectorAll('button')].find(value=>/SPONSOR/.test(value.textContent));assert.ok(button);button.click();assert.equal(h.selected.id,'image-test');assert.equal(h.body.hidden,false);});
test('Scheduler binds panels before authentication and source bootstrap awaits',async()=>{const source=await readFile('public/js/entries/schedule-app.js','utf8');assert.ok(source.indexOf('workspacePanels.start()')<source.indexOf('await requireOperatorSession()'));assert.ok(source.indexOf('referenceClient.close()')<source.indexOf('await initializeScheduleSources'));assert.match(source,/manageCollapse:false/);});

test('real Scheduler SSE handler preserves expanded Media Library and input state',async t=>{
    const h=await panel(t);await h.start();h.button.click();h.ui.filter.value='image';
    const ui={root:h.workspace,store:{serverAuthoritative:true,writable:false,runtime:{events:[]}},selectedDate:'2026-09-14',dateInput:document.querySelector('#schedule-selected-date'),
        form:document.querySelector('#schedule-item-form'),renderScenes(){},renderSourceTargets(){},renderMediaDuration(){},render(){h.ui.render(h.manager.getSnapshot());}};
    for(const revision of [1,2])ScheduleWorkspaceUI.prototype.handleSchedule.call(ui,{schedule:{timezone:'Europe/Rome',items:[]},connection:'online',revision});
    assert.equal(h.body.hidden,false);assert.equal(h.button.disabled,false);assert.equal(h.button.getAttribute('aria-expanded'),'true');assert.equal(h.ui.filter.value,'image');
});
