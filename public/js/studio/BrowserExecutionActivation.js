import {restoreRetainedProgramIdentity,programPlaybackContinuity} from './ProgramPlaybackContinuity.js';

// Bind the grant's snapshot before allowing automatic output. A retained LIVE's
// initial CHECKING replay is bootstrap, not evidence that Program was lost.
export async function activateBrowserExecution({owner,current,controller,output,renderer,stateManager,catalog,sourceManager}) {
 if(!owner.valid())return false;
 const lease=owner.grant?.leaseId;
 const trustedDurable=value=>owner.trustsDurable?.(value)===true;
 output.executionReady=false;
 const resolved=restoreRetainedProgramIdentity(current,{stateManager,catalog,sourceManager,trustedDurable});
 if(!owner.valid()||owner.grant?.leaseId!==lease)return false;
 if(!resolved){owner.lose('RETAINED_IDENTITY_UNRESOLVED');return false;}
 if(['media','audio'].includes(current.source?.kind)){
  const context=programPlaybackContinuity(current,{stateManager,catalog,sourceManager,trustedDurable});
  const transport=renderer.getProgramTransport?.();
  const stale=trustedDurable(current)&&context&&(Math.abs((transport?.currentTime??0)-context.transportCueTime)>1||
      (context.transportInitialPlayback==='paused')!==(transport?.state==='paused'||transport?.state==='ended'));
  if(stale||renderer.program?.sceneId!==current.scene.id||renderer.program?.renderer?.sourceId!==current.source.id)
   await renderer.renderSlot(renderer.program,current.scene.id,context);
 }
 if(!owner.valid()||owner.grant?.leaseId!==lease)return false;
 if(stateManager.getProgramSceneId()!==(current.scene?.id??null)){
  owner.lose('PROGRAM_CHANGED_DURING_HYDRATION');return false;
 }
 if(['media','audio'].includes(current.source?.kind)&&renderer.program?.renderer?.sourceId!==current.source.id){
  owner.lose('RETAINED_HYDRATION_UNRESOLVED');return false;
 }
 controller.retainedProgram=current;controller.retainedProgramIdentityResolved=true;
 controller.retainedAdoptionPending=current.source?.kind==='hls';output.snapshot=current;
 controller.executionReconciliationPending=controller.retainedAdoptionPending&&current.source.id===controller.getAuthorizedSource()?.id;
 const ready=()=>{
  if(!owner.valid()||owner.grant?.leaseId!==lease)return;
  if(controller.executionReconciliationPending){
   if(controller.retainedAdoptionPending||!controller.session?.retained)return;
   const health=controller.health;
   if(health?.sourceId!==current.source.id||!health.authority||health.authority==='unresolved')return;
  }
  const wasPending=controller.executionReconciliationPending;
  controller.executionReconciliationPending=false;output.executionReady=true;
  if(wasPending)queueMicrotask(()=>{if(owner.valid()&&owner.grant?.leaseId===lease)controller.emit();});
 };
 controller.executionActivationUnsubscribe?.();
 controller.executionActivationUnsubscribe=controller.subscribe(ready);
 ready();controller.start();ready();controller.emit();
 return true;
}
