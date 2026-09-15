
import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeEvent,normalizeSchedule} from '../server/scheduler/ScheduleContract.js';
const p={assetId:'asset-00000000-0000-4000-8000-000000000001',position:'top-right',sizePercent:12,opacity:1};
const event=payload=>({id:'sponsor',version:1,type:'overlay.sponsor',enabled:true,startAt:'2026-09-14T10:00:00.000Z',endAt:'2026-09-14T11:00:00.000Z',createdAt:'2026-09-14T09:00:00.000Z',updatedAt:'2026-09-14T09:00:00.000Z',priority:0,payload});
test('old Sponsor normalizes to CORNER without mutating persisted input',()=>{const input={version:1,revision:4,events:[event(p)]},before=JSON.stringify(input);assert.equal(normalizeSchedule(input).events[0].payload.layout,'CORNER');assert.equal(JSON.stringify(input),before);});
for(const position of ['top-left','top-right','bottom-left','bottom-right'])test('CORNER position '+position,()=>assert.equal(normalizeEvent(event({...p,position})).payload.position,position));
for(const fit of ['CONTAIN','COVER'])for(const opacity of [0,0.5,1])test('FULLSCREEN '+fit+' opacity '+opacity,()=>{const value=normalizeEvent(event({...p,layout:'FULLSCREEN',fit,opacity})).payload;assert.deepEqual(value,{assetId:p.assetId,layout:'FULLSCREEN',fit,opacity});});
test('CORNER removes stale fit',()=>assert.equal(normalizeEvent(event({...p,layout:'CORNER',fit:'COVER'})).payload.fit,undefined));
for(const patch of [{layout:'bad'},{layout:null},{layout:'FULLSCREEN',fit:'STRETCH'},{layout:'FULLSCREEN'},{opacity:-1},{opacity:1.01},{opacity:'1'},{layout:'FULLSCREEN',fit:'url(evil)'},{css:'anything'}])test('invalid Sponsor payload '+JSON.stringify(patch),()=>assert.throws(()=>normalizeEvent(event({...p,...patch})),{code:'INVALID_PAYLOAD'}));
