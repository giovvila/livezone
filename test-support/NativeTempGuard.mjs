// Test preload only. Protect the native execution boundary as well as JS fs.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {realpathSync,existsSync,lstatSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,basename,join} from 'node:path';
import {tmpdir} from 'node:os';
const registry=globalThis[Symbol.for('livezone.nativeTempGuard')]??={roots:new Set(),installed:false};
const roots=registry.roots;
const reject=()=>{throw Object.assign(Error('NATIVE_TEST_TARGET_OUTSIDE_TEMP'),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});};
export function registerNativeTestRoot(root){
    if(!isAbsolute(root))reject();root=resolve(root);
    const child=relative(realpathSync(tmpdir()),realpathSync(root));
    if(!child||child.startsWith('..')||isAbsolute(child)||lstatSync(root).isSymbolicLink())reject();
    roots.add(realpathSync(root).toLowerCase());return root;
}
for(const root of JSON.parse(process.env.LIVEZONE_NATIVE_TEST_ROOTS||'[]'))registerNativeTestRoot(root);
export function assertNativeTestTarget(path){
    if(typeof path!=='string'||!isAbsolute(path))reject();
    let ancestor=resolve(path);const tail=[];
    while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)reject();tail.unshift(basename(ancestor));ancestor=parent;}
    const target=join(realpathSync(ancestor),...tail).toLowerCase();
    for(const root of roots){const rel=relative(root,target);if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))return;}
    reject();
}
function check(executable,args,options){
    if(basename(executable).toLowerCase()==='windows-ledger-durability.exe'){
        if(!Array.isArray(args)||args.length<2)reject();for(const path of args.slice(1))assertNativeTestTarget(path);return;
    }
    if(typeof options?.input!=='string')return;
    const fields=options.input.trimEnd().split('\n');
    if(fields.length<4)return;
    let helper;try{helper=Buffer.from(fields[1],'base64').toString('utf8');}catch{return;}
    if(basename(helper).toLowerCase()!=='windows-ledger-durability.exe')return;
    if(fields.length<5)reject();
    for(const value of fields.slice(4))assertNativeTestTarget(Buffer.from(value,'base64').toString('utf8'));
}
if(!registry.installed){
    for(const name of ['spawnSync','spawn']){const original=childProcess[name];childProcess[name]=function(executable,args,options){check(executable,args,options);return original.call(this,executable,args,options);};}
    registry.installed=true;
}
syncBuiltinESMExports();
