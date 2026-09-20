import {reconcileAuthorityLock} from '../server/autolive/ReconcileAuthorityLock.js';
const [path,epoch,pid,session,epochHash,lockHash,...rest]=process.argv.slice(2);
if(!path||!epoch||!pid||!session||! /^[a-f0-9]{64}$/i.test(epochHash||'')||! /^[a-f0-9]{64}$/i.test(lockHash||'')||rest.length){
 console.error('Usage: node tools/reconcile-autolive-authority.mjs <absolute .execution path> <expected epoch> <expected PID> <expected process session> <reviewed epoch SHA256> <reviewed lock SHA256>');process.exitCode=1;
}else{
 try{console.log(JSON.stringify(await reconcileAuthorityLock({path,expectedEpoch:Number(epoch),expectedPid:Number(pid),expectedSession:session,expectedEpochHash:epochHash,expectedLockHash:lockHash}),null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
