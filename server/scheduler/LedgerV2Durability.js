import {openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import {mkdir,lstat,unlink,open} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {windowsLedgerDurability} from './WindowsLedgerDurability.js';

const unproven=()=>{throw Object.assign(Error('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});};
export function directorySync(path) {
    if(process.platform==='win32')return windowsLedgerDurability.syncDirectory(path);
    const fd=openSync(dirname(path),'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    return 'DIRECTORY_SYNCED';
}
export function createLedgerV2Durability({syncDirectory=directorySync,fs={}}={}) {
    const native=process.platform==='win32'&&syncDirectory===directorySync?windowsLedgerDurability:null;
    const sync=path=>{if(syncDirectory(path)!=='DIRECTORY_SYNCED')unproven();return 'DIRECTORY_SYNCED';};
    return Object.freeze({sync,
        async syncFile(path) {const file=await (fs.open??open)(path,'r+');try{await file.sync();}finally{await file.close();}sync(path);},
        async ensureDirectory(path) {
            path=resolve(path);const missing=[];let ancestor=path;
            for(;;) {
                try {const s=await lstat(ancestor);if(!s.isDirectory()||s.isSymbolicLink())unproven();break;}
                catch(e) {if(e.code!=='ENOENT')throw e;missing.push(ancestor);const parent=dirname(ancestor);if(parent===ancestor)unproven();ancestor=parent;}
            }
            // Establish capability before the first creation; never recursive mkdir.
            sync(join(ancestor,'.namespace-probe'));
            for(const child of missing.reverse()) {await (fs.mkdir??mkdir)(child);sync(child);sync(join(child,'.namespace-probe'));}
        },
        replace(from,to) {if(native)return native.replace(from,to);(fs.renameSync??renameSync)(from,to);sync(to);},
        async archive(from,to) {
            if(native)return native.archive(from,to);
            // POSIX no-overwrite archival uses link/unlink, never a replacing rename.
            const {link}=await import('node:fs/promises');await link(from,to);sync(to);await (fs.unlink??unlink)(from);sync(from);
        },
        async remove(path) {if(native)return native.remove(path);await (fs.unlink??unlink)(path);sync(path);}
    });
}
