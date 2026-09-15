export default class ScheduleWorkspacePanels {
    constructor(root,{storage}={}) {this.root=root;try{this.storage=storage===undefined?globalThis.localStorage:storage;}catch{this.storage=null;}}
    start(){
        if(this.panels)return;
        this.panels=[...this.root.querySelectorAll('[data-schedule-panel]')].map(panel=>{
            const button=panel.querySelector('[data-panel-toggle]'),body=panel.querySelector('[data-panel-body]');
            const key=panel.dataset.panelStorageKey||'livezone.scheduler.panel.'+panel.dataset.schedulePanel+'.collapsed.v1';
            let collapsed=true;try{collapsed=this.storage?.getItem(key)!=='false';}catch{}
            const apply=()=>{body.hidden=collapsed;panel.classList.toggle('is-collapsed',collapsed);button.setAttribute('aria-expanded',String(!collapsed));button.textContent=collapsed?(button.dataset.expandLabel||'ESPANDI ▼'):(button.dataset.collapseLabel||'RIDUCI ▲');};
            const toggle=()=>{collapsed=!collapsed;try{this.storage?.setItem(key,String(collapsed));}catch{}apply();};
            button.addEventListener('click',toggle);apply();return {button,toggle};
        });
    }
    destroy(){this.panels?.forEach(({button,toggle})=>button.removeEventListener('click',toggle));this.panels=null;}
}
