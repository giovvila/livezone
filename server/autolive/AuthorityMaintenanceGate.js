import {open,unlink} from 'node:fs/promises';
// Serializes initialization against explicit maintenance. Never break an old gate automatically.
export async function acquireMaintenanceGate(path){
 const handle=await open(path+'.maintenance','wx');
 try{await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await handle.sync();}
 catch(error){await handle.close();await unlink(path+'.maintenance');throw error;}
 return async()=>{await handle.close();await unlink(path+'.maintenance');};
}
