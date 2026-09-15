// Shared existing crawl markup/classes for Studio, Public and OBS.
export function createTextCrawlElement(item,{prefix='studio',now=()=>Date.now()}={}) {
    if(!item?.enabled||!item.text||item.scheduled&&Date.parse(item.scheduled.endAt)<=now())return null;
    const overlay=document.createElement('div'),text=document.createElement('span');
    const name=prefix+'-text-crawl';
    overlay.className=[name,name+'--'+item.mode,name+'--'+item.direction,name+'--'+item.speed,
        name+'--'+item.position,item.background?name+'--background':''].filter(Boolean).join(' ');
    text.className=name+'__text';text.textContent=item.text;overlay.appendChild(text);
    if(item.scheduled){
        const duration={slow:24,medium:16,fast:9}[item.speed];
        const elapsed=Math.max(0,now()-Date.parse(item.scheduled.startAt))/1000;
        text.style.animationDelay='-'+(elapsed%duration)+'s';
    }
    return overlay;
}
// Retain the node while logical state is unchanged; no animation-frame publications.
export class TextCrawlView {
    constructor({prefix='studio',now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,createElement=createTextCrawlElement}={}){
        Object.assign(this,{prefix,now,createElement});
        // Browser timer functions must not receive this view as their receiver.
        this.setTimer=(fn,ms)=>setTimer(fn,ms);
        this.clearTimer=id=>clearTimer(id);
    }
    node(item){
        const key=JSON.stringify(item||null);
        if(key===this.key)return this.element;
        this.clearTimer(this.timer);this.key=key;this.element=this.createElement(item,{prefix:this.prefix,now:this.now});
        if(this.element&&item.scheduled){const element=this.element;const expire=()=>{
            if(this.element!==element)return;
            const remaining=Date.parse(item.scheduled.endAt)-this.now();
            if(remaining>0){this.timer=this.setTimer(expire,Math.min(remaining,2147483647));return;}
            element.remove();this.element=null;
        };this.timer=this.setTimer(expire,Math.min(Math.max(0,Date.parse(item.scheduled.endAt)-this.now()),2147483647));}
        return this.element;
    }
    destroy(){this.clearTimer(this.timer);this.element?.remove();this.element=null;this.key=null;}
}
