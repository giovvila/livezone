import {createScheduledLiveTransaction,transitionScheduledLiveTransaction} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

export function completedTransaction(program=fixtureProgram()) {
    let transaction=createScheduledLiveTransaction({eventId:'completed-history',sourceId:'camera',program,
        manualIntentRevision:0,capturedAt:590000});
    for(const operation of ['begin-preroll','begin-live','begin-postroll','prepare-return','complete'])
        transaction=transitionScheduledLiveTransaction(transaction,operation,{manualIntentRevision:0});
    return transaction;
}
export function fixtureProgram(publisherSessionId='captured-manual') {
    const at='2026-09-25T06:00:00.000Z';
    return createProgramOutputEnvelope({version:1,publisherSessionId,revision:7,publishedAt:at,committedAt:at,
        scene:{id:'scene',name:'PROGRAM',type:'MEDIA'},source:{id:'media',kind:'media',url:'https://example.test/source.mp4'},
        playback:{initialTime:27,duration:120,playing:true,ended:false,state:'playing',startedAt:at},
        graphics:{items:[]},transition:{type:'cut',durationMs:0}});
}
