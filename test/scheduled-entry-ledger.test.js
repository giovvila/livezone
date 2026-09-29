import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,unlink,rm,open,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as native from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {scheduledEntryIdentity} from '../server/scheduler/ScheduledEntryIdentity.js';
import {ledgerSnapshot,validateLedgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerRepository.js';

const event={eventId:'event',incarnationId:'12345678-1234-1234-1234-123456789abc',
    entryRevision:1,type:'source.live',sourceId:'source',
    startAt:'2026-09-29T00:09:00.000+02:00',endAt:'2026-09-29T00:11:00.000+02:00'};
const context={consumedAt:'2026-09-28T22:09:00.020Z',authorityEpoch:20,authorityProcessSession:'test-session'};
const identity=scheduledEntryIdentity(event);
const failure=()=>{throw Object.assign(Error('injected'),{code:'EIO'});};

async function fixture(t) {
    const root=resolve(tmpdir());
    const dir=await mkdtemp(join(root,'lz-entry-core-'));
    const path=join(dir,'state.json.scheduled-entry-ledger.json');
    const repositories=[];
    const make=options=>{
        const repository=new Repository({path,...options});
        repositories.push(repository); return repository;
    };
    t.after(async()=>{
        for(const repository of repositories) await repository.close();
        const child=relative(root,resolve(dir));
        assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('lz-entry-core-'));
        await rm(dir,{recursive:true,force:true});
    });
    return {path,dir,make};
}

test('identity is deterministic, property-order independent, timezone normalized and cosmetic-independent',()=>{
    assert.deepEqual(scheduledEntryIdentity({...event}),identity);
    assert.deepEqual(scheduledEntryIdentity(Object.fromEntries(Object.entries(event).reverse())),identity);
    assert.deepEqual(scheduledEntryIdentity({...event,startAt:'2026-09-28T22:09:00Z',endAt:'2026-09-28T22:11:00Z'}),identity);
    assert.deepEqual(scheduledEntryIdentity({...event,name:'new title',updatedAt:'later',scheduleRevision:999,priority:100}),identity);
    assert.match(identity.entryKey,/^[a-f0-9]{64}$/);
    assert.equal(identity.startAt,'2026-09-28T22:09:00.000Z');
    assert.ok(Object.isFrozen(identity));
});

for(const [field,value] of Object.entries({eventId:'other',incarnationId:'aaaaaaaa-1234-1234-1234-123456789abc',
    entryRevision:2,sourceId:'other',startAt:'2026-09-28T22:09:01Z',endAt:'2026-09-28T22:12:00Z'})) {
    test(`identity changes for ${field}`,()=>assert.notEqual(scheduledEntryIdentity({...event,[field]:value}).entryKey,identity.entryKey));
}
test('A -> B -> A with increasing entryRevision never resurrects A',()=>{
    const b=scheduledEntryIdentity({...event,sourceId:'B',entryRevision:2});
    const aAgain=scheduledEntryIdentity({...event,entryRevision:3});
    assert.equal(new Set([identity.entryKey,b.entryKey,aAgain.entryKey]).size,3);
});
for(const patch of [{entryRevision:0},{entryRevision:1.5},{incarnationId:'not-an-incarnation'},
    {type:'overlay.crawl'},{sourceId:''},{startAt:'2026-02-30T00:00:00Z'},
    {startAt:'2026-09-28T22:09:00'},{startAt:'2026-09-28T22:09:00+25:00'},
    {endAt:event.startAt},{entryKey:'forged'},{identitySchema:2}]) {
    test(`invalid identity rejected: ${JSON.stringify(patch)}`,()=>assert.throws(()=>scheduledEntryIdentity({...event,...patch})));
}

test('explicit creation, inspect, sequential consume, immutable record and restart',async t=>{
    const f=await fixture(t), repo=f.make({create:true});
    await repo.initialize();
    assert.equal(repo.status,'READY');
    assert.equal((await repo.inspect(identity)).status,'UNCONSUMED');
    const first=await repo.consume(identity,context);
    assert.equal(first.status,'CONSUMED');
    assert.equal(first.record.state,'ENTRY_CONSUMED');
    assert.equal(first.record.identity.entryKey,identity.entryKey);
    assert.equal(first.record.authorityEpoch,20);
    assert.ok(Object.isFrozen(first.record));
    assert.equal(Object.hasOwn(first,'executionAllowed'),false);
    const bytes=await readFile(f.path,'utf8');
    assert.equal((await repo.consume(identity,{...context,authorityEpoch:21})).status,'ALREADY_CONSUMED');
    assert.equal(await readFile(f.path,'utf8'),bytes);
    await repo.close();
    const reopened=f.make(); await reopened.initialize();
    assert.deepEqual(await reopened.inspect(identity),{status:'ALREADY_CONSUMED',record:first.record});
    assert.equal((await reopened.consume(identity,context)).status,'ALREADY_CONSUMED');
    assert.equal(await readFile(f.path,'utf8'),bytes);
});

test('concurrent consume: exactly one CONSUMED, one ALREADY_CONSUMED',async t=>{
    const f=await fixture(t), repo=f.make({create:true});
    const results=await Promise.all([repo.consume(identity,context),repo.consume(identity,context)]);
    assert.deepEqual(results.map(r=>r.status),['CONSUMED','ALREADY_CONSUMED']);
    assert.equal(results[0].record.consumptionId,results[1].record.consumptionId);
    assert.equal(validateLedgerSnapshot(JSON.parse(await readFile(f.path,'utf8'))).generation,1);
});

test('concurrent different identities preserve every consumption through restart',async t=>{
    const f=await fixture(t), repo=f.make({create:true});
    const identities=Array.from({length:20},(_,i)=>scheduledEntryIdentity({...event,entryRevision:i+1}));
    assert.ok((await Promise.all(identities.map(i=>repo.consume(i,context)))).every(r=>r.status==='CONSUMED'));
    await repo.close();
    const reopened=f.make();
    assert.ok((await Promise.all(identities.map(i=>reopened.inspect(i)))).every(r=>r.status==='ALREADY_CONSUMED'));
});

test('queued inputs are copied before the caller can change them',async t=>{
    const f=await fixture(t), repo=f.make({create:true});
    const input={...event}, ctx={...context};
    const pending=repo.consume(input,ctx);
    input.sourceId='changed';ctx.authorityEpoch=99;
    const answer=await pending;
    assert.equal(answer.record.identity.sourceId,'source');
    assert.equal(answer.record.authorityEpoch,20);
});

test('writer conflict never unlinks first writer lock; close permits a new writer',async t=>{
    const f=await fixture(t), first=f.make({create:true}); await first.initialize();
    const lock=await readFile(f.path+'.lock','utf8');
    const second=f.make(); await second.initialize();
    assert.equal((await second.consume(identity,context)).status,'CONFLICT');
    assert.equal((await second.inspect(identity)).status,'UNAVAILABLE');
    await second.close(); assert.equal(await readFile(f.path+'.lock','utf8'),lock);
    assert.equal((await first.consume(identity,context)).status,'CONSUMED');
    await first.close();
    const third=f.make(); await third.initialize(); assert.equal(third.status,'READY');
});

test('preexisting abandoned lock is never broken using PID or age',async t=>{
    const f=await fixture(t), bytes=JSON.stringify({pid:2147483647,at:'1970-01-01T00:00:00.000Z'});
    await writeFile(f.path+'.lock',bytes);
    const repo=f.make({create:true}); await repo.initialize(); await repo.close();
    assert.equal(repo.status,'CONFLICT'); assert.equal(await readFile(f.path+'.lock','utf8'),bytes);
    await assert.rejects(access(f.path),{code:'ENOENT'});
});

test('missing file is unavailable without explicit creation',async t=>{
    const f=await fixture(t), repo=f.make();
    assert.equal((await repo.inspect(identity)).status,'UNAVAILABLE');
    assert.equal((await repo.consume(identity,context)).status,'UNAVAILABLE');
    await assert.rejects(access(f.path),{code:'ENOENT'});
});

for(const method of ['inspect','consume']) {
    test(`file disappearance after initialization fails closed on ${method} and reopen`,async t=>{
        const f=await fixture(t), repo=f.make({create:true}); await repo.initialize();
        await repo.consume(identity,context); await unlink(f.path);
        assert.equal((await repo[method](identity,context)).status,'UNAVAILABLE');
        await repo.initialize();
        assert.equal((await repo.consume(identity,context)).status,'UNAVAILABLE');
        await assert.rejects(access(f.path),{code:'ENOENT'});
        await repo.close();
        assert.equal((await f.make().inspect(identity)).status,'UNAVAILABLE');
    });
}

for(const kind of ['json','schema','checksum','state','duplicate']) {
    test(`corrupt ${kind} is never replaced by empty ledger, even with create:true`,async t=>{
        const f=await fixture(t), initial=f.make({create:true});
        await initial.consume(identity,context); await initial.close();
        const value=JSON.parse(await readFile(f.path,'utf8'));
        if(kind==='schema')value.schemaVersion=2;
        if(kind==='checksum')value.checksum.value='0'.repeat(64);
        if(kind==='state')value.entries[0].state='ABORTED';
        if(kind==='duplicate')value.entries.push(value.entries[0]);
        const bytes=kind==='json'?'broken JSON':JSON.stringify(value);
        await writeFile(f.path,bytes);
        const repo=f.make({create:true});
        assert.equal((await repo.inspect(identity)).status,'UNAVAILABLE');
        assert.equal((await repo.consume(identity,context)).status,'UNAVAILABLE');
        assert.equal(await readFile(f.path,'utf8'),bytes);
    });
}

test('valid but replaced/rolled-back snapshot is rejected during an open session',async t=>{
    const f=await fixture(t), repo=f.make({create:true}); await repo.initialize();
    const old=await readFile(f.path,'utf8'); await repo.consume(identity,context);
    await writeFile(f.path,old);
    assert.equal((await repo.inspect(identity)).status,'UNAVAILABLE');
    assert.equal((await repo.consume(identity,context)).status,'UNAVAILABLE');
});

for(const point of ['opened','written','flushed','staged','before-replace','replaced','durable']) {
    test(`fault at ${point}: no success, fail-closed, safe reopening policy`,async t=>{
        const f=await fixture(t);
        let armed=false;
        const repo=f.make({create:true,hook:stage=>{if(armed && stage===point)failure();}});
        await repo.initialize(); const before=await readFile(f.path,'utf8'); armed=true;
        const uncertain=['before-replace','replaced','durable'].includes(point);
        const response=await repo.consume(identity,context);
        assert.equal(response.status,uncertain?'DURABILITY_UNCERTAIN':'UNAVAILABLE');
        assert.equal(repo.snapshot.entries.length,0,'failed operation must not publish consumption in memory');
        assert.equal((await repo.inspect(identity)).status,'UNAVAILABLE');
        assert.notEqual((await repo.consume(identity,context)).status,'CONSUMED');
        await repo.close();
        const reopened=f.make(); await reopened.initialize();
        if(uncertain) {
            assert.equal(reopened.status,'CONFLICT','uncertain writer retains lock for explicit future reconciliation');
            await access(f.path+'.lock');
        } else {
            assert.equal(await readFile(f.path,'utf8'),before);
            assert.equal((await reopened.inspect(identity)).status,'UNCONSUMED');
        }
        if(['replaced','durable'].includes(point)) {
            assert.equal(validateLedgerSnapshot(JSON.parse(await readFile(f.path,'utf8'))).entries[0].state,'ENTRY_CONSUMED');
        }
    });
}

for(const operation of ['writeFile','sync','renameSync','fsyncSync']) {
    test(`actual ${operation} failure injection never reports CONSUMED`,async t=>{
        const f=await fixture(t); let armed=false;
        const operations=['renameSync','fsyncSync'].includes(operation)
            ? {[operation]:(...args)=>{if(armed)failure();return native[operation](...args);}}
            : {open:async(...args)=>{
                const handle=await open(...args);
                if(String(args[0]).endsWith('.tmp')) {
                    const original=handle[operation].bind(handle);
                    handle[operation]=(...values)=>armed?Promise.reject(Object.assign(Error('injected'),{code:'EIO'})):original(...values);
                }
                return handle;
            }};
        const repo=f.make({create:true,operations}); await repo.initialize(); assert.equal(repo.status,'READY'); armed=true;
        const value=await repo.consume(identity,context);
        assert.equal(value.status,['renameSync','fsyncSync'].includes(operation)?'DURABILITY_UNCERTAIN':'UNAVAILABLE');
        assert.equal((await repo.inspect(identity)).status,'UNAVAILABLE');
    });
}

test('storage read failure fails closed without publishing an empty state',async t=>{
    const f=await fixture(t); let armed=false;
    const repo=f.make({create:true,operations:{readFile:(...args)=>armed?Promise.reject(Object.assign(Error('denied'),{code:'EACCES'})):readFile(...args)}});
    await repo.consume(identity,context); armed=true;
    assert.equal((await repo.inspect(identity)).status,'UNAVAILABLE');
    assert.equal(repo.snapshot.entries.length,1);
});

test('disappearance after staging is caught before replacement',async t=>{
    const f=await fixture(t); let armed=false;
    const repo=f.make({create:true,hook:stage=>{if(armed && stage==='staged')native.unlinkSync(f.path);}});
    await repo.initialize(); armed=true;
    assert.equal((await repo.consume(identity,context)).status,'UNAVAILABLE');
    await assert.rejects(access(f.path),{code:'ENOENT'});
});

test('closed repository cannot create or consume',async t=>{
    const f=await fixture(t), repo=f.make({create:true}); await repo.close();
    assert.equal((await repo.consume(identity,context)).status,'UNAVAILABLE');
    await assert.rejects(access(f.path),{code:'ENOENT'});
});

test('public paths rejected; empty schema roundtrips',()=>{
    assert.throws(()=>new Repository({path:resolve('public','ledger.json')}),/PRIVATE/);
    assert.throws(()=>new Repository({path:'relative.json'}),/PRIVATE/);
    const snapshot=ledgerSnapshot(); assert.deepEqual(validateLedgerSnapshot(snapshot),snapshot);
});
