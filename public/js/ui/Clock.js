export default class Clock{
 constructor(el){this.el=el;}
 start(){this.tick();setInterval(()=>this.tick(),1000);}
 tick(){const t=new Date().toLocaleTimeString('it-IT');
 if(this.el) this.el.textContent=t;
}
}
