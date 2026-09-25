import {validateSchedule as validateProgramSchedule} from '../../public/js/scheduler/ScheduleContract.js';
import {normalizeProgramPlan} from '../../public/js/scheduler/ProgramScheduleAdapter.js';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(v, k));
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && Array.from(v).length <= max;
export const SCHEDULE_VERSION = 1;
export const MAX_EVENTS = 500;
export const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
export function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_TIMESTAMP');
    return value;
}
export function normalizeEvent(v) {
    if (!exact(v, ['id','version','type','enabled','startAt','endAt','priority','payload','createdAt','updatedAt',...(Object.hasOwn(v||{},'name')?['name']:[])])) fail('INVALID_EVENT');
    if (Object.hasOwn(v,'name')&&!text(v.name,120)) fail('INVALID_NAME');
    if (!text(v.id,120) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v.id)) fail('INVALID_ID');
    if (v.version !== 1 || !['overlay.crawl','overlay.sponsor','source.live'].includes(v.type)) fail('UNSUPPORTED_EVENT');
    if (typeof v.enabled !== 'boolean' || !Number.isInteger(v.priority) || Math.abs(v.priority) > 100) fail('INVALID_EVENT');
    ['startAt','endAt','createdAt','updatedAt'].forEach(k => timestamp(v[k]));
    if (v.endAt <= v.startAt) fail('INVALID_INTERVAL');
    const p = v.payload;
    let payload;
    if (v.type === 'overlay.crawl') {
        if (!exact(p,['text','position','direction','speed','repeat','styleId','background']) ||
            !text(p.text,500) || !['top','bottom'].includes(p.position) || !['rtl','ltr'].includes(p.direction) ||
            !['slow','medium','fast'].includes(p.speed) || p.repeat !== 'continuous' ||
            p.styleId !== 'broadcast-default' || typeof p.background !== 'boolean') fail('INVALID_PAYLOAD');
        payload = { text:p.text.trim(), position:p.position, direction:p.direction, speed:p.speed,
            repeat:p.repeat, styleId:p.styleId, background:p.background };
    } else if (v.type === 'overlay.sponsor') {
        const layout=p?.layout===undefined?'CORNER':p.layout;
        if (!object(p) || Object.keys(p).some(k=>!['assetId','layout','position','sizePercent','fit','opacity'].includes(k)) || !['CORNER','FULLSCREEN'].includes(layout) || !text(p.assetId,120) ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(p.assetId) ||
            (layout==='CORNER' && (!['top-left','top-right','bottom-left','bottom-right'].includes(p.position) ||
            !Number.isFinite(p.sizePercent) || p.sizePercent < 5 || p.sizePercent > 30)) ||
            (layout==='FULLSCREEN' && !['CONTAIN','COVER'].includes(p.fit)) ||
            !Number.isFinite(p.opacity) || p.opacity < 0 || p.opacity > 1) fail('INVALID_PAYLOAD');
        payload = {assetId:p.assetId,layout,...(layout==='FULLSCREEN'?{fit:p.fit}:{position:p.position,sizePercent:p.sizePercent}),opacity:p.opacity};
    } else {
        if (!exact(p,[
            'sourceId',
            'precheckSeconds',
            'unavailableAction',
            'unavailableSceneId',
            'endAction',
            'endSceneId'
        ])) fail('INVALID_PAYLOAD');

        if (!text(p.sourceId,120) ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(p.sourceId))
            fail('INVALID_PAYLOAD');

        if (!Number.isInteger(p.precheckSeconds) ||
            p.precheckSeconds < 0 ||
            p.precheckSeconds > 900)
            fail('INVALID_PAYLOAD');

        if (!['KEEP_PROGRAM','TAKE_SCENE','RADIO'].includes(p.unavailableAction))
            fail('INVALID_PAYLOAD');

        if (!['RETURN','TAKE_SCENE','RADIO','HOLD'].includes(p.endAction))
            fail('INVALID_PAYLOAD');

        const unavailableSceneId =
            p.unavailableAction === 'TAKE_SCENE'
                ? p.unavailableSceneId
                : null;

        const endSceneId =
            p.endAction === 'TAKE_SCENE'
                ? p.endSceneId
                : null;

        if (p.unavailableAction === 'TAKE_SCENE' &&
            (!text(unavailableSceneId,120) ||
             !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(unavailableSceneId)))
            fail('INVALID_PAYLOAD');

        if (p.endAction === 'TAKE_SCENE' &&
            (!text(endSceneId,120) ||
             !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(endSceneId)))
            fail('INVALID_PAYLOAD');

        if (p.unavailableAction !== 'TAKE_SCENE' &&
            p.unavailableSceneId !== null)
            fail('INVALID_PAYLOAD');

        if (p.endAction !== 'TAKE_SCENE' &&
            p.endSceneId !== null)
            fail('INVALID_PAYLOAD');

        payload = {
            sourceId:p.sourceId,
            precheckSeconds:p.precheckSeconds,
            unavailableAction:p.unavailableAction,
            unavailableSceneId,
            endAction:p.endAction,
            endSceneId
        };
    }
    return freeze({id:v.id,...(v.name?{name:v.name.trim()}:{}),version:1,type:v.type,enabled:v.enabled,startAt:v.startAt,endAt:v.endAt,
        priority:v.priority,payload,createdAt:v.createdAt,updatedAt:v.updatedAt});
}
export const compareIds = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export function normalizeSchedule(v) {
    if (!exact(v,v?.version===2?['version','revision','events','programPlan']:['version','revision','events']) || ![1,2].includes(v.version) ||
        !Number.isSafeInteger(v.revision) || v.revision < 0 || !Array.isArray(v.events) || v.events.length > MAX_EVENTS) fail('INVALID_SCHEDULE');
    const events = v.events.map(normalizeEvent).sort((a,b) => compareIds(a.id,b.id));
    if (new Set(events.map(e=>e.id)).size !== events.length) fail('DUPLICATE_ID');
    return freeze({version:v.version,revision:v.revision,events,...(v.version===2?{programPlan:normalizeProgramPlan(v.programPlan)}:{})});
}
export function resolveSchedule(schedule, now) {
    if (!Number.isFinite(now)) fail('INVALID_CLOCK');
    const canonical = normalizeSchedule(schedule);
    const candidates = canonical.events.filter(e=>e.enabled && Date.parse(e.startAt)<=now && now<Date.parse(e.endAt));
    candidates.sort((a,b)=>b.priority-a.priority || Date.parse(b.startAt)-Date.parse(a.startAt) || compareIds(a.id,b.id));
    const winners = new Map();
    for (const e of candidates) if (!winners.has(e.type)) winners.set(e.type,e);
    const deadlines = canonical.events
        .filter(e=>e.enabled)
        .flatMap(e=>{
            const start=Date.parse(e.startAt);
            const end=Date.parse(e.endAt);

            if(e.type==='source.live'){
                const precheck=
                    start-e.payload.precheckSeconds*1000;

                const preRoll=start-10000;
                const postRollEnd=end+3000;

                return [
                    precheck,
                    preRoll,
                    start,
                    end,
                    postRollEnd
                ];
            }

            return [start,end];
        })
        .filter(t=>t>now);
    if(canonical.programPlan){const plan=validateProgramSchedule(canonical.programPlan).schedule;for(const item of plan.items)for(const t of [item.startMs,item.endMs])if(t>now)deadlines.push(t);}
    return freeze({activeEvents:[...winners.values()].sort((a,b)=>compareIds(a.type,b.type)),
        nextDeadline:deadlines.length ? Math.min(...deadlines) : null,
        scheduleRevision:canonical.revision,evaluatedAt:now});
}
