import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,openSync,closeSync,fsyncSync,writeFileSync,readFileSync,
    renameSync,unlinkSync,existsSync,statfsSync,rmSync} from 'node:fs';
import {tmpdir,release} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {directorySync,requireDirectory} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';

// Diagnostic only: successful syscalls are NOT a namespace durability capability.
// Never pass these results as a syncDirectory override to a repository.
function fixture(t) {
    const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'lz-r4-capability-'));
    t.after(()=>{
        const rel=relative(root,realpathSync(dir));
        assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.startsWith('lz-r4-capability-'));
        rmSync(dir,{recursive:true,force:true});
    });
    return dir;
}
function flush(path,flags) {
    let fd;
    try {fd=openSync(path,flags);fsyncSync(fd);return {result:'SUCCESS'};}
    catch(e) {return {result:'ERROR',code:e.code,syscall:e.syscall};}
    finally {if(fd!==undefined)closeSync(fd);}
}
test('Windows TEMP syscall observations do not authorize namespace durability',{skip:process.platform!=='win32'},t=>{
    const dir=fixture(t),file=join(dir,'ledger'),stage=join(dir,'stage'),archive=join(dir,'archive');
    writeFileSync(file,'previous',{flag:'wx'});
    assert.deepEqual(flush(file,'r+'),{result:'SUCCESS'});
    const directoryModes=Object.fromEntries(['r','r+','rs','rs+'].map(mode=>[mode,flush(dir,mode)]));
    const operations=[];
    writeFileSync(stage,'next',{flag:'wx'});assert.deepEqual(flush(stage,'r+'),{result:'SUCCESS'});
    operations.push({operation:'create-stage',flush:flush(dir,'r+')});
    renameSync(stage,file);assert.equal(readFileSync(file,'utf8'),'next');
    operations.push({operation:'replace-canonical',flush:flush(dir,'r+')});
    renameSync(file,archive);assert.equal(readFileSync(archive,'utf8'),'next');
    operations.push({operation:'archive',flush:flush(dir,'r+')});
    unlinkSync(archive);assert.equal(existsSync(archive),false);
    operations.push({operation:'remove',flush:flush(dir,'r+')});
    t.diagnostic(JSON.stringify({node:process.version,uv:process.versions.uv,windows:release(),
        filesystemType:statfsSync(dir).type,directoryModes,operations,powerLossTested:false}));
    // R5 supersedes the R4 Node-only gate with independently verified native evidence.
    assert.equal(directorySync(file),'DIRECTORY_SYNCED');
    assert.doesNotThrow(()=>requireDirectory(file,directorySync));
});
test('Windows unproven capability leaves a new TEMP ledger blocked without lock or WAL',{skip:process.platform!=='win32'},async t=>{
    const dir=fixture(t),path=join(dir,'ledger.json');
    const repo=new Repository({path,create:true,authority:{authorityEpoch:22,authorityProcessSession:'r4-capability'},syncDirectory:()=> 'FILE_SYNC_ONLY'});
    try {
        await repo.initialize();
        assert.equal(repo.status,'UNAVAILABLE');
        assert.equal(repo.error,'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
        for(const suffix of ['', '.lock','.wal'])assert.equal(existsSync(path+suffix),false);
    } finally {await repo.close();}
});
