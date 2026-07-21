export default class StatusController{

    constructor(elementId){
        this.el=document.getElementById(elementId);
    }

    set(text,color=null){
        if(!this.el) return;
        this.el.textContent=text;
        if(color) this.el.style.color=color;
    }

    online(){ this.set("🟢 ONLINE","#00d26a"); }
    connecting(){ this.set("🟡 CONNECTING","#ffb300"); }
    offline(){ this.set("🔴 OFFLINE","#ff3b30"); }
    error(){ this.set("⚫ ERROR","#ff3b30"); }

}
