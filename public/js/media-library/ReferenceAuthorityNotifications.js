export const REFERENCE_AUTHORITY_CHANGED='livezone:reference-authority-changed';

// Invalidate projections only. Never send asset data, credentials or playback commands.
export function notifyReferenceAuthorityChanged(){
    const target=globalThis.window;
    if(!target)return;
    try{target.dispatchEvent(new target.Event(REFERENCE_AUTHORITY_CHANGED));}catch{ /* Projection updates must not interrupt an authority acknowledgement. */ }
    try{if(target.BroadcastChannel){const channel=new target.BroadcastChannel('livezone.media-library.changed.v1');
        try{channel.postMessage('changed');}finally{channel.close();}}}catch{ /* Local refresh remains available when cross-tab messaging is denied. */ }
}

export function isReferenceAuthorityMutation(path,method){
    return ['POST','PUT','PATCH','DELETE'].includes(method)&&
        (/^\/api\/media-library\/(reference-clients|preview-ownership|channel-logo)(\/|$)/.test(path)||
        /^\/api\/studio\/state\/catalog(\/|$)/.test(path));
}
