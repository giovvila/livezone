import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import DominantLiveUI from '../public/js/ui/DominantLiveUI.js';
import ScheduleWorkspaceUI from '../public/js/ui/ScheduleWorkspaceUI.js';
import AutoLiveLegacyBridge from '../public/js/studio/AutoLiveLegacyBridge.js';
const html=readFileSync(new URL('../public/control/index.html',import.meta.url),'utf8');
const base={armed:true,authorizedSourceName:'primecast',status:'ARMED — WAITING',phase:'CLOSED',health:'ONLINE',diagnostics:{}};
function fixture(t){
 const dom=new JSDOM(html);const previous=globalThis.document;globalThis.document=dom.window.document;
 t.after(()=>{globalThis.document=previous;dom.window.close();});return dom.window.document;
}
function auto(t){const document=fixture(t),root=document.querySelector('#dominant-live-control');
 const config={setArmed(){},lastWrite:null},controller={subscribe(fn){fn(base);return()=>{};},getSnapshot:()=>base};
 const ui=new DominantLiveUI({root,config,controller});ui.start();t.after(()=>ui.destroy());return {ui,root,config,document};}
for(const [name,patch,label,consent] of [
 ['off',{armed:false},'','OFF'],['waiting',{},'IN ATTESA','ON'],
 ['preparing',{phase:'PREPARING',diagnostics:{entryElapsedMs:18000,entryRequiredMs:30000}},'PREPARAZIONE 18/30','ON'],
 ['live',{phase:'LIVE',session:{},status:'ON AIR'},'LIVE','ON'],
 ['monitor online without ownership',{},'IN ATTESA','ON'],
 ['uncertain',{phase:'LIVE',session:{},health:'CHECKING'},'VERIFICA SEGNALE','ON'],
 ['loss',{phase:'LOSS_GRACE',health:'OFFLINE'},'RECUPERO','ATTENZIONE'],
 ['recovering',{status:'RECOVERING'},'RECUPERO','ATTENZIONE'],
 ['blocked',{status:'ARMED — BLOCKED'},'VERIFICA CONFIGURAZIONE','ATTENZIONE'],
 ['error',{status:'ERROR'},'VERIFICA CONFIGURAZIONE','ATTENZIONE'],
 ['unknown',{status:'NEW_STATE'},'VERIFICA STATO','ATTENZIONE'],
 ['retained',{diagnostics:{retainedAdoption:{state:'BLOCKED',retainedPending:true,reason:'PROGRAM_SOURCE_MISMATCH'}}},'RIPRISTINO IN CORSO','ON'],
 ['scheduler blocked',{status:'WAITING FOR SCHEDULER'},'AUTOLIVE NON CONSENTITO','ATTENZIONE']
]) test('operator AutoLive '+name,t=>{const {ui}=auto(t);ui.render({...base,...patch});assert.equal(ui.status.textContent,label);assert.equal(ui.consent.textContent,consent);});
test('AutoLive diagnostics and accessible progress survive updates without replacing disclosure',t=>{
 const {ui,root,document}=auto(t),details=root.querySelector('details'),summary=details.querySelector('summary');
 assert.equal(details.open,false);details.open=true;summary.focus();
 const diagnostics={entryElapsedMs:18000,entryRequiredMs:30000,retainedAdoption:{reason:'PROGRAM_SOURCE_MISMATCH',sceneId:'scene-uuid',transportSourceId:'source-uuid'}};
 ui.render({...base,phase:'PREPARING',diagnostics});
 assert.equal(details.open,true);assert.equal(document.activeElement,summary);assert.equal(ui.progress.value,18);assert.equal(ui.progress.max,30);
 assert.ok(ui.progress.getAttribute('aria-label'));assert.equal(ui.status.getAttribute('aria-live'),'off');
 assert.match(ui.technical.textContent,/PROGRAM_SOURCE_MISMATCH/);assert.match(ui.technical.textContent,/scene-uuid/);
 assert.doesNotMatch(ui.status.textContent,/uuid|MISMATCH/);assert.equal(root.hasAttribute('aria-live'),false);
});
test('failed save is visible and leaves confirmed switch state intact',async t=>{
 const {ui,config}=auto(t);config.lastWrite={ok:false};await ui.handleChange();
 assert.equal(ui.status.textContent,'CONFIGURAZIONE NON SALVATA');assert.equal(ui.consent.textContent,'ATTENZIONE');assert.equal(ui.toggle.checked,true);
});
function workspace(t,compact=true){const document=fixture(t),root=document.querySelector('#control-schedule-view');if(!compact)root.id='editor';
 const ui=Object.create(ScheduleWorkspaceUI.prototype);
 const events=['ACTIVE','UPCOMING','EXPIRED','DISABLED','SUPPRESSED'].map((status,i)=>({id:'overlay-uuid-'+i,type:'overlay.sponsor',status}));
 Object.assign(ui,{root,store:{serverAuthoritative:true,writable:true,runtime:{events,nextDeadline:1000},client:{state:{schedule:{events:events.map(e=>({...e,name:'Sponsor '+e.status,startAt:'2026-09-19T12:30:00Z'}))}}}},dateInput:{},selectedDate:'2026-09-19',renderScenes(){},renderSourceTargets(){},renderMediaDuration(){},render(){}});
 const update=(connection='online')=>ui.handleSchedule({schedule:{timezone:'Europe/Rome'},connection,revision:30,feedback:null,migration:'LEGACY PRESERVED'});return {ui,update,document,events};}
for(const [connection,label] of [['online','ONLINE'],['loading','CONNESSIONE IN CORSO'],['degraded','RICONNESSIONE'],['unavailable','NON DISPONIBILE']])test('server connection '+connection,t=>{
 const {ui,update}=workspace(t);update(connection);assert.equal(ui.serverConnection.textContent,'SERVER ● '+label);
 assert.doesNotMatch(ui.serverNormal.textContent,/REV|LEGACY|uuid|STANDBY|AUTOLIVE SERVER/);assert.match(ui.serverNormal.textContent,/PROGRAMMAZIONE PROGRAM: SOSPESA/);
});
test('server diagnostics retain all events and remain open; normal overlays are operational only',t=>{
 const {ui,update,document,events}=workspace(t);update();const details=ui.serverDetails,summary=details.querySelector('summary');
 assert.equal(details.open,false);details.open=true;summary.focus();update();
 assert.equal(ui.serverDetails,details);assert.equal(details.open,true);assert.equal(document.activeElement,summary);
 assert.match(ui.serverNormal.textContent,/SPONSOR · Sponsor ACTIVE · ATTIVO/);assert.match(ui.serverNormal.textContent,/PROSSIMO OVERLAY/);
 assert.doesNotMatch(ui.serverNormal.textContent,/EXPIRED|DISABLED|SUPPRESSED|uuid/);
 assert.match(details.textContent,/REV 30/);assert.match(details.textContent,/1970-01-01/);assert.match(details.textContent,/LEGACY PRESERVED/);
 for(const e of events){assert.match(details.textContent,new RegExp(e.id));assert.match(details.textContent,new RegExp(e.status));}
 assert.equal(events.length,5);assert.equal(ui.serverBanner.hasAttribute('role'),false);
 update('degraded');assert.equal(ui.overlayNormal.textContent,'');
});
test('shared schedule editor retains original presentation',t=>{const {ui,update}=workspace(t,false);update();assert.equal(ui.serverDetails,undefined);assert.match(ui.serverBanner.textContent,/REV 30.*PROGRAM EXECUTION SUSPENDED/);assert.equal(ui.serverEvents.children.length,5);});
test('bridge renders technical health inside disclosure and truthful authority labels',async t=>{
 const document=fixture(t),root=document.querySelector('#dominant-live-control');
 const snapshot={migration:{pristine:false},runtime:{},config:{enabled:false,armed:false,sourceId:null}};
 const client={state:{connection:'online',snapshot},subscribe(){return()=>{};},async start(){return true;},destroy(){}};
 const bridge=new AutoLiveLegacyBridge({client,root,config:{getSnapshot:()=>({})},runtimeState:{load:()=>({})},lifecycle:new EventTarget()});
 await bridge.start();t.after(()=>bridge.destroy());
 assert.ok(root.querySelector('details').contains(bridge.healthIndicator));assert.equal(bridge.healthIndicator.hasAttribute('role'),false);
 assert.match(bridge.indicator.textContent,/Configurazione: server.*Esecuzione AutoLive: Control.*osservazione/);
 assert.equal(bridge.notice.textContent,'');client.state.connection='unavailable';bridge.render();assert.match(bridge.notice.textContent,/SERVER NON DISPONIBILE/);
});
test('initial loading and unreachable server display status before any schedule arrives',t=>{
 const {ui}=workspace(t);
 ui.handleSchedule({schedule:null,connection:'loading'});
 assert.equal(ui.serverConnection.textContent,'SERVER ● CONNESSIONE IN CORSO');
 ui.handleSchedule({schedule:null,connection:'unavailable',reason:'AUTH_REQUIRED'});
 assert.equal(ui.serverConnection.textContent,'SERVER ● NON DISPONIBILE');assert.match(ui.serverNotice.textContent,/ACCESSO OPERATORE/);
});
test('server disclosure shares compact component and expands without replacing status',t=>{
 const {ui,update}=workspace(t);update();
 assert.equal(ui.serverDetails.parentElement,ui.serverNormal.parentElement);
 assert.ok(ui.serverComponent.classList.contains('operator-server-component'));
 assert.equal(ui.serverDetails.open,false);ui.serverDetails.open=true;update('degraded');
 assert.equal(ui.serverDetails.open,true);assert.equal(ui.serverConnection.dataset.connection,'degraded');
});
test('Media Library reference summary preserves explanation and blocking import feedback',async t=>{
 const {default:MediaLibraryUI}=await import('../public/js/ui/MediaLibraryUI.js');
 const document=fixture(t);let snapshot={state:'idle',assets:[],inventory:{state:'INCOMPLETE',reasons:['Channel Logo','Preview ownership']},error:null};
 const manager={subscribe(fn){fn(snapshot);return()=>{};},async initialize(){},async refresh(){},getSnapshot:()=>snapshot};
 const ui=new MediaLibraryUI(document.body,manager,{storage:null});assert.equal(ui.start(),true);t.after(()=>ui.destroy());
 const details=ui.authorityDetails,summary=details.querySelector('summary');
 assert.equal(details.open,false);assert.equal(ui.authorityNotice.textContent,'RIFERIMENTI ● DA VERIFICARE');
 assert.match(details.textContent,/Channel Logo change awaits confirmation/);assert.match(details.textContent,/Preview ownership cannot currently be verified/);
 assert.match(ui.authorityReasons.textContent,/Channel Logo/);assert.match(ui.authorityReasons.textContent,/Preview ownership/);
 details.open=true;summary.focus();snapshot={...snapshot,error:{code:'IMPORT_BLOCKED',message:'Import requires confirmation'}};ui.render(snapshot);
 assert.equal(document.activeElement,summary);assert.equal(details.open,true);assert.match(ui.status.textContent,/IMPORT_BLOCKED.*Import requires confirmation/);
 assert.equal(details.contains(ui.status),false);
 ui.render({...snapshot,inventory:{state:'COMPLETE',reasons:[]}});assert.equal(ui.authorityNotice.textContent,'RIFERIMENTI ● VERIFICATI');
});
test('operator visual tone follows established state, not source name or monitor alone',t=>{
 const {ui}=auto(t);ui.render({...base,phase:'LIVE',session:{}});assert.equal(ui.status.dataset.tone,'live');
 ui.render({...base,phase:'PREPARING'});assert.equal(ui.status.dataset.tone,'attention');
 ui.render({...base,phase:'LOSS_GRACE',health:'OFFLINE'});assert.equal(ui.status.dataset.tone,'error');
 ui.render(base);assert.equal(ui.status.dataset.tone,'neutral');
});
