import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Validation from '../server/program-output/ProgramRestoreValidation.js';
async function fixture(t,{kind='media',managed=false,ref=false}={}){
 const root=await mkdtemp(join(tmpdir(),'lz-dp1-assets-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'asset.mp4');await writeFile(file,'original');
 const asset={id:'asset',kind:'video',storedName:'asset.mp4',url:'/media-library/files/video/asset.mp4'};
 let available=true,endpoint='https://example.test/live.m3u8';
 const source={id:'source',name:'Display name',kind,...(managed?{assetId:asset.id}:ref?{configRef:'live.url',enabled:true}:kind==='audio'?{audioUrl:'https://example.test/a.mp3',stillUrl:'https://example.test/s.png'}:{url:'https://example.test/v.mp4'})};
 const scene={id:'scene',type:kind==='break'?'SLATE':'MEDIA',renderer:kind==='break'?{kind:'slate',title:'Slate',message:'Message',logo:'https://example.test/logo.png'}:{kind:'source',sourceId:'source'}};
 const catalog={initialized:true,sources:[source],scenes:[scene]};
 const snapshot={scene:{id:'scene',type:scene.type},source:kind==='break'?{id:'scene',kind,title:'Slate',message:'Message',logoUrl:scene.renderer.logo}: {id:'source',kind,...(managed?{url:'http://localhost'+asset.url}:ref?{url:endpoint}:kind==='audio'?{audioUrl:source.audioUrl,stillUrl:source.stillUrl}:{url:source.url})},graphics:{items:[]}};
 const assets={list:()=>available?[asset]:[],get:()=>available?asset:null,safeFilePath:()=>file};
 const validator=new Validation({catalog:()=>catalog,assets,resolveConfigRef:()=>endpoint});const identity=await validator.bind(snapshot),record={envelope:{snapshot},identity};
 return {validator,record,catalog,file,remove:()=>available=false,endpoint:value=>endpoint=value};
}
test('DP1 display name change preserves binding; changed source under same ID does not',async t=>{
 const h=await fixture(t);h.catalog.sources[0].name='Renamed';assert.equal(await h.validator.validate(h.record),true);h.catalog.sources[0].url='https://example.test/different';assert.equal(await h.validator.validate(h.record),false);
});
test('DP1 configRef endpoint change is unresolved',async t=>{const h=await fixture(t,{kind:'hls',ref:true});h.endpoint('https://example.test/replaced');assert.equal(await h.validator.validate(h.record),false);});
test('DP1 changed managed bytes under same ID/path are unresolved',async t=>{const h=await fixture(t,{managed:true});await writeFile(h.file,'changed!');assert.equal(await h.validator.validate(h.record),false);});
test('DP1 deleted managed asset is unresolved',async t=>{const h=await fixture(t,{managed:true});h.remove();assert.equal(await h.validator.validate(h.record),false);});
test('DP1 changed audio artwork is unresolved',async t=>{const h=await fixture(t,{kind:'audio'});h.catalog.sources[0].stillUrl='https://example.test/new.png';assert.equal(await h.validator.validate(h.record),false);});
test('DP1 changed slate message is unresolved',async t=>{const h=await fixture(t,{kind:'break'});h.catalog.scenes[0].renderer.message='Changed';assert.equal(await h.validator.validate(h.record),false);});
test('DP1 missing scene is unresolved, never substituted by another source',async t=>{const h=await fixture(t);h.catalog.scenes=[];assert.equal(await h.validator.validate(h.record),false);});

test('DP1 changed audio motion binding is unresolved',async t=>{const h=await fixture(t,{kind:'audio'});h.catalog.sources[0].motionAssetId='asset';assert.equal(await h.validator.validate(h.record),false);});
