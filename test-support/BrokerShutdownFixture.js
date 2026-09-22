import Experiment from '../server/autolive/decoder/BrokeredShadowExperiment.js';
import SafeHttp from '../server/autolive/AutoLiveSafeHttp.js';
import {remoteReference} from '../server/autolive/decoder/HlsDecodeInputBroker.js';
import {LOCAL_BACKEND} from './DecoderLocalFixture.js';

const endpoint=process.argv[2];
if(!/^http:\/\/127\.0\.0\.1:\d+\/input\.m3u8$/.test(endpoint))throw Error('ISOLATED_FIXTURE_REQUIRED');
const controller=new AbortController();process.on('message',message=>{if(message==='shutdown')controller.abort();});
const http=new SafeHttp({parseUrl:v=>new URL(remoteReference(v)),allowAddress:ip=>ip==='127.0.0.1',validateRedirect:remoteReference});
let notified=false;
const experiment=new Experiment({source:{sourceId:'fixture',endpoint,fingerprint:'a'.repeat(64)},backend:LOCAL_BACKEND,
    durationMs:20000,http,signal:controller.signal,observe:value=>{
        if(!notified&&value.pid){notified=true;process.send({pid:value.pid,cache:experiment.broker.root});}
    }});
const result=await experiment.run();process.send({result});process.disconnect();
