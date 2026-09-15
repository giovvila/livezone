import {TextCrawlView} from './TextCrawlElement.js';

// Independent node and deadline; changes to other overlays never touch either.
export default class SponsorView extends TextCrawlView {
    constructor(options={}) { super({...options,createElement:createSponsorElement}); }
}
export function createSponsorElement(item,{now=()=>Date.now()}={}) {
    if(!item?.enabled || Date.parse(item.scheduled.endAt)<=now())return null;
    const image=document.createElement('img');
    image.className='scheduled-sponsor';image.src=item.url;image.alt='';
    Object.assign(image.style,{position:'absolute',zIndex:'3',width:item.sizePercent+'%',
        height:'auto',maxHeight:'28%',objectFit:'contain',opacity:String(item.opacity),pointerEvents:'none'});
    if(item.layout==='FULLSCREEN'){
        Object.assign(image.style,{inset:'0',width:'100%',height:'100%',maxHeight:'none',objectFit:item.fit==='COVER'?'cover':'contain',zIndex:'5'});
        return image;
    }
    const [vertical,horizontal]=item.position.split('-');
    image.style[vertical]='1.5%';image.style[horizontal]='1.5%';
    return image;
}
