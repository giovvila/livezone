import {
    createProgramOutputEnvelope
} from '../../public/js/program-output/ProgramOutputEnvelope.js';

const PREROLL_TITLE='LIVEZONE';
const PREROLL_MESSAGE='TRA POCO IN DIRETTA';

const fail=code=>{
    throw Object.assign(new Error(code),{code});
};

function validId(value){
    return typeof value==='string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
}

function validRevision(value){
    return Number.isSafeInteger(value) && value>=1;
}

function validTime(value){
    return Number.isSafeInteger(value) && value>=0;
}

function canonicalHttpUrl(value){
    if(typeof value!=='string' || !value.trim())
        return null;

    try{
        const url=new URL(value);

        if(
            !['http:','https:'].includes(url.protocol) ||
            url.username ||
            url.password
        ){
            return null;
        }

        return url.href;
    }
    catch{
        return null;
    }
}

function validHttpUrl(value){
    return canonicalHttpUrl(value)!==null;
}

export function createScheduledLivePreroll({
    eventId,
    publisherSessionId,
    revision,
    now,
    logoUrl
}={}){
    if(
        !validId(eventId) ||
        typeof publisherSessionId!=='string' ||
        !publisherSessionId.trim() ||
        !validRevision(revision) ||
        !validTime(now) ||
        !validHttpUrl(logoUrl)
    ){
        fail('INVALID_SCHEDULED_LIVE_PREROLL');
    }

    const at=new Date(now).toISOString();

    const snapshot={
        version:1,
        publisherSessionId:publisherSessionId.trim(),
        revision,
        publishedAt:at,
        committedAt:at,

        scene:{
            id:`scheduled-live-preroll-${eventId}`,
            name:'Scheduled LIVE preroll',
            type:'SLATE'
        },

        source:{
            id:'scheduled-live-preroll',
            kind:'break',
            title:PREROLL_TITLE,
            message:PREROLL_MESSAGE,
            logoUrl
        },

        playback:{
            initialTime:0,
            duration:null,
            playing:false,
            ended:false,
            state:'ready',
            startedAt:at
        },

        graphics:{
            items:[]
        },

        overlays:{},

        transition:{
            type:'cut',
            durationMs:0
        }
    };

    const envelope=
        createProgramOutputEnvelope(snapshot);

    if(!envelope)
        fail('SCHEDULED_LIVE_PREROLL_REJECTED');

    return envelope;
}

export function createScheduledLiveProgram({
    eventId,
    sourceId,
    sourceUrl,
    publisherSessionId,
    revision,
    now
}={}){
    const url=canonicalHttpUrl(sourceUrl);

    if(
        !validId(eventId) ||
        !validId(sourceId) ||
        !url ||
        typeof publisherSessionId!=='string' ||
        !publisherSessionId.trim() ||
        !validRevision(revision) ||
        !validTime(now)
    ){
        fail('INVALID_SCHEDULED_LIVE_PROGRAM');
    }

    const at=new Date(now).toISOString();

    const snapshot={
        version:1,
        publisherSessionId:publisherSessionId.trim(),
        revision,
        publishedAt:at,
        committedAt:at,

        scene:{
            id:`schedule-source-${sourceId}`,
            name:'Scheduled LIVE',
            type:'LIVE'
        },

        source:{
            id:sourceId,
            kind:'hls',
            url
        },

        playback:{
            initialTime:0,
            duration:null,
            playing:true,
            ended:false,
            state:'playing',
            startedAt:at
        },

        graphics:{
            items:[]
        },

        overlays:{},

        transition:{
            type:'cut',
            durationMs:0
        }
    };

    const envelope=
        createProgramOutputEnvelope(snapshot);

    if(!envelope)
        fail('SCHEDULED_LIVE_PROGRAM_REJECTED');

    return envelope;
}

export const SCHEDULED_LIVE_PREROLL=Object.freeze({
    title:PREROLL_TITLE,
    message:PREROLL_MESSAGE
});
