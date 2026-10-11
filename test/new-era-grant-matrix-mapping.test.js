import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {grantBoundaries} from '../test-support/EraGrantBoundaries.js';
test('510 canonical boundaries retain the exact 14 grant and 13 publication production mapping',async()=>{
 const csv=await readFile(new URL('../docs/NEW-ERA-07-NATIVE-ABRUPT-MATRIX.csv',import.meta.url),'utf8');
 const boundaries=csv.trim().split(/\r?\n/).slice(1).map(line=>JSON.parse(line.match(/^\d+,("(?:[^"\\]|\\.)*")/)[1]));
 assert.equal(boundaries.length,510);assert.equal(new Set(boundaries).size,510);
 const grant=await readFile(new URL('../server/recovery/ExecutionEraContract.js',import.meta.url),'utf8');
 const store=await readFile(new URL('../server/scheduler/ScheduleStore.js',import.meta.url),'utf8');
 const issuance=[...grant.slice(grant.indexOf('async function issueEraEntryOwned')).matchAll(/await emit\('([^']+)'\)/g)].map(m=>'grant/'+m[1]);
 const publication=[...store.matchAll(/await emit\('([^']+)'\)/g)].map(m=>'grant-schedule/'+m[1]);
 publication.push(...[...store.matchAll(/eraGrantHook\?\.\('grant-schedule\/([^']+)'/g)].map(m=>'grant-schedule/'+m[1]));
 assert.equal(issuance.length,14);assert.equal(publication.length,13);
 assert.deepEqual([...issuance,...publication].sort(),[...grantBoundaries].sort());
 assert.deepEqual(boundaries.filter(b=>/^grant(?:-schedule)?\//.test(b)).sort(),[...grantBoundaries].sort());
 // Retry discovery/serialization and published-ID history are read paths or
 // payload inside the existing atomic Schedule replacement, not new writes.
 const owned=grant.slice(grant.indexOf('async function issueEraEntryOwned'),grant.indexOf('// ScheduleStore also serializes'));
 for(const [pattern,count] of [[/await open\(stage/g,1],[/await file\.write\(/g,2],[/await file\.sync\(/g,1],[/durability\.sync\(stage/g,1],[/await durability\.archive\(/g,1],[/await durability\.remove\(/g,1],[/await durability\.syncFile\(path/g,1]])assert.equal([...owned.matchAll(pattern)].length,count);
});
