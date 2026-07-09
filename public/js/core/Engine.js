import Player from '../player/Player.js';
import BroadcastUI from '../ui/BroadcastUI.js';

export default class Engine{
 async start(){
   this.player=new Player();
   await this.player.init();
   this.ui=new BroadcastUI();
   this.ui.start();
   console.log('Engine READY');
 }
}
