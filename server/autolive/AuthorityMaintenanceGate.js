import {open,unlink} from 'node:fs/promises';
// Serializes initialization against explicit maintenance. Never break an old gate automatically.
export async function acquireMaintenanceGate(path,{durability,record={pid:process.pid,at:new Date().toISOString()},hook=()=>{}}={}){
 await hook('before-open');
 const handle=await open(path+'.maintenance','wx');
 try{
  await hook('opened');const bytes=Buffer.from(JSON.stringify(record)),mid=Math.floor(bytes.length/2);
  await handle.write(bytes.subarray(0,mid),0,mid,0);await hook('partial-written');
  await handle.write(bytes.subarray(mid),0,bytes.length-mid,mid);await hook('written');
  await handle.sync();await hook('file-flushed');durability?.sync(path+'.maintenance');
  await hook('namespace-flushed');await hook('durable');
 }
 catch(error){await handle.close();if(!durability)await unlink(path+'.maintenance');throw error;}
 return async()=>{await handle.close();if(durability)await durability.remove(path+'.maintenance');else await unlink(path+'.maintenance');};
}
