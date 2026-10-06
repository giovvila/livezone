// Only invoked with a unique TEMP trust fixture. No repository executable is altered.
import {readFileSync,writeFileSync,copyFileSync,renameSync,unlinkSync,linkSync,symlinkSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
const [root,kind,helper,counterfeit,parent,marker]=process.argv.slice(2);
const start=Date.now();
while(!existsSync(marker)) {
    if(Date.now()-start>20000)throw Error('Gate did not reach attack boundary');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
let changed=false,error=null;
try {
    if(kind==='rename-substitute') {renameSync(helper,helper+'.away');copyFileSync(counterfeit,helper);}
    else if(kind==='parent-rename') {renameSync(parent,parent+'.away');}
    else if(kind==='delete')unlinkSync(helper);
    else if(kind==='hardlink')linkSync(helper,helper+'.alias');
    else if(kind==='in-place-junction') {
        const cs=`using System; using System.Text; using System.Runtime.InteropServices;
public class Probe {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string p,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(IntPtr h,uint c,byte[] b,uint n,IntPtr o,uint z,out uint r,IntPtr v);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static int Set(string path,string target) {
  var sub=Encoding.Unicode.GetBytes("\\\\??\\\\"+target); var print=Encoding.Unicode.GetBytes(target);
  var b=new byte[20+sub.Length+print.Length];
  Array.Copy(BitConverter.GetBytes(0xA0000003U),0,b,0,4);
  Array.Copy(BitConverter.GetBytes((ushort)(b.Length-8)),0,b,4,2);
  Array.Copy(BitConverter.GetBytes((ushort)sub.Length),0,b,10,2);
  Array.Copy(BitConverter.GetBytes((ushort)(sub.Length+2)),0,b,12,2);
  Array.Copy(BitConverter.GetBytes((ushort)print.Length),0,b,14,2);
  Array.Copy(sub,0,b,16,sub.Length); Array.Copy(print,0,b,18+sub.Length,print.Length);
  var h=CreateFileW(path,256,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  if(h==new IntPtr(-1)) return Marshal.GetLastWin32Error();
  try {uint r; return DeviceIoControl(h,0x900A4,b,(uint)b.Length,IntPtr.Zero,0,out r,IntPtr.Zero)?0:Marshal.GetLastWin32Error();} finally {CloseHandle(h);}
 }
}`;
        const script=`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cs).toString('base64')}'))); [Console]::Write([Probe]::Set($env:LZ_ATTACK_DIRECTORY,$env:LZ_ATTACK_TARGET))`;
        const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',env:{...process.env,LZ_ATTACK_DIRECTORY:parent,LZ_ATTACK_TARGET:dirname(counterfeit)},timeout:5000});
        if(result.status!==0)throw Error('Reparse probe failed: '+result.stderr);
        if(result.stdout!=='0')throw Error('FSCTL_SET_REPARSE_POINT denied: '+result.stdout);
    }
    else if(kind==='junction') {renameSync(parent,parent+'.away');symlinkSync(parent+'.away',parent,'junction');}
    else if(kind==='acl') {
        const result=spawnSync('C:\\Windows\\System32\\icacls.exe',[helper,'/inheritance:r'],{windowsHide:true,encoding:'utf8'});
        if(result.status!==0)throw Error('ACL modification denied: '+result.stderr);
    } else copyFileSync(counterfeit,helper);
    changed=true;
} catch(e) {error=e.code??e.message;}
writeFileSync(join(root,'attack-result.json'),JSON.stringify({kind,changed,error}));
writeFileSync(marker+'.continue','continue');
