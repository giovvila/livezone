import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {digest} from './DurableProgramContract.js';
import ScheduleTargetResolver from '../../public/js/scheduler/ScheduleTargetResolver.js';
const unresolved=()=>{throw Object.assign(Error('PROGRAM_IDENTITY_UNRESOLVED'),{code:'PROGRAM_IDENTITY_UNRESOLVED'});};
function locator(value){if(!value)return null;const u=new URL(value,'http://local.invalid');if(u.username||u.password)unresolved();return u.pathname.startsWith('/media-library/files/')?u.pathname:u.href;}
export default class ProgramRestoreValidation {
 constructor({catalog,assets,resolveConfigRef=()=>null}){Object.assign(this,{catalog,assets,resolveConfigRef});}
 async bind(snapshot){
  const state=this.catalog(),source=snapshot.source,scene=snapshot.scene;
  const identity={sourceFingerprint:source?digest(source):null,catalog:null,assets:[]};
  const urls=new Set();const scan=v=>{if(typeof v==='string'&&/^(https?:|\/media-library\/)/.test(v)){const u=locator(v);if(u?.startsWith('/media-library/files/'))urls.add(u);}else if(v&&typeof v==='object')Object.values(v).forEach(scan);};scan(snapshot);
  for(const url of [...urls].sort()){
   const asset=this.assets.list().find(a=>a.url===url);if(!asset)unresolved();
   const path=this.assets.safeFilePath(asset.kind,asset.storedName),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())unresolved();
   const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
   identity.assets.push({id:asset.id,kind:asset.kind,url,bytes:stat.size,sha256:hash.digest('hex')});
  }
  if(!scene)return identity;
  if(!state?.initialized)return identity; // Historical standalone publication, never trusted for catalog restoration.
  const definition=state.scenes.find(s=>s.id===scene.id);
  if(source.kind==='break'){
   // ENTRY is real accepted output, but has no durable executable return target.
   if(!definition){if(source.id==='autolive-entry-slate')return identity;unresolved();}
   if(definition.renderer.kind!=='slate'||source.id!==scene.id||definition.renderer.title!==source.title||definition.renderer.message!==source.message||locator(definition.renderer.logo)!==locator(source.logoUrl))unresolved();
   identity.catalog={scene:{id:definition.id,type:definition.type,renderer:definition.renderer}};
  }else{
   const configured=state.sources.find(s=>s.id===source.id);if(!configured||configured.kind!==source.kind||configured.enabled===false)unresolved();
   if(definition){if(definition.renderer.kind!=='source'||definition.renderer.sourceId!==source.id)unresolved();}
   else if(!['schedule-source','dominant-live-source'].some(namespace=>new ScheduleTargetResolver({namespace}).getRuntimeSceneId({kind:'source',id:source.id})===scene.id))unresolved();
   const descriptor={id:configured.id,kind:configured.kind};
   for(const [field,assetField] of source.kind==='audio'?[['audioUrl','audioAssetId'],['stillUrl','stillAssetId'],['motionUrl','motionAssetId']]:[['url','assetId']]){
    const value=configured[assetField]?this.assets.get(configured[assetField])?.url:configured[field]||(field==='url'&&configured.configRef?this.resolveConfigRef(configured.configRef):null);
    if(locator(value)!==locator(source[field]))unresolved();if(value)descriptor[field]=locator(value);
   }
   identity.catalog={scene:{id:scene.id,type:definition?.type||scene.type,renderer:{kind:'source',sourceId:source.id}},source:descriptor};
  }
  return identity;
 }
 async validate(record){try{
  const next=await this.bind(record.envelope.snapshot);
  if(record.envelope.snapshot.scene&&!next.catalog)return false;
  return digest(next)===digest(record.identity);
 }catch{return false;}}
}
