import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import Broker from './HlsDecodeInputBroker.js';
import Supervisor from './DecoderSupervisor.js';
import HlsObserver from '../AutoLiveHlsObserver.js';
import {compareDecoderShadow} from './DecoderShadowComparison.js';

// Explicitly invoked experiment only. No application imports or execution authority.
export default class BrokeredShadowExperiment {
    constructor({source, backend, profile = 'AUDIO_VIDEO', renditionIndex = 0, durationMs = 300000,
        http, observe = () => {}, signal}) {
        if (!source || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 600000) throw Error('EXPERIMENT_OPTIONS_INVALID');
        Object.assign(this, {source:{...source},backend,profile,renditionIndex,durationMs,http,observe,signal});
        this.controller = new AbortController();
    }
    cancel() { this.controller.abort(); this.broker?.abort.abort(); }
    async run() {
        const started = performance.now(), cancel = () => this.cancel();
        const deadline=setTimeout(()=>{this.deadlineExpired=true;cancel();},this.durationMs);
        this.signal?.addEventListener('abort',cancel,{once:true});if(this.signal?.aborted)cancel();
        let firstProgress=null,lastProgress=null,longestProgressMs=0,runStart=null,samples=0,maximumBytes=0,maximumObjects=0;
        let latest=null,transport=null,lastDiagnostic=0,nextRefresh=0,nextMonitor=0,error=null,cleanup=false;
        const broker=this.broker=new Broker({endpoint:this.source.endpoint,sourceId:this.source.sourceId,
            sourceFingerprint:this.source.fingerprint,renditionIndex:this.renditionIndex,...(this.http?{http:this.http}:{})});
        const observer=new HlsObserver(this.http?{http:this.http}:{});
        const observerSource={id:this.source.sourceId,endpoint:this.source.endpoint};
        try {
            if(this.controller.signal.aborted)throw Object.assign(Error('ABORTED'),{code:'ABORTED'});
            await broker.start();
            this.supervisor=new Supervisor({backend:this.backend,brokerInput:broker.input,sourceId:this.source.sourceId,
                profile:this.profile,maxRuntimeMs:Math.min(600000,this.durationMs+15000)});
            this.worker=await this.supervisor.start(sample=>{
                latest=sample;samples++;
                const now=performance.now();
                if(sample.state==='DECODER_PROGRESS'){
                    firstProgress??=now;lastProgress=now;runStart??=now;longestProgressMs=Math.max(longestProgressMs,now-runStart);
                }else runStart=null;
            });
            while(performance.now()-started<this.durationMs&&!this.controller.signal.aborted&&!this.worker.evidence.closed){
                const now=performance.now();
                if(now>=nextRefresh){await broker.refresh();nextRefresh=performance.now()+Math.min(5000,Math.max(1000,broker.target*500));}
                if(now>=nextMonitor){
                    try{const value=await observer.sample(observerSource,this.controller.signal);transport={state:value.state,reason:value.reason,
                        playlistProgressing:value.playlistProgressing,segmentReachable:value.segmentReachable};}
                    catch(e){transport={state:'ERROR',reason:/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:'MONITOR_ERROR'};}
                    nextMonitor=performance.now()+5000;
                }
                const state=broker.snapshot();maximumBytes=Math.max(maximumBytes,state.bytes);maximumObjects=Math.max(maximumObjects,state.objects);
                if(now-lastDiagnostic>=5000){
                    this.observe({elapsedMs:Math.round(now-started),pid:this.worker.pid,broker:state,
                        decoder:latest?{state:latest.state,reason:latest.reason,sequence:latest.sequence,workerId:latest.workerId,
                            workerGeneration:latest.workerGeneration,restartGeneration:latest.restartGeneration,
                            freshnessMs:latest.freshnessMs,qualifiedMs:latest.qualifiedMs,tracks:latest.tracks}:null,
                        transport,comparison:compareDecoderShadow({decoder:latest,binding:{authorizedSourceId:this.source.sourceId,
                            sourceFingerprint:this.source.fingerprint},now:Date.now()}).classification});lastDiagnostic=now;
                }
                await delay(250,undefined,{signal:this.controller.signal});
            }
            if(this.worker.evidence.state==='DECODER_ERROR'||this.worker.evidence.state==='DECODER_UNAVAILABLE') error=this.worker.evidence.reason;
        }catch(e){error=this.deadlineExpired?(firstProgress===null?'EXPERIMENT_DEADLINE':null):
            this.controller.signal.aborted?'EXPERIMENT_CANCELLED':/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:'EXPERIMENT_FAILED';}
        finally{
            clearTimeout(deadline);
            this.signal?.removeEventListener('abort',cancel);
            let cleanupReason=null;
            try {
                await this.supervisor?.stop();
                await broker.close();
                cleanup=true;
            } catch(e) {
                cleanup=false;
                cleanupReason=/^[A-Z0-9_]{1,64}$/.test(e?.code||'')?e.code:'CLEANUP_FAILED';
            }
            this.cleanupReason=cleanupReason;
        }
        return {durationMs:Math.round(performance.now()-started),requestedDurationMs:this.durationMs,
            startupMs:firstProgress===null?null:Math.round(firstProgress-started),
            decodedProgressSpanMs:firstProgress===null?0:Math.round(lastProgress-firstProgress),
            longestContinuousProgressMs:Math.round(longestProgressMs),observations:samples,
            maximumCacheBytes:Math.max(maximumBytes,broker.peakBytes||0),maximumCachedObjects:Math.max(maximumObjects,broker.peakObjects||0),profile:this.profile,
            broker:broker.snapshot(),lastDecoder:latest?{state:latest.state,tracks:latest.tracks,
                workerGeneration:latest.workerGeneration,restartGeneration:latest.restartGeneration}:null,
            transport,error,cleanup,cleanupReason:this.cleanupReason??null,comparison:'INSUFFICIENT_EVIDENCE',comparisonReason:'NO_CURRENT_BROWSER_EVIDENCE',
            executionAllowed:false,serverTake:false,transferReady:false};
    }
}
