import {mkdtemp,readFile,writeFile,mkdir,rm,rename,unlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {renameSync} from 'node:fs';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {registerNativeTestRoot} from './NativeTempGuard.mjs';

export const HEAD='0eb3aa2906f574f1da3815f96313678261a3b2ec';
export const BRANCH='build/1003.9A1';
export const fixtureDirectory=new URL('./fixtures/new-execution-era-real/',import.meta.url);
// Fast failure tests use an explicitly identified adapter. Native evidence is
// collected separately; these tests never claim to prove Windows durability.
export const testDurability={sync:()=> 'DIRECTORY_SYNCED',syncFile:async()=>{},
    ensureDirectory:p=>mkdir(p,{recursive:true}),replace:(a,b)=>renameSync(a,b),
    archive:async(a,b)=>{await link(a,b);await unlink(a);},remove:p=>unlink(p)};
export async function eraFixture(t,{native=false,hook=()=>{}}={}){
    const root=await mkdtemp(join(tmpdir(),'lz-era02-test-'));
    registerNativeTestRoot(root);
    t.after(async()=>{const rel=relative(resolve(tmpdir()),resolve(root));assert.ok(rel.startsWith('lz-era02-test-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
    const inventory=JSON.parse(await readFile(new URL('inventory.json',fixtureDirectory)));
    const paths={};
    for(const item of inventory.artifacts){
        const bytes=await readFile(new URL(item.key+'.bytes',fixtureDirectory));assert.equal(hash(bytes),item.sha256);
        paths[item.key]=join(root,item.key+'.json');await writeFile(paths[item.key],bytes);
    }
    paths.ledgerLock=paths.ledger+'.lock';paths.bootstrap=paths.ledger+'.bootstrap';
    paths.authorityLock=paths.authority+'.lock';paths.scheduledJournal=join(root,'scheduled.json');paths.scheduledLock=paths.scheduledJournal+'.lock';
    for(const key of ['ledgerLock','bootstrap','authorityLock','scheduledLock'])await writeFile(paths[key],await readFile(new URL(key+'.bytes',fixtureDirectory)));
    // Remove duplicate temporary fixture names before the namespace capture.
    for(const key of ['ledgerLock','bootstrap','authorityLock','scheduledLock'])await unlink(join(root,key+'.json'));
    const host={reserve:async()=>async()=>{},proveOffline:async()=>({absent:true}),inspect:async()=>({
        root,branch:BRANCH,head:HEAD,administrator:true,service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},
        media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},bootstrapPermission:false,ports:[],proof:{absent:true}})};
    const options={root,paths,host,expected:{head:HEAD,branch:BRANCH},hook,runtimeCapabilityProof:process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY,
        ...(native?{}:{durability:testDurability,native:{capability:()=>({testDouble:true})},verifyRuntimeCapability:()=>({testDouble:true,proofHash:'f'.repeat(64)})})};
    const writer=new NewExecutionEra(options),view=await writer.dryRun();assert.equal(view.classification,'EXACT_ELIGIBLE_LEGACY_STATE',view.reason);
    const authorization=await writer.plan({principal:'TEMP-test-operator',approvedHead:HEAD,approvedBranch:BRANCH,
        expectedInventoryHash:view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
    return {root,paths,writer,authorization,options,view};
}
