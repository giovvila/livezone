import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaResourceTiming, RuntimeTrace} from '../public/js/core/RuntimeTrace.js';

const location = {href:'http://localhost:8080/',origin:'http://localhost:8080'};
test('media timing export bounds entries and omits credentials, queries and unrelated requests',()=>{
    const entries=Array.from({length:140},(_,i)=>({name:`http://user:secret@localhost:8080/media/demo2.mp4?token=${i}`,
        startTime:i,responseStart:i+1,responseEnd:i+2,transferSize:65536,responseStatus:206,initiatorType:'video'}));
    entries.push({name:'http://localhost:8080/api/auth?secret=x'},{name:'https://other.test/media/private.mp4'});
    const result=mediaResourceTiming({timeOrigin:123,getEntriesByType:()=>entries},location);
    assert.equal(result.entries.length,128);assert.equal(result.truncated,true);
    assert.equal(result.entries[0].startTime,12);assert.equal(result.entries[0].responseStatus,206);
    assert.equal(result.entries[0].pathname,'/media/demo2.mp4');
    assert.doesNotMatch(JSON.stringify(result),/secret|token|private|user:/);
    assert.equal(result.pendingRequests,'not-exposed');assert.equal(result.rangeHeaders,'not-exposed');
});
test('unavailable Resource Timing is diagnostic only and does not throw',()=>{
    assert.equal(mediaResourceTiming({getEntriesByType(){throw Error('unavailable');}},location).unavailable,true);
});
test('retry decision and numeric media error survive redacted trace export',()=>{
    const trace=new RuntimeTrace({enabled:true});
    trace.record('live-monitor','retry-scheduled',{reason:'health-demand',retryDelayMs:5000,maxRetryDelayMs:30000,
        retryFailures:8,healthDemandCount:1,mediaErrorCode:4,errorMessage:'private URL'});
    const row=JSON.parse(trace.exportJSON()).entries[0];
    assert.equal(row.healthDemandCount,1);assert.equal(row.maxRetryDelayMs,30000);
    assert.equal(row.mediaErrorCode,4);assert.equal(row.errorMessage,undefined);
});
