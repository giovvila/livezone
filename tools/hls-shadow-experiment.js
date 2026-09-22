import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolveHealthSource} from '../server/autolive/AutoLiveHealthContract.js';
import Experiment from '../server/autolive/decoder/BrokeredShadowExperiment.js';



// Explicit CLI, no backend default, configuration mutation or application bootstrap.

const {values}=parseArgs({options:{state:{type:'string'},source:{type:'string'},binary:{type:'string'},sha256:{type:'string'},
    seconds:{type:'string',default:'300'},rendition:{type:'string',default:'0'}}});

if(!values.state||!values.source||!values.binary||!values.sha256)throw Error('EXPLICIT_STATE_SOURCE_BINARY_DIGEST_REQUIRED');


const state=JSON.parse(await readFile(values.state,'utf8'));


const source=resolveHealthSource(state.sources?.find(s=>s.id===values.source));

if(!source||source.authority!=='external-hls-http')throw Error('EXTERNAL_SOURCE_UNAVAILABLE');

const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());


const experiment=new Experiment({source,backend:{path:values.binary,digest:values.sha256},durationMs:Number(values.seconds)*1000,
    renditionIndex:Number(values.rendition),signal:stop.signal,observe:value=>console.log(JSON.stringify({event:'observation',...value}))});
try{const result=await experiment.run();console.log(JSON.stringify({event:'result',...result}));if(result.error)process.exitCode=1;}
catch{console.log(JSON.stringify({event:'result',error:'CLEANUP_UNCONFIRMED',executionAllowed:false,serverTake:false,transferReady:false}));process.exitCode=1;}