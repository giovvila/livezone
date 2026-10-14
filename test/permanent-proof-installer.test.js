import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname,relative,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {installPermanentProof} from '../tools/PermanentProofInstaller.js';
import {windowsSecurity,securityScript} from '../tools/PermanentProofWindowsSecurity.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const id='88443da7-5648-4a73-bda2-68f7db461908';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'lz-era54-installer-'));
 t.after(async()=>{const r=relative(resolve(tmpdir()),root);assert.ok(r.startsWith('lz-era54-installer-')&&!r.startsWith('..')&&!isAbsolute(r));await rm(root,{recursive:true,force:true});});
 const source=join(root,'source'),parent=join(root,'permanent');await mkdir(source);await mkdir(parent);
 const artifacts=[];for(let i=0;i<11;i++){const name='artifact-'+i+'.txt',bytes=Buffer.from('fixture '+i);await writeFile(join(source,name),bytes);artifacts.push({name,sha256:sha(bytes)});}
 const bytes=Buffer.from(JSON.stringify({probeId:id,artifacts}));await writeFile(join(source,'manifest.json'),bytes);
 const hash=sha(bytes),destination=join(parent,id),protectedPaths=new Map();
 const verify=directory=>{
  const m=fs.readFileSync(join(directory,'manifest.json'));assert.equal(sha(m),hash);
  assert.equal(fs.readdirSync(directory).length,12);
  for(const a of artifacts)assert.equal(sha(fs.readFileSync(join(directory,a.name))),a.sha256);
  return {proofHash:hash};
 };
 const security={
  verify:(p,d)=>{if(protectedPaths.get(p)!==d)throw Error('ACL_INVALID');},
  verifyParent:p=>{assert.ok(fs.statSync(p).isDirectory());},
  createDirectory:p=>{fs.mkdirSync(p);protectedPaths.set(p,true);},
  protectFile:p=>protectedPaths.set(p,false),
  publish:(from,to)=>{if(fs.existsSync(to))throw Error('NO_OVERWRITE');fs.renameSync(from,to);for(const [p,d]of [...protectedPaths])if(p===from||p.startsWith(from+requireSeparator())){protectedPaths.delete(p);protectedPaths.set(to+p.slice(from.length),d);}}
 };
 const options={source,destination,expectedHash:hash,verify,security,host:{platform:'win32',administrator:true,serviceIdentity:'LocalSystem'}};
 return {root,parent,destination,source,hash,options,protectedPaths,stage:join(parent,'.install-'+id+'-'+hash+'.stage')};
}
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
test('fresh complete install and matching retry never modifies existing files',async t=>{
 const f=await fixture(t),a=await installPermanentProof(f.options);assert.equal(a.status,'INSTALLED_VERIFIED');
 const before=fs.readdirSync(f.destination).map(n=>[n,fs.statSync(join(f.destination,n)).mtimeMs,sha(fs.readFileSync(join(f.destination,n)))]);
 const b=await installPermanentProof(f.options);assert.equal(b.status,'EXISTING_MATCHING');assert.equal(b.mutated,false);
 assert.deepEqual(fs.readdirSync(f.destination).map(n=>[n,fs.statSync(join(f.destination,n)).mtimeMs,sha(fs.readFileSync(join(f.destination,n)))]),before);
});
for(const kind of ['conflicting','partial'])test('existing '+kind+' final rejected without repair',async t=>{
 const f=await fixture(t);await mkdir(f.destination);await writeFile(join(f.destination,'foreign'),'retained');
 await assert.rejects(installPermanentProof(f.options));assert.equal(fs.readFileSync(join(f.destination,'foreign'),'utf8'),'retained');assert.equal(fs.existsSync(f.stage),false);
});
for(const change of ['hash','machine','volume','administrator','account'])test('invalid '+change+' rejected before mutation',async t=>{
 const f=await fixture(t),o={...f.options,host:{...f.options.host}};
 if(change==='hash')o.expectedHash='f'.repeat(64);
 else if(['machine','volume'].includes(change))o.verify=()=>{throw Error('FOREIGN_'+change);};
 else if(change==='administrator')o.host.administrator=false;else o.host.serviceIdentity='user';
 await assert.rejects(installPermanentProof(o));assert.equal(fs.existsSync(f.stage),false);assert.equal(fs.existsSync(f.destination),false);
});
for(const point of ['before-staging','before-copy','copied','pre-publish','publish','post-publish'])test('failure '+point+' is fail closed; residue retained',async t=>{
 const f=await fixture(t);await assert.rejects(installPermanentProof({...f.options,hook:p=>{if(p===point)throw Error('INJECTED_'+point);}}));
 if(point==='before-staging'){assert.equal(fs.existsSync(f.stage),false);assert.equal(fs.existsSync(f.destination),false);}
 else if(point==='post-publish'){assert.equal(fs.existsSync(f.stage),false);assert.equal(fs.existsSync(f.destination),true);assert.equal((await installPermanentProof(f.options)).status,'EXISTING_MATCHING');}
 else {assert.equal(fs.existsSync(f.stage),true);assert.equal(fs.existsSync(f.destination),false);await assert.rejects(installPermanentProof(f.options),/INSTALL_STAGING_REVIEW_REQUIRED/);}
});
test('ACL failure leaves staging and no accepted final',async t=>{
 const f=await fixture(t);f.options.security.protectFile=()=>{throw Error('ACL_FAILURE');};await assert.rejects(installPermanentProof(f.options),/ACL_FAILURE/);assert.equal(fs.existsSync(f.destination),false);assert.equal(fs.existsSync(f.stage),true);
});
test('post-verification failure is not success, final retained for review',async t=>{
 const f=await fixture(t),original=f.options.verify;f.options.verify=p=>{if(p===f.destination)throw Error('POST_FAIL');return original(p);};await assert.rejects(installPermanentProof(f.options),/POST_FAIL/);assert.equal(fs.existsSync(f.destination),true);await assert.rejects(installPermanentProof(f.options),/POST_FAIL/);
});
test('source drift between validation and publication rejects',async t=>{
 const f=await fixture(t);await assert.rejects(installPermanentProof({...f.options,hook:p=>{if(p==='pre-publish')fs.writeFileSync(join(f.source,'artifact-0.txt'),'drift');}}));assert.equal(fs.existsSync(f.destination),false);
});
test('destination appearing at publication is never overwritten',async t=>{
 const f=await fixture(t);await assert.rejects(installPermanentProof({...f.options,hook:p=>{if(p==='publish'){fs.mkdirSync(f.destination);fs.writeFileSync(join(f.destination,'winner'),'retain');}}}),/NO_OVERWRITE/);
 assert.equal(fs.readFileSync(join(f.destination,'winner'),'utf8'),'retain');assert.equal(fs.existsSync(f.stage),true);
});
test('unsafe parent refused before staging',async t=>{
 const f=await fixture(t);f.options.security.verifyParent=()=>{throw Error('UNSAFE_PARENT');};await assert.rejects(installPermanentProof(f.options),/UNSAFE_PARENT/);assert.equal(fs.existsSync(f.stage),false);assert.equal(fs.existsSync(f.destination),false);
});
test('reparse/junction destination rejected before writing through it',async t=>{
 const f=await fixture(t),alias=join(f.root,'alias');fs.symlinkSync(f.parent,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(installPermanentProof({...f.options,destination:join(alias,id)}),/INSTALL_REPARSE_PATH/);assert.equal(fs.existsSync(f.destination),false);
});
test('existing matching content with wrong ACL is rejected unchanged',async t=>{
 const f=await fixture(t);await installPermanentProof(f.options);f.protectedPaths.delete(f.destination);await assert.rejects(installPermanentProof(f.options),/ACL_INVALID/);assert.equal(fs.readdirSync(f.destination).length,12);
});
test('matching final under newly unsafe parent is not accepted',async t=>{
 const f=await fixture(t);await installPermanentProof(f.options);f.options.security.verifyParent=()=>{throw Error('UNSAFE_PARENT');};await assert.rejects(installPermanentProof(f.options),/UNSAFE_PARENT/);assert.equal(fs.readdirSync(f.destination).length,12);
});
test('production CLI without authorization prints rejection before host or mutation',()=>{
 const r=spawnSync(process.execPath,['tools/install-permanent-capability.mjs'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,1,r.stderr);assert.equal(JSON.parse(r.stdout).reason,'INSTALL_EXPLICIT_AUTHORIZATION_REQUIRED');
});
test('Windows descriptor policy in memory: protected exact SIDs/rights/owner/inheritance',{skip:process.platform!=='win32'},()=>{
 const prefix=securityScript.slice(0,securityScript.indexOf('switch($o.action)'));
 const inspect=String.raw`
foreach($directory in @($true,$false)){
 $acl=Descriptor $directory
 if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544'){throw 'OWNER_PROTECTION'}
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if($rules.Count -ne 2){throw 'COUNT'}
 $a=@($rules|Where-Object{$_.IdentityReference.Value -eq 'S-1-5-32-544'})
 $s=@($rules|Where-Object{$_.IdentityReference.Value -eq 'S-1-5-18'})
 if($a.Count -ne 1 -or $s.Count -ne 1 -or $a[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'ADMIN_RIGHTS'}
 $write=[long][Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
 if(([long]$s[0].FileSystemRights -band $write) -ne 0){throw 'SYSTEM_WRITE'}
 if(($s[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -ne [Security.AccessControl.FileSystemRights]::ReadAndExecute){throw 'SYSTEM_READ'}
 foreach($r in $rules){if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.PropagationFlags -ne 'None'){throw 'RULE'};if($directory){if($r.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'){throw 'DIRECTORY_INHERITANCE'}}elseif($r.InheritanceFlags -ne 'None'){throw 'FILE_INHERITANCE'}}
}
function Get-Acl {param([string]$LiteralPath) return $global:fixtureAcl}
foreach($bad in @('extra','system-write','unprotected','owner','missing-system')){
 $global:fixtureAcl=Descriptor $true
 switch($bad){
  'extra' {$global:fixtureAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))}
  'system-write' {$global:fixtureAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))}
  'unprotected' {$global:fixtureAcl.SetAccessRuleProtection($false,$false)}
  'owner' {$global:fixtureAcl.SetOwner($system)}
  'missing-system' {$global:fixtureAcl.PurgeAccessRules($system)}
 }
 $rejected=$false
 try{Verify 'memory-only' $true $false}catch{$rejected=$true}
 if(-not $rejected){throw ('INVALID_ACL_ACCEPTED:'+ $bad)}
}
$global:fixtureAcl=Descriptor $true
Verify 'memory-only' $true $false
'POLICY_PASS'
`;
 const r=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prefix+inspect,'utf16le').toString('base64')],{input:'{}',encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'POLICY_PASS');
});
test('actual Windows sibling directory publication is complete and never replaces existing target',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),security=windowsSecurity(),stage=join(f.root,'publish-stage'),final=join(f.root,'publish-final');
 fs.cpSync(f.source,stage,{recursive:true});assert.equal(fs.existsSync(final),false);
 security.publish(stage,final);assert.equal(fs.existsSync(stage),false);assert.equal(fs.readdirSync(final).length,12);f.options.verify(final);
 const existing=join(f.root,'existing-target');await mkdir(existing);
 assert.throws(()=>security.publish(final,existing),/INSTALL_SECURITY_FAILED/);
 assert.equal(fs.readdirSync(existing).length,0);f.options.verify(final);
});
test('Windows ACL descriptor and parser, actual isolated ACL integration when admin',async t=>{
 if(process.platform!=='win32'){t.skip('Windows required');return;}
 const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
 const parser="$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
 const r=spawnSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parser,'utf16le').toString('base64')],{input:securityScript,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
 if(r.stdout.trim()!=='True'){t.skip('Actual owner/ACL integration requires Administrator; parser passed');return;}
 const f=await fixture(t),security=windowsSecurity(),d=join(f.root,'acl-test');security.createDirectory(d);security.verify(d,true);const file=join(d,'a');await writeFile(file,'temp');security.protectFile(file);security.verify(file,false);
 const to=join(f.root,'published-acl');security.publish(d,to);security.verify(to,true);security.verify(join(to,'a'),false);
 await mkdir(join(f.root,'conflict'));assert.throws(()=>security.publish(to,join(f.root,'conflict')));
});
