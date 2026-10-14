import {spawnSync} from 'node:child_process';
// Fixed descriptor: Administrators own/manage; SYSTEM reads/executes. No inherited
// or third-principal ACE. SID-based rules do not depend on localized account names.
export const securityScript=String.raw`
$ErrorActionPreference='Stop'
$o=[Console]::In.ReadToEnd() | ConvertFrom-Json
$admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Descriptor([bool]$directory) {
 if($directory){$acl=[Security.AccessControl.DirectorySecurity]::new()}else{$acl=[Security.AccessControl.FileSecurity]::new()}
 $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($admins)
 $inherit=[Security.AccessControl.InheritanceFlags]::None
 if($directory){$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 return $acl
}
function Verify([string]$target,[bool]$directory,[bool]$parent) {
 $acl=Get-Acl -LiteralPath $target
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($owner -notin 'S-1-5-32-544','S-1-5-18'){throw 'INSTALL_ACL_OWNER'}
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if($parent){
  $write=[long][Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  foreach($r in $rules){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin 'S-1-5-32-544','S-1-5-18' -and (([long]$r.FileSystemRights -band $write) -ne 0)){throw 'INSTALL_PARENT_WRITABLE'}}
  return
 }
 if(-not $acl.AreAccessRulesProtected -or $owner -ne 'S-1-5-32-544' -or $rules.Count -ne 2){throw 'INSTALL_ACL_PROTECTION'}
 $expected=Descriptor $directory
 $expectedRules=@($expected.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 foreach($e in $expectedRules){
  $match=@($rules|Where-Object{$_.IdentityReference.Value -eq $e.IdentityReference.Value -and $_.FileSystemRights -eq $e.FileSystemRights -and $_.InheritanceFlags -eq $e.InheritanceFlags -and $_.PropagationFlags -eq $e.PropagationFlags -and $_.AccessControlType -eq $e.AccessControlType -and -not $_.IsInherited})
  if($match.Count -ne 1){throw 'INSTALL_ACL_RULE'}
 }
}
switch($o.action){
 'verify' {Verify $o.path ([bool]$o.directory) $false}
 'parent' {Verify $o.path $true $true}
 'create' {if(Test-Path -LiteralPath $o.path){throw 'INSTALL_DIRECTORY_EXISTS'};[void][IO.Directory]::CreateDirectory($o.path,(Descriptor $true))}
 'protect-file' {Set-Acl -LiteralPath $o.path -AclObject (Descriptor $false)}
 'publish' {[IO.Directory]::Move($o.path,$o.destination)}
 default {throw 'INSTALL_SECURITY_ACTION'}
}
'{"ok":true}'
`;
export function windowsSecurity(){
    const invoke=o=>{
        const r=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(securityScript,'utf16le').toString('base64')],{input:JSON.stringify(o),encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
        if(r.error||r.status!==0)throw Error('INSTALL_SECURITY_FAILED: '+(r.error?.message||r.stderr));
        if(JSON.parse(r.stdout.trim()).ok!==true)throw Error('INSTALL_SECURITY_RESULT');
    };
    return {verify:(path,directory)=>invoke({action:'verify',path,directory}),verifyParent:path=>invoke({action:'parent',path}),createDirectory:path=>invoke({action:'create',path}),protectFile:path=>invoke({action:'protect-file',path}),publish:(path,destination)=>invoke({action:'publish',path,destination})};
}
