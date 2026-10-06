import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {isUtf8} from 'node:buffer';
import {recoveryIntegrityFixture} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact} from '../server/recovery/RecoveryContract.js';
const windows={skip:process.platform!=='win32',timeout:180000};
async function interrupted(t,unicode){
 const h=await recoveryIntegrityFixture(t,{unicode});
 const ledger=await readFile(h.p.ledger);await h.w.begin();
 const intent=await readFile(h.p.migrationIntent),audit=await readFile(h.w.audit);
 await unlink(h.p.migrationIntent);
 return {h,ledger,intent,audit};
}
for(const [name,unicode,inside] of [['ASCII','',false],['R25-A 2-byte','è',true],['3-byte','漢',true],['4-byte','😀',true]])
test(`Prepare resumes exact intent prefix: ${name}`,windows,async t=>{
 const {h,ledger,intent,audit}=await interrupted(t,unicode);
 const offset=inside?intent.indexOf(Buffer.from(unicode))+1:20;
 assert.ok(offset>0);const partial=intent.subarray(0,offset);
 assert.equal(isUtf8(partial),!inside);await writeFile(h.p.migrationIntentStage,partial);
 assert.equal((await h.w.migration.view()).migrationState,'INTENT_STAGING');
 if(inside)await assert.rejects(artifact(h.p.migrationIntentStage),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
 await h.w.begin();await h.w.prepared();
 assert.deepEqual(await readFile(h.p.migrationIntent),intent);
 assert.deepEqual(await readFile(h.w.audit),audit);assert.deepEqual(await readFile(h.p.ledger),ledger);
 assert.equal(await artifact(h.p.migrationIntentStage),null);assert.equal(await artifact(h.p.ledgerWal),null);
 assert.ok(await artifact(h.w.audit+'.prepared'));assert.equal(h.restoreCalls(),0);
});
for(const [name,mutate] of [
 ['random invalid bytes',()=>Buffer.from([0xff,0x80])],
 ['valid UTF8 wrong prefix',()=>Buffer.from('wrong')],
 ['complete malformed JSON',()=>Buffer.from('{broken}\n')],
 ['wrong schema',()=>Buffer.from('{"schemaVersion":99}\n')],
 ['another migration identity',b=>Buffer.from(b.toString().replace('"transactionId":"','"transactionId":"foreign-'))],
 ['oversized expected prefix',b=>Buffer.concat([b,Buffer.from(' ')])],
])test(`Prepare rejects unowned staging: ${name}`,windows,async t=>{
 const {h,ledger,intent}=await interrupted(t,'è');const partial=mutate(intent);await writeFile(h.p.migrationIntentStage,partial);
 await assert.rejects(h.w.begin(),{code:'LEDGER_MIGRATION_STAGE_CORRUPT'});
 assert.deepEqual(await readFile(h.p.migrationIntentStage),partial);assert.deepEqual(await readFile(h.p.ledger),ledger);
 for(const p of [h.p.migrationIntent,h.p.ledgerWal,h.w.audit+'.prepared',h.p.gate])assert.equal(await artifact(p),null);
});
test('Complete intent remains strict UTF8 even with a legitimate stage',windows,async t=>{
 const {h,intent}=await interrupted(t,'è');await writeFile(h.p.migrationIntentStage,intent.subarray(0,20));
 await writeFile(h.p.migrationIntent,Buffer.concat([intent,Buffer.from([0xff])]));
 await assert.rejects(h.w.begin(),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
 assert.equal(await artifact(h.w.audit+'.prepared'),null);
});
test('Prepare resumed staging still enforces R24 maintenance fence before intent',windows,async t=>{
 const {h,intent,ledger}=await interrupted(t,'漢');const cut=intent.indexOf(Buffer.from('漢'))+1;
 await writeFile(h.p.migrationIntentStage,intent.subarray(0,cut));const maintenance=await readFile(h.p.maintenance);
 h.w.hook=async s=>{if(s==='migration-before-intent')await writeFile(h.p.maintenance,Buffer.concat([maintenance,Buffer.from(' ')]));};
 await assert.rejects(h.w.begin(),{code:'PREFLIGHT_EVIDENCE_CHANGED'});
 assert.equal(await artifact(h.p.migrationIntent),null);assert.equal(await artifact(h.w.audit+'.prepared'),null);
 assert.deepEqual(await readFile(h.p.migrationIntentStage),intent.subarray(0,cut));assert.deepEqual(await readFile(h.p.ledger),ledger);
});
test('Start uses the same byte-prefix resume and durable installation contract',windows,async t=>{
 const {h,intent,ledger}=await interrupted(t,'😀');const cut=intent.indexOf(Buffer.from('😀'))+1;
 await writeFile(h.p.migrationIntentStage,intent.subarray(0,cut));
 let authorizations=0;await h.w.migration.start({authorize:async()=>{authorizations++;}});
 assert.ok(authorizations>0);assert.deepEqual(await readFile(h.p.migrationIntent),intent);
 const final=await artifact(h.p.ledger),original=JSON.parse(ledger);
 assert.equal(final.value.schemaVersion,2);assert.deepEqual(final.value.snapshot.entries,original.entries);
 assert.equal(final.value.snapshot.generation,original.generation);
 assert.equal((await h.w.migration.inspect()).migrationState,'COMPLETED');
 for(const suffix of ['intent','base','snapshot','activation','completion'])assert.equal(await artifact(h.p.ledger+'.migration.'+suffix+'.stage'),null);
 assert.equal(h.restoreCalls(),0);
});
