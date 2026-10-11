import fs from 'node:fs';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

// Observe all paths while enabled, including FileHandle methods. Install before
// importing the production modules so their named bindings remain observable.
export function readOnlyFilesystemObserver(){
    const counts=Object.fromEntries(['create','write','truncate','rename','delete','fileSync','directorySync','namespace','native','service','runtime'].map(k=>[k,0]));
    let enabled=false;const restores=[];
    const wrap=(object,key,kind)=>{
        const original=object[key];if(typeof original!=='function')return;
        object[key]=function(...args){if(enabled)counts[kind]++;return original.apply(this,args);};
        restores.push(()=>{object[key]=original;});
    };
    for(const [names,kind] of [[['mkdir','mkdtemp','link','symlink','copyFile','cp'],'create'],[['writeFile','appendFile','write','writev'],'write'],[['truncate','ftruncate'],'truncate'],[['rename'],'rename'],[['unlink','rm','rmdir'],'delete'],[['fsync','fdatasync'],'fileSync']]){
        for(const name of names){wrap(fs,name,kind);wrap(fs,name+'Sync',kind);wrap(fs.promises,name,kind);}
    }
    const originalOpen=fs.promises.open;
    fs.promises.open=async function(path,flags,...args){
        const writing=typeof flags==='number'?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC)):flags!=='r';
        if(enabled&&writing)counts.create++;
        const handle=await originalOpen.call(this,path,flags,...args);
        for(const name of ['write','writev','writeFile','appendFile','truncate','sync','datasync']){
            const original=handle[name];handle[name]=function(...values){
                if(enabled)counts[name==='truncate'?'truncate':name==='sync'||name==='datasync'?'fileSync':'write']++;
                return original.apply(this,values);
            };
        }return handle;
    };
    restores.push(()=>{fs.promises.open=originalOpen;});
    for(const name of ['open','openSync']){const original=fs[name];fs[name]=function(path,flags,...args){
        if(enabled&&(typeof flags==='number'?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC)):flags!=='r'))counts.create++;
        return original.call(this,path,flags,...args);
    };restores.push(()=>{fs[name]=original;});}
    for(const name of ['spawnSync','spawn','execFile','execFileSync','exec','execSync']){
        const original=child[name];
        const wrapped=function(command,args,options,...rest){
            if(enabled){
                const argv=Array.isArray(args)?args:[],encoded=argv.findIndex(a=>/^-EncodedCommand$/i.test(a));
                const script=encoded>=0?Buffer.from(argv[encoded+1]??'','base64').toString('utf16le'):'';
                const input=options?.input??'',decodedInput=String(input).split(/\r?\n/).map(line=>Buffer.from(line,'base64').toString('utf8')).join(' ');
                const text=String(command)+' '+argv.join(' ')+' '+script+' '+decodedInput;
                if(/LedgerExecutionGate|windows-ledger-durability/i.test(text))counts.native++;
                if((/sc(?:\.exe)?$/i.test(command)&&argv.some(a=>/^(start|stop|create|delete|config)$/i.test(a)))||/\b(?:Set|Start|Stop|Restart|New|Remove)-Service\b/i.test(script))counts.service++;
                if(/program-output-server|winsw/i.test(text))counts.runtime++;
            }return original.call(this,command,args,options,...rest);
        };
        for(const symbol of Object.getOwnPropertySymbols(original))Object.defineProperty(wrapped,symbol,Object.getOwnPropertyDescriptor(original,symbol));
        child[name]=wrapped;restores.push(()=>{child[name]=original;});
    }
    syncBuiltinESMExports();
    return {counts,enable:()=>{enabled=true;},disable:()=>{enabled=false;},event:kind=>{if(enabled)counts[kind]++;},
        restore:()=>{enabled=false;for(const restore of restores.reverse())restore();syncBuiltinESMExports();}};
}
