import {open,mkdir,unlink} from 'node:fs/promises';
import {renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,MAX_DURABLE_BYTES,validateRecord} from './DurableProgramContract.js';

// Single writer under execution authority's exclusive lock. Synchronous final
// replacement is the short commit reservation: no JS mutation can interleave.
export default class DurableProgramRepository {
 constructor({path,hook=()=>{},operations={}}){Object.assign(this,{path,hook});this.fs={open,mkdir,unlink,renameSync,openSync,fsyncSync,closeSync,...operations};this.status='UNAVAILABLE';this.record=null;}
 async load(){
  let file;
  try{
   file=await this.fs.open(this.path,'r');const stat=await file.stat();if(!stat.isFile()||stat.size>MAX_DURABLE_BYTES)throw Error('DURABLE_CORRUPT');
   const bytes=Buffer.alloc(MAX_DURABLE_BYTES+1);let size=0;
   while(size<bytes.length){const r=await file.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
   if(size>MAX_DURABLE_BYTES)throw Error('DURABLE_CORRUPT');
   this.record=validateRecord(JSON.parse(bytes.subarray(0,size).toString('utf8')));this.status=this.record.programState;
  }catch(error){this.record=null;this.status=error.code==='ENOENT'||['EACCES','EPERM','EIO'].includes(error.code)?'UNAVAILABLE':'CORRUPT';this.error=error.code==='ENOENT'?'DURABLE_MISSING':'DURABLE_READ_FAILED';}
  finally{if(file)await file.close().catch(()=>{});}return this.record;
 }
 async stage(record){
  const bytes=Buffer.from(canonical(validateRecord(record))+'\n');if(bytes.length>MAX_DURABLE_BYTES)throw Error('DURABLE_TOO_LARGE');
  const path=this.path+'.'+randomUUID()+'.tmp';let file;
  try{
   await this.fs.mkdir(dirname(this.path),{recursive:true});file=await this.fs.open(path,'wx',0o600);this.hook('opened');
   let offset=0;while(offset<bytes.length){const {bytesWritten}=await file.write(bytes,offset,bytes.length-offset,null);if(!bytesWritten)throw Error('DURABLE_SHORT_WRITE');offset+=bytesWritten;}
   this.hook('written');await file.sync();this.hook('flushed');await file.close();file=null;this.hook('staged');
   return {path,record};
  }catch(error){if(file)await file.close().catch(()=>{});await this.fs.unlink(path).catch(()=>{});throw error;}
 }
 commit(staged){
  try{
   this.hook('before-replace');this.fs.renameSync(staged.path,this.path);this.hook('replaced');
   const fd=this.fs.openSync(this.path,'r+');try{this.fs.fsyncSync(fd);}finally{this.fs.closeSync(fd);}
   this.record=staged.record;this.status=staged.record.programState;this.error=null;
  }catch(error){this.status='UNAVAILABLE';this.error='DURABLE_COMMIT_UNCERTAIN';throw error;}
 }
 async discard(staged){if(staged)await this.fs.unlink(staged.path).catch(()=>{});}
}
