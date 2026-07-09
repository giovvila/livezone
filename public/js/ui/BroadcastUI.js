import Clock from './Clock.js';
export default class BroadcastUI{
 start(){
   const c=document.getElementById('clock');
   if(c){new Clock(c).start();}
   const s=document.getElementById('status');
   if(s) s.textContent='● ONLINE';
 }
}
