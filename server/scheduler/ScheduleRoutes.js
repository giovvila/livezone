const ROOT='/api/studio/schedule';
const MAX_BODY=64*1024;
const tag=revision=>`"schedule-${revision}"`;
const send=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
const failure=(res,status,code)=>send(res,status,{ok:false,error:{code}});

export default class ScheduleRoutes {
    constructor({owner}){this.owner=owner;this.clients=new Map();this.closed=false;
        this.unsubscribe=owner.subscribe(state=>{for(const res of this.clients.keys())this.write(res,state);});}
    async handle(req,res,url){
        await this.owner.ready;
        if(this.closed)return failure(res,503,'SCHEDULE_UNAVAILABLE');
        const suffix=url.pathname.slice(ROOT.length);
        if(!this.owner.available())return failure(res,503,'SCHEDULE_UNAVAILABLE');
        if(req.method==='GET'&&(suffix===''||suffix==='/status')){
            this.owner.diagnostics.record('api-read');const runtime=this.owner.current();
            return send(res,200,{ok:true,...(suffix===''?{schedule:this.owner.store.getSnapshot()}:{}),runtime},
                {ETag:tag(runtime.scheduleRevision)});
        }
        if(req.method==='GET'&&suffix==='/events')return this.connect(req,res);
        const planAction=suffix==='/program-plan'&&req.method==='PUT'||suffix==='/program-plan/import'&&req.method==='POST';
        const match=/^\/events\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})$/.exec(suffix);
        if(!(planAction||req.method==='POST'&&suffix==='/events'||match&&['PATCH','DELETE'].includes(req.method)))
            return failure(res,405,'METHOD_NOT_ALLOWED');
        const expected=/^"schedule-(0|[1-9][0-9]*)"$/.exec(req.headers['if-match']||'');
        if(!expected||!Number.isSafeInteger(Number(expected[1])))return failure(res,428,'REVISION_REQUIRED');
        let body=null;
        if(req.method!=='DELETE'){
            if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return failure(res,415,'CONTENT_TYPE_REQUIRED');
            try{body=JSON.parse(await readBody(req,planAction?512*1024:MAX_BODY));}catch(e){return failure(res,e.code==='PAYLOAD_TOO_LARGE'?413:400,e.code==='PAYLOAD_TOO_LARGE'?e.code:'INVALID_JSON');}
        }
        const store=this.owner.store,revision=Number(expected[1]);
        const result=planAction?await store.replaceProgramPlan(body,revision,{importOnly:suffix.endsWith('/import')}):req.method==='POST'?await store.insert(body,revision):req.method==='PATCH'?
            await store.update(match[1],body,revision):await store.delete(match[1],revision);
        this.owner.diagnostics.record(result.code==='REVISION_CONFLICT'?'api-conflict':'api-mutation',{revision:store.getSnapshot()?.revision});
        if(!result.ok){
            const status=result.code==='REVISION_CONFLICT'?412:['DUPLICATE_ID','SERVER_NOT_EMPTY'].includes(result.code)?409:
                result.code==='EVENT_NOT_FOUND'?404:['PERSISTENCE_FAILED','SCHEDULE_UNAVAILABLE','STORE_CLOSED'].includes(result.code)?503:422;
            return send(res,status,{ok:false,error:{code:result.code},revision:store.getSnapshot()?.revision});
        }
        return send(res,req.method==='POST'?201:200,{ok:true,schedule:result.schedule,runtime:this.owner.current()},
            {ETag:tag(result.schedule.revision)});
    }
    connect(req,res){
        const current=this.owner.current();
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
        let cleaned=false;
        const cleanup=()=>{if(cleaned)return;cleaned=true;clearInterval(timer);this.clients.delete(res);this.owner.diagnostics.record('sse-disconnect');};
        const timer=setInterval(()=>{if(!res.write(': keepalive\n\n'))res.destroy();},15000);timer.unref?.();
        this.clients.set(res,cleanup);req.on('aborted',cleanup);res.on('close',cleanup);res.on('error',cleanup);
        this.owner.diagnostics.record('sse-connect');this.write(res,current);
    }
    write(res,state){
        if(res.destroyed||res.writableEnded){this.clients.get(res)?.();return;}
        try{if(!res.write(`id: ${state.sessionId}:${state.generation}\nevent: schedule-state\ndata: ${JSON.stringify(state)}\n\n`))res.destroy();}
        catch{res.destroy();this.clients.get(res)?.();}
    }
    close(){this.closed=true;this.unsubscribe();for(const [res,cleanup] of this.clients){cleanup();res.end();}this.clients.clear();}
}
function readBody(req,maxBytes=MAX_BODY){return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,done=false;
    req.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>maxBytes){done=true;reject(Object.assign(new Error(),{code:'PAYLOAD_TOO_LARGE'}));req.resume();return;}chunks.push(chunk);});
    req.on('end',()=>{if(!done)resolve(Buffer.concat(chunks).toString('utf8'));});
    req.on('error',reject);req.on('aborted',()=>reject(new Error('aborted')));
});}
