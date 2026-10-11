import {readFile} from 'node:fs/promises';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {registerNativeTestRoot} from './NativeTempGuard.mjs';
import {testDurability,HEAD,BRANCH} from './NewExecutionEraFixture.js';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
registerNativeTestRoot(input.root);
const host={reserve:async()=>async()=>{},proveOffline:async()=>({absent:true}),inspect:async()=>({
    root:input.root,head:HEAD,branch:BRANCH,administrator:true,
    service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},
    media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},ports:[],bootstrapPermission:false,proof:{absent:true}})};
const writer=new NewExecutionEra({root:input.root,paths:input.paths,host,expected:{head:HEAD,branch:BRANCH},
    native:{capability:()=>({testDouble:true})},durability:testDurability,
    verifyRuntimeCapability:()=>({proofHash:'f'.repeat(64)}),
    hook:point=>{if(point==='partial-written'){process.stdout.write('FIXTURE_ABRUPT_PHASE\n');process.exit(73);}}});
await writer.transition(input.authorization,{phase:input.phase,expectedCheckpointHash:input.checkpointHash});
throw Error('FIXTURE_ABRUPT_BOUNDARY_NOT_REACHED');
