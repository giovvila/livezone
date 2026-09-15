import {zonedLocalToIso} from './ScheduleContract.js';

export const EVENT_MODES = Object.freeze({PROGRAMMA:null,CRAWL:'overlay.crawl',SPONSOR:'overlay.sponsor'});
export const eventMode = event => Object.keys(EVENT_MODES).find(key=>EVENT_MODES[key]===event?.type)||'PROGRAMMA';
export const eventLabel = event => ({PROGRAMMA:'PROGRAM',CRAWL:'TEXT CRAWL',SPONSOR:'SPONSOR'})[eventMode(event)];
export const sponsorAsset = asset => asset?.kind==='image' && ['image/png','image/webp','image/jpeg'].includes(asset.mimeType);
const reject = message => {throw new Error(message);};

// Whitelist each type explicitly. Program continues through its existing validator/save path.
export function overlayFromEditor(mode, data, {timezone,mediaLibraryManager}={}) {
    const type=EVENT_MODES[mode];if(!type)reject('Tipo elemento non valido.');
    const name=String(data.get('overlayTitle')||'').trim();
    if(!name||Array.from(name).length>120)reject('Inserire un titolo (massimo 120 caratteri).');
    const localStart=zonedLocalToIso(data.get('overlayDate'),data.get('overlayTime'),timezone);
    const startAt=localStart?new Date(localStart).toISOString():null;
    const duration=Number(data.get('overlayDuration'));
    if(!startAt||!Number.isInteger(duration)||duration<1||duration>604800)reject('Data, ora o durata non valide (1–604800 secondi).');
    const priority=Number(data.get('overlayPriority'));
    if(!Number.isInteger(priority)||Math.abs(priority)>100)reject('Priorità non valida (−100–100).');
    let payload;
    if(mode==='CRAWL') {
        const text=String(data.get('crawlText')||'').trim(),position=data.get('crawlPosition'),direction=data.get('crawlDirection'),speed=data.get('crawlSpeed');
        if(!text||Array.from(text).length>500)reject('Inserire il testo crawl (massimo 500 caratteri).');
        if(!['top','bottom'].includes(position)||!['rtl','ltr'].includes(direction)||!['slow','medium','fast'].includes(speed))reject('Posizione, direzione o velocità crawl non valida.');
        payload={text,position,direction,speed,repeat:'continuous',styleId:'broadcast-default',background:data.has('crawlBackground')};
    } else {
        const assetId=String(data.get('sponsorAssetId')||''),asset=mediaLibraryManager?.getAsset(assetId);
        if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(assetId)||!sponsorAsset(asset))reject('Selezionare un’immagine PNG, WebP o JPEG dalla Media Library.');
        const position=data.get('sponsorPosition'),sizePercent=Number(data.get('sponsorSize')),opacityPercent=Number(data.get('sponsorOpacity'));
        const layout=data.get('sponsorLayout')||'CORNER',fit=data.get('sponsorFit')||'CONTAIN';
        if(!['CORNER','FULLSCREEN'].includes(layout)||layout==='FULLSCREEN'&&!['CONTAIN','COVER'].includes(fit))reject('Layout o fit non valido.');
        if(layout==='CORNER'&&(!['top-left','top-right','bottom-left','bottom-right'].includes(position)||!Number.isFinite(sizePercent)||sizePercent<5||sizePercent>30)||!Number.isFinite(opacityPercent)||opacityPercent<0||opacityPercent>100||data.get('sponsorOpacity')==='')reject('Posizione, dimensione (5–30%) o opacità (0–100%) non valida.');
        payload={assetId,layout,...(layout==='FULLSCREEN'?{fit}:{position,sizePercent}),opacity:opacityPercent/100};
    }
    return {name,type,enabled:data.has('overlayEnabled'),startAt,endAt:new Date(Date.parse(startAt)+duration*1000).toISOString(),priority,payload};
}

export function overlayToEditor(event,timezone) {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(event.startAt)).map(p=>[p.type,p.value]));
    const common={overlayTitle:event.name||event.id,overlayDate:`${parts.year}-${parts.month}-${parts.day}`,overlayTime:`${parts.hour}:${parts.minute}:${parts.second}`,
        overlayDuration:(Date.parse(event.endAt)-Date.parse(event.startAt))/1000,overlayPriority:event.priority,overlayEnabled:event.enabled};
    const p=event.payload;
    return {...common,...(eventMode(event)==='CRAWL'?{crawlText:p.text,crawlPosition:p.position,crawlDirection:p.direction,crawlSpeed:p.speed,crawlBackground:p.background}:
        {sponsorAssetId:p.assetId,sponsorLayout:p.layout||'CORNER',sponsorFit:p.fit||'CONTAIN',sponsorPosition:p.position||'top-right',sponsorSize:p.sizePercent??12,sponsorOpacity:p.opacity*100})};
}
