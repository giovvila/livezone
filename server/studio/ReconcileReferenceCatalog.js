// Additive legacy import. Neither a browser revision claim nor record ordering wins
// a conflict. Changed existing records require a normal revision-checked mutation.
export function reconcileReferenceCatalog(current, candidate) {
    const conflicts=[];
    const merge=(domain)=>{
        const existing=new Map(current[domain].map(value=>[value.id,value]));
        for(const value of candidate[domain]) {
            const previous=existing.get(value.id);
            if(previous&&stable(previous)!==stable(value))conflicts.push({domain,ownerId:value.id});
            else if(!previous)existing.set(value.id,value);
        }
        return [...existing.values()].sort((a,b)=>a.id.localeCompare(b.id));
    };
    const sources=merge('sources'),scenes=merge('scenes');
    if(conflicts.length)return {status:'CONFLICT',conflicts:conflicts.slice(0,100)};
    const changed=sources.length!==current.sources.length||scenes.length!==current.scenes.length;
    return {status:changed?'IMPORTED':sources.length===candidate.sources.length&&scenes.length===candidate.scenes.length?'SAME':'SERVER_SUPERSET',sources,scenes};
}
function stable(value) {
    if(Array.isArray(value))return JSON.stringify(value.map(item=>JSON.parse(stable(item))));
    if(value&&typeof value==='object')return JSON.stringify(Object.fromEntries(Object.keys(value).filter(key=>key!=='origin').sort().map(key=>[key,JSON.parse(stable(value[key]))])));
    return JSON.stringify(value);
}
