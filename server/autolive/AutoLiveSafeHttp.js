import http from 'node:http';
import https from 'node:https';
import {lookup as systemLookup} from 'node:dns/promises';
import {isIP,BlockList} from 'node:net';
import {error} from './AutoLiveContract.js';
import {endpointIdentity} from './AutoLiveHealthContract.js';

const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
    ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['192.88.99.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(ip,bits,'ipv4');
const publicV6=new BlockList();publicV6.addSubnet('2000::',3,'ipv6');
for(const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])blocked.addSubnet(ip,bits,'ipv6');
export function publicAddress(address){
    const family=isIP(address);return family===4?!blocked.check(address,'ipv4'):family===6&&publicV6.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
export function externalUrl(value){
    let url;try{url=new URL(endpointIdentity(value));}catch{throw error('URL_FORBIDDEN');}
    if(url.port&&!['80','443'].includes(url.port)||/^(localhost|.*\.(localhost|local|example|test|invalid))\.?$/i.test(url.hostname))throw error('URL_FORBIDDEN');
    return url;
}
export function abortable(promise,signal){
    if(signal.aborted)return Promise.reject(error('ABORTED'));
    return new Promise((resolve,reject)=>{const abort=()=>reject(error('ABORTED'));signal.addEventListener('abort',abort,{once:true});
        Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function codedError(code,details=null){
    const e=error(code);
    if(details&&typeof details==='object')e.details=Object.freeze({...details});
    return e;
}
async function resolveAddresses(host,signal){
    if(signal.aborted)throw error('ABORTED');
    try{
        // Use the operating-system resolver path (getaddrinfo) so Windows DNS policy,
        // adapters and configured resolvers match normal application resolution.
        // The returned addresses are still validated before any socket is opened and
        // the socket lookup below remains pinned to the validated address, preserving
        // the SSRF DNS-rebinding fence.
        const results=await abortable(systemLookup(host,{all:true,verbatim:true}),signal);
        return results.map(({address,family})=>({address,family}));
    }catch(e){
        if(signal.aborted||e?.code==='ABORTED')throw error('ABORTED');
        throw error('DNS_ERROR');
    }
}
// No ambient proxy/cookie/credential state. Validate every DNS answer first, then
// pin each socket attempt to an already-validated address. Network failure may try
// the next validated answer without another DNS lookup; policy/HTTP failures do not.
// TLS still verifies the original host. Redirects repeat the complete policy.
export default class AutoLiveSafeHttp {
    constructor({resolve=resolveAddresses,allowAddress=publicAddress,parseUrl=externalUrl,timeoutMs=2500}={}){
        Object.assign(this,{resolve,allowAddress,parseUrl,timeoutMs});
    }
    async read(value,{signal,segment=false,stage=null}={}){
        const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)controller.abort();const timer=setTimeout(abort,this.timeoutMs);
        try{
            let url=this.parseUrl(value);
            for(let redirects=0;redirects<=3;redirects++){
                const host=url.hostname.replace(/^\[|\]$/g,'');
                const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await abortable(this.resolve(host,controller.signal),controller.signal);
                if(!addresses.length)throw error('DNS_ERROR');
                if(addresses.length>32||addresses.some(a=>!this.allowAddress(a.address)))throw error('ADDRESS_FORBIDDEN');
                let result,lastNetworkError;
                for(const address of addresses){
                    try{result=await this.request(url,address,controller.signal,segment,stage);lastNetworkError=null;break;}
                    catch(e){
                        if(controller.signal.aborted)throw error('ABORTED');
                        if(e?.code!=='NETWORK_ERROR')throw e;
                        lastNetworkError=e;
                    }
                }
                if(!result)throw lastNetworkError||error('NETWORK_ERROR');
                if(result.location){if(redirects===3)throw error('REDIRECT_LIMIT');url=this.parseUrl(new URL(result.location,url).href);continue;}
                return {...result,url:url.href};
            }
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
    }
    request(url,address,signal,segment,stage=null){
        return new Promise((resolve,reject)=>{
            const request=(url.protocol==='https:'?https:http).request(url,{agent:false,signal,maxHeaderSize:16384,
                lookup:(host,options,callback)=>options.all?callback(null,[address]):callback(null,address.address,address.family),
                headers:{Accept:segment?'*/*':'application/vnd.apple.mpegurl','Accept-Encoding':'identity',...(segment?{Range:'bytes=0-0'}:{})}},response=>{
                const status=response.statusCode;
                if([301,302,303,307,308].includes(status)){const location=response.headers.location;response.destroy();return location?resolve({location}):reject(error('REDIRECT_INVALID'));}
                if(status<200||status>=300){response.destroy();return reject(codedError('HTTP_ERROR',{status,stage:stage||null}));}
                if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();return reject(error('ENCODING_UNSUPPORTED'));}
                const chunks=[];let bytes=0,done=false;
                const finish=value=>{if(done)return;done=true;resolve(value);};
                response.on('data',chunk=>{
                    if(segment){finish({body:null,bytes:1});response.destroy();return;}
                    bytes+=chunk.length;if(bytes>131072){done=true;response.destroy();reject(error('BODY_LIMIT'));return;}chunks.push(chunk);
                });
                response.on('end',()=>segment?finish({body:null,bytes:0}):finish({body:Buffer.concat(chunks).toString('utf8'),bytes}));
                response.on('error',()=>{if(!done)reject(error('NETWORK_ERROR'));});
            });
            request.on('error',()=>reject(error(signal.aborted?'ABORTED':'NETWORK_ERROR')));request.end();
        });
    }
}
