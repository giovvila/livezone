// Read-only inventory. Unknown ownership is never equivalent to zero references.
export default class MediaReferenceAudit {
    constructor({inventories}) {this.inventories=inventories;}
    async inspect(asset) {
        const references=[],unavailable=[];
        let inventories;
        try {inventories=await this.inventories();}catch{inventories=[{name:'Inventario riferimenti',complete:false}];}
        if(!Array.isArray(inventories)||!inventories.length)inventories=[{name:'Inventario riferimenti',complete:false}];
        const protectedIds=new Set([asset.id]);
        const linked=value=>typeof value==='string'?protectedIds.has(value)||isManagedUrl(value,asset.url):
            value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>key!=='id'&&linked(child));
        const records=[];
        const collect=value=>{if(!value||typeof value!=='object')return;if(typeof value.id==='string')records.push(value);Object.values(value).forEach(collect);};
        inventories.forEach(inventory=>collect(inventory.data));
        for(let pass=0;pass<=records.length;pass++){
            const size=protectedIds.size;for(const record of records)if(linked(record))protectedIds.add(record.id);
            if(size===protectedIds.size)break;
        }
        for(const inventory of inventories) {
            if(!inventory.complete)unavailable.push(inventory.name);
            const seen=new Set();
            const visit=(value,path,label)=>{
                if(protectedIds.has(value) || typeof value==='string'&&isManagedUrl(value,asset.url)) {
                    const key=inventory.name+':'+path;
                    if(!seen.has(key)){seen.add(key);references.push({type:inventory.name,name:label||inventory.name,field:path});}
                    return;
                }
                if(!value||typeof value!=='object')return;
                const nextLabel=typeof value.name==='string'?value.name:typeof value.title==='string'?value.title:label;
                for(const [key,child] of Object.entries(value))if(key!=='id'||['source','scene'].includes(value.kind))visit(child,path?path+'.'+key:key,nextLabel);
            };
            visit(inventory.data,'',inventory.name);
        }
        const complete=unavailable.length===0;
        return {assetId:asset.id,complete,eligible:complete&&references.length===0,
            referenceCount:references.length,references:references.slice(0,100),unavailable};
    }
}
function isManagedUrl(value,url) {
    if(!url?.startsWith('/media-library/files/'))return false;
    if(value===url)return true;
    try {const parsed=new URL(value);return ['http:','https:'].includes(parsed.protocol)&&parsed.pathname===url;}catch{return false;}
}
