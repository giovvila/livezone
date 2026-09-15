const send=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
export default class AutoLiveRoutes {
    constructor({authority}){this.authority=authority;}
    async handle(req,res,url){
        const owner=this.authority;await owner.ready;
        const migration=url.pathname==='/api/studio/autolive/migrate';
        if(!migration&&url.pathname!=='/api/studio/autolive')return send(res,404,{ok:false,error:{code:'NOT_FOUND'}});
        if(req.method==='GET'&&!migration)return send(res,owner.available()?200:503,{ok:owner.available(),...owner.current()},
            owner.available()?{ETag:`"autolive-${owner.store.getSnapshot().revision}"`}:{});
        if(!(req.method==='PATCH'&&!migration || req.method==='POST'&&migration))return send(res,405,{ok:false,error:{code:'METHOD_NOT_ALLOWED'}});
        const match=/^"autolive-(0|[1-9][0-9]*)"$/.exec(req.headers['if-match']||'');
        if(!match||!Number.isSafeInteger(Number(match[1])))return send(res,428,{ok:false,error:{code:'REVISION_REQUIRED'}});
        if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return send(res,415,{ok:false,error:{code:'CONTENT_TYPE_REQUIRED'}});
        try{
            const chunks=[];let size=0;
            for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>8192){req.resume();const e=new Error();e.code='PAYLOAD_TOO_LARGE';throw e;}chunks.push(chunk);}
            let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{const e=new Error();e.code='INVALID_JSON';throw e;}
            const state=await owner.mutate(value,Number(match[1]),{migration});
            return send(res,200,{ok:true,...state},{ETag:`"autolive-${state.config.revision}"`});
        }catch(e){const code=e.code||'INVALID_REQUEST';const status=code==='REVISION_CONFLICT'?412:code==='MIGRATION_CLOSED'||code==='RECOVERY_CONFLICT'?409:
            ['STORE_UNAVAILABLE','PERSISTENCE_FAILED','REVISION_EXHAUSTED'].includes(code)?503:code==='PAYLOAD_TOO_LARGE'?413:code==='INVALID_JSON'?400:422;
            return send(res,status,{ok:false,error:{code},revision:owner.store.getSnapshot()?.revision??null});}
    }
}
