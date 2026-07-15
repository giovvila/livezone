import Clock from './Clock.js';
export default class BroadcastUI{
 start(){
  const c=document.getElementById('clock');
  if(c) new Clock(c).start();
  const splash=document.getElementById('splash');
  setTimeout(()=>{if(splash)splash.classList.add('hide');},1500);
  const status=document.getElementById('status');
  if(status) status.textContent='● ONLINE';
 }
}
