import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import {readFile} from 'node:fs/promises';
import {directorySync} from '../server/scheduler/LedgerV2Durability.js';
const [path,point,inputPath,mode]=process.argv.slice(2);
const input=JSON.parse(await readFile(inputPath,'utf8'));
let armed=false;
// Test storage capability only: abrupt process loss, NOT physical power loss.
const repository=new Repository({path,authority:input.context,syncDirectory:mode==='native'?directorySync:()=> 'DIRECTORY_SYNCED',hook:stage=>{
    if(armed && stage===point)process.exit(77); // Deliberately no close/finally.
}});
await repository.initialize();
if(repository.status!=='READY')throw Error(repository.error);
armed=true;
await repository.consume(input.identity,input.context);
if(point.startsWith('end-')||point==='shutdown-durable')await repository.close();
process.exit(78);
