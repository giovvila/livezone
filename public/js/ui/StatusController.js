export default class StatusController{

    constructor(elementId){
        this.el=document.getElementById(elementId);
    }

    set(text){
        if(this.el) this.el.textContent=text;
    }

    online(){ this.set("🟢 ONLINE"); }

    connecting(){ this.set("🟡 CONNECTING"); }

    offline(){ this.set("🔴 OFFLINE"); }

    error(){ this.set("⚫ ERROR"); }

}
