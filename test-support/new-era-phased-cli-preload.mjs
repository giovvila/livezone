// Test-process preload only. Production CLI/code remains unmodified by fixtures.
import {readFile} from 'node:fs/promises';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {registerNativeTestRoot} from './NativeTempGuard.mjs';
import {testDurability,HEAD,BRANCH} from './NewExecutionEraFixture.js';
const input=JSON.parse(await readFile(process.env.LIVEZONE_PHASE_CLI_FIXTURE,'utf8'));
registerNativeTestRoot(input.root);
for(const method of ['transition','transitionStatus']){
    const original=NewExecutionEra.prototype[method];
    NewExecutionEra.prototype[method]=async function(...args){
        if(this.root!==input.root)throw Error('PHASE_CLI_FIXTURE_ROOT_MISMATCH');
        this.host={reserve:async()=>async()=>{},proveOffline:async()=>({absent:true}),inspect:async()=>({
            root:input.root,head:HEAD,branch:BRANCH,administrator:true,
            service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},
            media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},ports:[],bootstrapPermission:false,proof:{absent:true}})};
        this.native={capability:()=>({testDouble:true})};this.durability=testDurability;
        this.verifyRuntimeCapability=()=>({proofHash:'f'.repeat(64)});
        return original.apply(this,args);
    };
}
