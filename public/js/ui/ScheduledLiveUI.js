import {zonedLocalToIso} from '../scheduler/ScheduleContract.js';

export default class ScheduledLiveUI {
    constructor({
        root,
        store,
        catalog,
        clock=()=>Date.now(),
        uuidFactory=()=>globalThis.crypto?.randomUUID?.()
    }={}) {
        Object.assign(this,{root,store,catalog,clock,uuidFactory});

        this.editingId=null;
        this.started=false;

        this.submit=this.submit.bind(this);
        this.click=this.click.bind(this);
        this.render=this.render.bind(this);
        this.cancelEdit=this.cancelEdit.bind(this);
    }

    start(){
        if(this.started||!this.root||!this.store||!this.catalog)
            return false;

        this.form=this.root.querySelector('#scheduled-live-form');
        this.list=this.root.querySelector('#scheduled-live-list');
        this.empty=this.root.querySelector('#scheduled-live-empty');
        this.feedback=this.root.querySelector('#scheduled-live-feedback');
        this.cancel=this.root.querySelector('#scheduled-live-cancel');
        this.source=this.root.querySelector('#scheduled-live-source');

        if(!this.form||!this.list||!this.empty||
            !this.feedback||!this.cancel||!this.source)
            return false;

        this.started=true;

        this.form.addEventListener('submit',this.submit);
        this.list.addEventListener('click',this.click);
        this.cancel.addEventListener('click',this.cancelEdit);

        this.unsubscribeStore=this.store.subscribe(this.render);
        this.unsubscribeCatalog=this.catalog.subscribe(this.render);

        this.reset();
        this.render();

        return true;
    }

    destroy(){
        if(!this.started)return;

        this.form.removeEventListener('submit',this.submit);
        this.list.removeEventListener('click',this.click);
        this.cancel.removeEventListener('click',this.cancelEdit);

        this.unsubscribeStore?.();
        this.unsubscribeCatalog?.();

        this.started=false;
    }

    cancelEdit(){
        this.reset();
        this.message('',false);
    }

    serverSchedule(){
        return this.store.client?.state?.schedule??null;
    }

    timezone(){
        return this.serverSchedule()?.programPlan?.timezone||
            this.store.schedule?.timezone||
            'Europe/Rome';
    }

    liveSources(){
        return this.catalog.getSources().filter(source=>
            source.kind==='hls'&&
            source.enabled!==false&&
            source.available!==false
        );
    }

    renderSources(){
        const selected=this.source.value;

        const options=this.liveSources().map(source=>{
            const option=document.createElement('option');
            option.value=source.id;
            option.textContent=source.name;
            return option;
        });

        this.source.replaceChildren(...options);

        if(options.some(option=>option.value===selected))
            this.source.value=selected;
    }

    async submit(event){
        event.preventDefault();

        if(!this.store.writable)
            return this.message(
                'SERVER NON DISPONIBILE — SOLA LETTURA',
                true
            );

        const data=new FormData(this.form);

        const sourceId=String(data.get('sourceId')||'');
        const date=String(data.get('date')||'');
        const time=String(data.get('time')||'');

        const durationHours=Number(data.get('durationHours'));
        const durationMinutes=Number(data.get('durationMinutes'));
        const precheckMinutes=Number(data.get('precheckMinutes'));
        const priority=Number(data.get('priority'));

        if(
            !this.liveSources().some(source=>source.id===sourceId)||
            !Number.isInteger(durationHours)||
            !Number.isInteger(durationMinutes)||
            durationHours<0||
            durationHours>23||
            durationMinutes<0||
            durationMinutes>59||
            durationHours*60+durationMinutes<=0||
            !Number.isInteger(precheckMinutes)||
            precheckMinutes<0||
            precheckMinutes>15||
            !Number.isInteger(priority)||
            priority < -100||
            priority > 100
        ){
            return this.message(
                'Sorgente, durata, precheck o priorità non validi.',
                true
            );
        }

        const zonedStartAt=zonedLocalToIso(
            date,
            time,
            this.timezone()
        );

        if(!zonedStartAt)
            return this.message('Data o ora non valide.',true);

        /*
         * The browser schedule helper preserves the local UTC offset
         * (for example +02:00), while the authoritative server event
         * contract requires canonical Date.toISOString() form.
         */
        const startAt=
            new Date(zonedStartAt).toISOString();

        const durationMs=
            (durationHours*60+durationMinutes)*60000;

        const endAt=
            new Date(Date.parse(startAt)+durationMs).toISOString();

        const unavailableAction=
            String(data.get('unavailableAction')||'KEEP_PROGRAM');

        const endAction=
            String(data.get('endAction')||'RETURN');

        if(!['KEEP_PROGRAM','RADIO'].includes(unavailableAction))
            return this.message('Fallback non valido.',true);

        if(!['RETURN','RADIO','HOLD'].includes(endAction))
            return this.message('Azione finale non valida.',true);

        const now=new Date(this.clock()).toISOString();

        const payload={
            sourceId,
            precheckSeconds:precheckMinutes*60,
            unavailableAction,
            unavailableSceneId:null,
            endAction,
            endSceneId:null
        };

        const name=
            String(data.get('name')||'').trim()||
            this.liveSources().find(source=>source.id===sourceId)?.name||
            'LIVE';

        let result;

        if(this.editingId){
            result=await this.store.client.update(
                this.editingId,
                {
                    name,
                    startAt,
                    endAt,
                    priority,
                    payload
                }
            );
        } else {
            const uuid=this.uuidFactory?.();

            if(!uuid)
                return this.message(
                    'Impossibile creare ID evento.',
                    true
                );

            result=await this.store.client.create({
                id:`live-${uuid}`.slice(0,120),
                name,
                version:1,
                type:'source.live',
                enabled:true,
                startAt,
                endAt,
                priority,
                payload,
                createdAt:now,
                updatedAt:now
            });
        }

        if(!result?.ok)
            return this.message(
                `Salvataggio non riuscito: ${result?.code||'ERRORE'}`,
                true
            );

        this.reset();
        return this.message('LIVE programmato sul server.',false);
    }

    async click(event){
        const button=event.target.closest?.(
            'button[data-live-action]'
        );

        if(!button)return;

        if(!this.store.writable)
            return this.message(
                'SERVER NON DISPONIBILE — SOLA LETTURA',
                true
            );

        const id=button.dataset.id;

        const definition=this.serverSchedule()?.events?.find(item=>
            item.id===id&&item.type==='source.live'
        );

        if(!definition)return;

        if(button.dataset.liveAction==='delete'){
            const result=await this.store.client.delete(id);

            if(!result?.ok)
                return this.message(
                    'Eliminazione non riuscita.',
                    true
                );

            if(this.editingId===id)this.reset();

            return this.message('LIVE eliminato.',false);
        }

        if(button.dataset.liveAction==='toggle'){
            const result=await this.store.client.setEnabled(
                id,
                !definition.enabled
            );

            return this.message(
                result?.ok
                    ? definition.enabled
                        ? 'LIVE disabilitato.'
                        : 'LIVE abilitato.'
                    : 'Modifica non riuscita.',
                !result?.ok
            );
        }

        if(button.dataset.liveAction==='edit'){
            this.editingId=id;
            this.fill(definition);

            return this.message(
                `Modifica: ${definition.name||id}`,
                false
            );
        }
    }

    fill(event){
        this.renderSources();

        const form=this.form.elements;
        const start=this.localParts(event.startAt);

        form.name.value=event.name||'';
        form.sourceId.value=event.payload.sourceId;
        form.date.value=start.date;
        form.time.value=start.time;

        const minutes=Math.round(
            (Date.parse(event.endAt)-Date.parse(event.startAt))/60000
        );

        form.durationHours.value=Math.floor(minutes/60);
        form.durationMinutes.value=minutes%60;
        form.precheckMinutes.value=event.payload.precheckSeconds/60;
        form.priority.value=event.priority;
        form.unavailableAction.value=event.payload.unavailableAction;
        form.endAction.value=event.payload.endAction;

        this.cancel.hidden=false;
    }

    localParts(iso){
        const parts=new Intl.DateTimeFormat(
            'en-CA',
            {
                timeZone:this.timezone(),
                year:'numeric',
                month:'2-digit',
                day:'2-digit',
                hour:'2-digit',
                minute:'2-digit',
                second:'2-digit',
                hourCycle:'h23'
            }
        ).formatToParts(new Date(iso));

        const values=Object.fromEntries(
            parts.map(({type,value})=>[type,value])
        );

        return {
            date:`${values.year}-${values.month}-${values.day}`,
            time:`${values.hour}:${values.minute}:${values.second}`
        };
    }

    reset(){
        if(!this.form)return;

        this.editingId=null;
        this.form.reset();
        this.renderSources();

        const local=this.localParts(
            new Date(this.clock()).toISOString()
        );

        this.form.elements.date.value=local.date;
        this.form.elements.time.value=local.time;
        this.form.elements.durationHours.value='1';
        this.form.elements.durationMinutes.value='0';
        this.form.elements.precheckMinutes.value='3';
        this.form.elements.priority.value='10';

        this.cancel.hidden=true;
    }

    render(){
        if(!this.started)return;

        this.renderSources();

        const definitions=
            (this.serverSchedule()?.events||[])
                .filter(event=>event.type==='source.live')
                .sort((a,b)=>
                    Date.parse(a.startAt)-Date.parse(b.startAt)
                );

        const runtimeEvents=this.store.runtime?.events||[];

        const rows=definitions.map(event=>{
            const row=document.createElement('li');
            const start=document.createElement('time');
            const summary=document.createElement('div');
            const name=document.createElement('strong');
            const detail=document.createElement('span');
            const status=document.createElement('div');
            const actions=document.createElement('div');

            const source=this.catalog.getSources()
                .find(item=>item.id===event.payload.sourceId);

            const runtime=runtimeEvents
                .find(item=>item.id===event.id);

            const startParts=this.localParts(event.startAt);
            const endParts=this.localParts(event.endAt);

            const precheck=this.localParts(
                new Date(
                    Date.parse(event.startAt)-
                    event.payload.precheckSeconds*1000
                ).toISOString()
            );

            row.className='schedule-item scheduled-live-item';

            start.className='schedule-item__start';
            start.textContent=
                `${startParts.date} ${startParts.time.slice(0,5)}`;

            name.className='schedule-item__title';
            name.textContent=
                event.name||source?.name||event.id;

            detail.className='schedule-item__scene';
            detail.textContent=
                `${source?.name||event.payload.sourceId} · `+
                `${startParts.time.slice(0,5)} → `+
                `${endParts.time.slice(0,5)} · `+
                `PRECHECK ${precheck.time.slice(0,5)}`;

            const badge=document.createElement('strong');

            badge.textContent=
                !event.enabled
                    ? 'DISABILITATO'
                    : runtime?.status||'PROGRAMMATO';

            status.className='schedule-item__type';
            status.append(badge);

            actions.className='schedule-item__actions';

            for(const [action,label] of [
                ['edit','MODIFICA'],
                ['toggle',event.enabled?'DISABILITA':'ABILITA'],
                ['delete','ELIMINA']
            ]){
                const button=document.createElement('button');
                button.type='button';
                button.dataset.liveAction=action;
                button.dataset.id=event.id;
                button.textContent=label;
                actions.append(button);
            }

            summary.className='schedule-item__program';
            summary.append(name,detail);

            row.append(start,summary,status,actions);

            return row;
        });

        this.list.replaceChildren(...rows);
        this.empty.hidden=rows.length>0;

        this.form.querySelectorAll('button,input,select')
            .forEach(node=>{
                node.disabled=!this.store.writable;
            });
    }

    message(text,error){
        this.feedback.textContent=text;
        this.feedback.classList.toggle(
            'is-error',
            Boolean(error)
        );

        return false;
    }
}
