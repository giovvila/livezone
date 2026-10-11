import {readdir,lstat} from 'node:fs/promises';
import {readdirSync,lstatSync} from 'node:fs';
import {basename,dirname} from 'node:path';

// Protocol basenames and generated suffixes are ASCII on supported Windows
// NTFS. This is filename comparison only, not Unicode or content normalization.
// POSIX keeps exact spelling. Unexpected aliases are never adopted as evidence.
export const namespaceKey=(name,platform=process.platform)=>platform==='win32'
    ?name.replace(/[A-Z]/g,c=>String.fromCharCode(c.charCodeAt(0)+32)):name;
export const namespaceStarts=(name,prefix,platform=process.platform)=>namespaceKey(name,platform).startsWith(namespaceKey(prefix,platform));
export const namespaceEnds=(name,suffix,platform=process.platform)=>namespaceKey(name,platform).endsWith(namespaceKey(suffix,platform));
const refuse=code=>{throw Object.assign(Error(code),{code});};
export function assertUniqueNames(names,{platform=process.platform,code='RECOVERY_NAMESPACE_AMBIGUOUS'}={}) {
    const keys=names.map(n=>namespaceKey(n,platform));
    if(new Set(keys).size!==keys.length)refuse(code);
}
export function assertCanonicalNames(names,expected,{platform=process.platform,code='RECOVERY_NAMESPACE_NONCANONICAL'}={}) {
    for(const canonical of expected) {
        const matches=names.filter(n=>namespaceKey(n,platform)===namespaceKey(canonical,platform));
        if(matches.length>1)refuse(code+'_AMBIGUOUS');
        if(matches.length===1&&matches[0]!==canonical)refuse(code);
    }
}
export async function assertCanonicalPath(path,options) {
    let names;
    try{names=await readdir(dirname(path));}catch(e){if(e.code==='ENOENT')return;throw e;}
    assertCanonicalNames(names,[basename(path)],options);
    // A canonical Win32 open can also resolve aliases outside our ASCII key.
    // Never adopt such a spelling: require the actual directory entry spelling
    // whenever the expected path resolves, without claiming Unicode equivalence.
    if(process.platform==='win32'&&!names.includes(basename(path))) {
        try{await lstat(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
        refuse(options?.code??'RECOVERY_NAMESPACE_NONCANONICAL');
    }
}
// Synchronous authority fences use the same namespace rules as recovery reads.
export function assertCanonicalPathSync(path,options) {
    let names;
    try{names=readdirSync(dirname(path));}catch(e){if(e.code==='ENOENT')return;throw e;}
    assertCanonicalNames(names,[basename(path)],options);
    if(process.platform==='win32'&&!names.includes(basename(path))) {
        try{lstatSync(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
        refuse(options?.code??'RECOVERY_NAMESPACE_NONCANONICAL');
    }
}
export function classifyMigrationNames(names,base,suffixes,platform=process.platform) {
    const prefix=base+'.migration.',reserved=base+'.migration',known=suffixes.map(s=>prefix+s);
    assertCanonicalNames(names,[base,base+'.wal',base+'.bootstrap',...known],{platform,code:'LEDGER_MIGRATION_NONCANONICAL_ARTIFACT'});
    return names.map(name=>({name,kind:namespaceStarts(name,reserved,platform)
        ?known.includes(name)?'KNOWN':'UNKNOWN'
        :namespaceStarts(name,base+'.',platform)&&['.tmp','.stage'].some(s=>namespaceEnds(name,s,platform))?'FOREIGN_STAGE':'UNRELATED'}));
}
