import {validateSchedule,createEmptySchedule} from './ScheduleContract.js';
export function serializeProgramPlan(schedule){
    return {version:1,timezone:schedule.timezone,items:schedule.items.map(item=>({
        id:item.id,title:item.title,startMode:item.startMode,behavior:item.behavior,resumePolicy:item.resumePolicy,
        ...(item.startMode==='ABSOLUTE'?{start:item.start}:{}),durationSeconds:item.durationSeconds,
        ...(Object.hasOwn(item,'sceneId')?{sceneId:item.sceneId}:{target:{kind:item.target.kind,id:item.target.id}}),transition:item.transition
    }))};
}
export function normalizeProgramPlan(value){
    const result=validateSchedule(value);if(!result.ok)throw Object.assign(new Error('INVALID_PROGRAM_PLAN'),{code:'INVALID_PROGRAM_PLAN'});
    return serializeProgramPlan(result.schedule);
}
export function editorPlan(value){return validateSchedule(value||createEmptySchedule()).schedule;}
