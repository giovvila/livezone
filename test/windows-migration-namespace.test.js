import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rename,stat} from 'node:fs/promises';
import {recoveryIntegrityFixture} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact} from '../server/recovery/RecoveryContract.js';
import {classifyMigrationNames,assertCanonicalNames,namespaceKey} from '../server/recovery/RecoveryNamespace.js';
import {readEvidence} from '../server/recovery/PersistentEvidence.js';
import {assertScheduledTerminalNamespace} from '../server/scheduler/ScheduledExecutionProvenance.js';
const windows={skip:process.platform!=='win32',timeout:180000};
test('R27 exact paired unknown stage case-only rename remains blocked',windows,async t=>{
 const h=await recoveryIntegrityFixture(t,{unicode:'é'}),ledger=await readFile(h.p.ledger);
 const lower=h.p.ledger+'.migration.review.stage',upper=h.p.ledger+'.MIGRATION.review.STAGE';
 const raw=Buffer.from([0xff,0x80,0xc0]);await writeFile(lower,raw);
 let reservations=0;h.host.reserve=async()=>{reservations++;return ()=>{};};
 await assert.rejects(h.w.begin(),{code:'LEDGER_MIGRATION_UNKNOWN_ARTIFACT'});
 const id=(await stat(lower,{bigint:true})).ino;await rename(lower,upper);
 assert.equal((await stat(upper,{bigint:true})).ino,id);
 assert.deepEqual(await readFile(upper),raw);
 await assert.rejects(h.w.begin(),{code:'LEDGER_MIGRATION_UNKNOWN_ARTIFACT'});
 assert.deepEqual(await readFile(h.p.ledger),ledger);assert.equal(JSON.parse(ledger).schemaVersion,1);
 for(const p of [h.p.migrationIntent,h.w.audit+'.prepared',h.p.ledgerWal])assert.equal(await artifact(p),null);
 assert.equal(h.restoreCalls(),0);
 assert.equal(reservations,0);assert.equal(await artifact(h.w.audit+'.start'),null);assert.equal(await artifact(h.w.audit+'.ready'),null);
});
const suffixes=['intent.stage','intent','base.stage','snapshot.stage','activation.stage','activated','completion.stage','completed'];
test('Windows classifier handles canonical, unknown, foreign and unrelated names',()=>{
 for(const tail of ['.migration.review.stage','.MIGRATION.review.STAGE','.Migration.intent.tmp','.migration.activation.STAGE.extra','.migration.completed.extra','.MIGRATION','.Migration-intent.stage'])
  assert.equal(classifyMigrationNames(['ledger.json'+tail],'ledger.json',suffixes,'win32')[0].kind,'UNKNOWN');
 for(const tail of ['.foreign.STAGE','.foreign.TMP'])assert.equal(classifyMigrationNames(['ledger.json'+tail],'ledger.json',suffixes,'win32')[0].kind,'FOREIGN_STAGE');
 for(const name of ['other.MIGRATION.review.STAGE','ledger.json-other.stage','notes.txt'])assert.equal(classifyMigrationNames([name],'ledger.json',suffixes,'win32')[0].kind,'UNRELATED');
 for(const suffix of suffixes)assert.equal(classifyMigrationNames(['ledger.json.migration.'+suffix],'ledger.json',suffixes,'win32')[0].kind,'KNOWN');
});
test('Known aliases and duplicate logical entries deterministically fail closed',()=>{
 for(const suffix of suffixes){const a='ledger.json.migration.'+suffix,b='LEDGER.JSON.MIGRATION.'+suffix.toUpperCase();
  assert.throws(()=>classifyMigrationNames([b],'ledger.json',suffixes,'win32'),{code:'LEDGER_MIGRATION_NONCANONICAL_ARTIFACT'});
  for(const names of [[a,b],[b,a]])assert.throws(()=>classifyMigrationNames(names,'ledger.json',suffixes,'win32'),{code:'LEDGER_MIGRATION_NONCANONICAL_ARTIFACT_AMBIGUOUS'});
 }
 assert.throws(()=>assertCanonicalNames(['phase.ready','PHASE.READY'],['phase.ready'],{platform:'win32'}),{code:'RECOVERY_NAMESPACE_NONCANONICAL_AMBIGUOUS'});
});
test('POSIX preserves distinct case; ASCII filename key does not normalize Unicode',()=>{
 assert.equal(classifyMigrationNames(['ledger.json.MIGRATION.review.STAGE'],'ledger.json',suffixes,'linux')[0].kind,'UNRELATED');
 assert.doesNotThrow(()=>assertCanonicalNames(['phase','PHASE'],['phase'],{platform:'linux'}));
 assert.equal(namespaceKey('ÉA','win32'),'Éa');
});
for(const suffix of suffixes)test(`Windows actual known alias rejected: ${suffix}`,windows,async t=>{
 const h=await recoveryIntegrityFixture(t),ledger=await readFile(h.p.ledger);
 const canonical=h.p.ledger+'.migration.'+suffix,variant=h.p.ledger+'.MIGRATION.'+suffix.toUpperCase();
 await writeFile(canonical,Buffer.from([0xff,0x80]));const id=(await stat(canonical,{bigint:true})).ino;
 await rename(canonical,variant);assert.equal((await stat(canonical,{bigint:true})).ino,id);
 for(const action of [()=>h.w.begin(),()=>h.migration.start()])await assert.rejects(action(),{code:'LEDGER_MIGRATION_NONCANONICAL_ARTIFACT'});
 assert.deepEqual(await readFile(h.p.ledger),ledger);assert.equal(h.restoreCalls(),0);
});
test('Windows foreign temporary alias is blocked and unrelated name is ignored',windows,async t=>{
 const h=await recoveryIntegrityFixture(t);await writeFile(h.p.ledger+'.foreign.TMP','bad');
 await assert.rejects(h.migration.view(),{code:'LEDGER_MIGRATION_FOREIGN_STAGE'});
});
test('Unrelated artifact does not prevent canonical Prepare',windows,async t=>{
 const h=await recoveryIntegrityFixture(t);await writeFile(h.p.ledger+'-other.MIGRATION.review.STAGE',Buffer.from([0xff]));
 assert.equal((await h.w.begin()).migrationState,'INTENT_DURABLE');assert.equal(h.restoreCalls(),0);
});
test('Foreign identity intent alias cannot be adopted',windows,async t=>{
 const h=await recoveryIntegrityFixture(t),other=await recoveryIntegrityFixture(t);
 await other.w.begin();const foreign=await readFile(other.p.migrationIntent);
 const variant=h.p.ledger+'.MIGRATION.INTENT.STAGE';await writeFile(variant,foreign);
 await assert.rejects(h.w.begin(),{code:'LEDGER_MIGRATION_NONCANONICAL_ARTIFACT'});
 assert.deepEqual(await readFile(variant),foreign);assert.equal(await artifact(h.p.migrationIntent),null);
});
for(const suffix of ['', '.wal','.bootstrap'])test(`Canonical ledger access rejects case alias: ${suffix||'snapshot'}`,windows,async t=>{
 const h=await recoveryIntegrityFixture(t),canonical=h.p.ledger+suffix,variant=canonical.toUpperCase();
 if(suffix==='.wal')await writeFile(canonical,'malformed');
 await rename(canonical,variant);
 await assert.rejects(h.w.begin(),{code:'LEDGER_MIGRATION_NONCANONICAL_ARTIFACT'});
});
test('Canonical evidence access refuses a Unicode alias without interpreting its bytes',windows,async t=>{
 const h=await recoveryIntegrityFixture(t),path=h.root+'/évidence.json';
 await writeFile(path,Buffer.from([0xff]));await rename(path,h.root+'/ÉVIDENCE.JSON');
 await assert.rejects(readEvidence(path),{code:'RECOVERY_NAMESPACE_NONCANONICAL'});
});
test('Scheduled terminal namespace rejects altered reserved spelling',windows,async t=>{
 const h=await recoveryIntegrityFixture(t);await writeFile(h.p.scheduled+'.RECONCILIATION-review.JSON','{}');
 await assert.rejects(assertScheduledTerminalNamespace(h.p.scheduled),{code:'LEDGER_V2_TERMINAL_SCHEDULED_AMBIGUOUS'});
});
