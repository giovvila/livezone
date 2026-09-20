// Only installed by the CLI entry point; embedded/test servers own their lifecycle.
export function installGracefulShutdown({server},{signals=process,exit=code=>process.exit(code),logger=console}={}){
 let pending;
 const names=['SIGINT','SIGTERM','SIGBREAK'];
 const remove=()=>{for(const name of names)signals.removeListener(name,shutdown);};
 function shutdown(){
  if(pending)return pending;
  pending=new Promise(resolve=>{
   const timeout=setTimeout(()=>{logger.error('LIVEZONE shutdown did not drain; authority remains fail-closed.');exit(1);resolve();},10000);
   timeout.unref?.();
   server.close(error=>{clearTimeout(timeout);remove();exit(error?1:0);resolve();});
   server.closeAllConnections?.();
  });
  return pending;
 }
 for(const name of names)signals.on(name,shutdown);
 return {shutdown,remove};
}
