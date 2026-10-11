// Explicit test preload only. Never imported by production.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';

const realpath = fs.realpathSync;
const descriptors = new Map();
function canonical(value) {
    let path = resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
    const tail = [];
    for (;;) {
        try { path = join(realpath(path), ...tail.reverse()); break; }
        catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;
            const parent = dirname(path); if (parent === path) break; tail.push(path.slice(parent.length + 1)); path = parent; }
    }
    return process.platform === 'win32' ? path.toLowerCase() : path;
}
const repository = fileURLToPath(new URL('../', import.meta.url));
const roots = [join(repository,'var'), join(repository,'studio-state'), join(repository,'scheduler'),
    ...(process.env.LIVEZONE_TEST_PROTECTED_ROOTS ? JSON.parse(process.env.LIVEZONE_TEST_PROTECTED_ROOTS) : [])].map(canonical);
function check(path) {
    // Unknown inherited descriptors fail closed; descriptors opened under this
    // preload retain their checked path, including read-only opens.
    if (typeof path === 'number') {
        if(!descriptors.has(path)) throw Object.assign(new Error('TEST_RUNTIME_STATE_PROTECTED: unknown descriptor'), {code:'TEST_RUNTIME_STATE_PROTECTED'});
        path=descriptors.get(path);
    }
    const target = canonical(path);
    for (const root of roots) {
        const down = relative(root,target), up = relative(target,root);
        if (!down || (!down.startsWith('..') && !isAbsolute(down)) || !up || (!up.startsWith('..') && !isAbsolute(up)))
            throw Object.assign(new Error(`TEST_RUNTIME_STATE_PROTECTED: ${target}`), {code:'TEST_RUNTIME_STATE_PROTECTED'});
    }
}
const single = ['writeFile','appendFile','truncate','unlink','rm','rmdir','mkdir','mkdtemp','chmod','chown','lchmod','lchown','utimes','lutimes'];
const pairs = ['rename','link'];
function wrap(object,name,indices) {
    if (typeof object[name] !== 'function') return;
    const original = object[name]; object[name] = function(...args) { for (const i of indices) check(args[i]); return original.apply(this,args); };
}
for (const name of single) { wrap(fs,name,[0]);wrap(fs,name+'Sync',[0]);wrap(promises,name,[0]); }
for (const name of pairs) { wrap(fs,name,[0,1]);wrap(fs,name+'Sync',[0,1]);wrap(promises,name,[0,1]); }
for (const name of ['copyFile','cp','symlink']) { wrap(fs,name,[1]);wrap(fs,name+'Sync',[1]);wrap(promises,name,[1]); }
function writable(flags) { return typeof flags === 'number' ? !!(flags & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)) : /[wa+]/.test(flags ?? 'r'); }
for (const object of [fs,promises]) for (const name of ['open','openSync']) {
    if (typeof object[name] !== 'function') continue;
    const original = object[name]; object[name] = function(path,flags,...args) {
        if(writable(flags)) check(path);
        if(object===fs && name==='open') {
            const callback=args.at(-1);
            if(typeof callback==='function') args[args.length-1]=function(error,fd){if(!error)descriptors.set(fd,path);return callback(error,fd);};
        }
        const result=original.call(this,path,flags,...args);
        if(object!==promises) {if(name==='openSync')descriptors.set(result,path);return result;}
        return result.then(handle=>{
            const fd=handle.fd;descriptors.set(fd,path);
            const close=handle.close;handle.close=async function(...values){try{return await close.apply(this,values);}finally{descriptors.delete(fd);}};
            for(const method of ['write','writev','writeFile','appendFile','truncate','chmod','chown','utimes','createWriteStream']) {
                if(typeof handle[method]!=='function') continue;
                const operation=handle[method];handle[method]=function(...values){check(path);return operation.apply(this,values);};
            }
            return handle;
        });
    };
}
wrap(fs,'createWriteStream',[0]);
const closeSync=fs.closeSync;fs.closeSync=function(fd){const result=closeSync.call(this,fd);descriptors.delete(fd);return result;};
const close=fs.close;fs.close=function(fd,callback){return close.call(this,fd,error=>{if(!error)descriptors.delete(fd);callback(error);});};
for (const name of ['write','writeSync','writev','writevSync','ftruncate','ftruncateSync','fchmod','fchmodSync','fchown','fchownSync','futimes','futimesSync']) wrap(fs,name,[0]);
syncBuiltinESMExports();

export {check as assertTestMutationAllowed};
