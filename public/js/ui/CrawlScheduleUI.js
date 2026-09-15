export default class CrawlScheduleUI {
    constructor({root,client}){Object.assign(this,{root,client});this.editId=null;}
    start(){
        if(!this.root)return;this.form=this.root.querySelector('form');this.list=this.root.querySelector('[data-crawl-events]');this.feedback=this.root.querySelector('[role=status]');
        this.submit=event=>{event.preventDefault();void this.save();};
        this.click=event=>{const button=event.target.closest('button[data-action]');if(!button)return;
            const action=button.dataset.action,id=button.dataset.id;
            if(action==='cancel'){this.editId=null;this.form.reset();return;}
            const item=this.client.state.schedule?.events.find(e=>e.id===id);if(!item)return;
            if(action==='edit'){this.editId=id;const fields={name:item.name||item.id,text:item.payload.text,startAt:localTime(item.startAt),endAt:localTime(item.endAt),
                priority:item.priority,position:item.payload.position,direction:item.payload.direction,speed:item.payload.speed};
                for(const [key,value] of Object.entries(fields))this.form.elements[key].value=value;
                this.form.elements.enabled.checked=item.enabled;this.form.elements.background.checked=item.payload.background;
            }else if(this.client.writable)void this.mutate(action==='delete'?this.client.delete(id):this.client.setEnabled(id,!item.enabled));
        };
        this.form.addEventListener('submit',this.submit);this.root.addEventListener('click',this.click);
        this.off=this.client.subscribe(state=>this.render(state));
    }
    async save(){
        if(!this.client.writable)return;
        const data=new FormData(this.form),start=new Date(data.get('startAt')),end=new Date(data.get('endAt'));
        if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start){this.feedback.textContent='Intervallo non valido';return;}
        const event={name:String(data.get('name')).trim(),type:'overlay.crawl',enabled:data.has('enabled'),startAt:start.toISOString(),endAt:end.toISOString(),priority:Number(data.get('priority')),
            payload:{text:String(data.get('text')).trim(),position:data.get('position'),direction:data.get('direction'),speed:data.get('speed'),repeat:'continuous',styleId:'broadcast-default',background:data.has('background')}};
        const operation=this.editId?this.client.update(this.editId,event):this.client.create({...event,id:'crawl-'+crypto.randomUUID(),version:1});
        const result=await this.mutate(operation);if(result.ok){this.editId=null;this.form.reset();}
    }
    async mutate(operation){const result=await operation;this.feedback.textContent=result.ok?'Salvato sul server':result.code==='REVISION_CONFLICT'?'SCHEDULE CHANGED — REFRESHED':'Salvataggio non riuscito';return result;}
    render(state){
        this.form.querySelectorAll('input,textarea,select,button').forEach(el=>{el.disabled=!this.client.writable;});
        const rows=(state.schedule?.events||[]).filter(e=>e.type==='overlay.crawl').map(event=>{
            const row=document.createElement('li'),label=document.createElement('span');
            const status=state.runtime?.events?.find(e=>e.id===event.id)?.status||'UNAVAILABLE';
            label.textContent=(event.name||event.id)+' · '+status+' · '+new Date(event.startAt).toLocaleString()+' → '+new Date(event.endAt).toLocaleString();row.appendChild(label);
            for(const [action,title] of [['edit','Modifica'],['toggle',event.enabled?'Disabilita':'Abilita'],['delete','Elimina']]){
                const button=document.createElement('button');button.type='button';button.dataset.action=action;button.dataset.id=event.id;button.textContent=title;button.disabled=!this.client.writable;row.appendChild(button);
            }return row;
        });this.list.replaceChildren(...rows);
        if(!this.client.writable)this.feedback.textContent='Server non disponibile — sola lettura';
    }
    destroy(){this.off?.();this.form?.removeEventListener('submit',this.submit);this.root?.removeEventListener('click',this.click);}
}
function localTime(value){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);}
