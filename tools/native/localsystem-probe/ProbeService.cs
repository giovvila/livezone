// Template compiled only into a dedicated TEMP root. Constants are injected by
// the administrative launcher; the service accepts no runtime command arguments.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ServiceProcess;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class ProbeService : ServiceBase {
    static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
    static readonly string Root=Decode("__ROOT__"), Node=Decode("__NODE__"), Script=Decode("__SCRIPT__");
    const string Mode="__MODE__", ScriptHash="__SCRIPT_HASH__", Name="__SERVICE__";
    IntPtr job=IntPtr.Zero; Process child; readonly object gate=new object();
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime;public uint Flags;public UIntPtr Minimum,Maximum;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    void Record(string file,string text) { File.WriteAllText(Path.Combine(Root,file+"-"+Mode+".txt"),text); }
    public ProbeService() { ServiceName=Name;CanStop=true;AutoLog=false; }
    protected override void OnStart(string[] args) {
        if(args.Length!=0)throw new InvalidOperationException("No service arguments accepted");
        var worker=new Thread(Run);worker.IsBackground=true;worker.Start();
    }
    void Run() {
        try {
            var identity=WindowsIdentity.GetCurrent();
            Record("host-identity",identity.Name+"\n"+identity.User.Value+"\n"+Process.GetCurrentProcess().Id);
            if(identity.User.Value!="S-1-5-18")throw new InvalidOperationException("LocalSystem required");
            var full=Path.GetFullPath(Root);if(full!=Root||!Path.GetFileName(Root).StartsWith("lz-era05-probe-")||(File.GetAttributes(Root)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Invalid probe root");
            string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(Script))).Replace("-","").ToLowerInvariant();
            if(digest!=ScriptHash)throw new InvalidOperationException("Probe script changed");
            var info=new Extended();info.Basic.Flags=0x2000;
            lock(gate){
                job=CreateJobObject(IntPtr.Zero,null);
                if(job==IntPtr.Zero||!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(Extended))))throw new InvalidOperationException("Kill-on-close job unavailable");
                var start=new ProcessStartInfo(Node,"\""+Script+"\" \""+Root+"\" "+Mode);start.UseShellExecute=false;start.CreateNoWindow=true;
                start.EnvironmentVariables["TEMP"]=Path.GetDirectoryName(Root);start.EnvironmentVariables["TMP"]=Path.GetDirectoryName(Root);
                child=Process.Start(start);
                if(!AssignProcessToJobObject(job,child.Handle)){child.Kill();throw new InvalidOperationException("Job assignment failed");}
                Record("host-child",child.Id.ToString());
                File.WriteAllText(Path.Combine(Root,"launch-"+Mode),"ASSIGNED_TO_KILL_ON_CLOSE_JOB");
            }
            var limit=Mode=="timeout"?3000:60000;
            if(!child.WaitForExit(limit)){Record("host-result","TIMEOUT");CloseJob();child.WaitForExit(5000);}
            else Record("host-result","EXIT="+child.ExitCode);
        }catch(Exception error){Record("host-error",error.ToString());}
        finally { CloseJob();Stop(); }
    }
    void CloseJob(){lock(gate){if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}}
    protected override void OnStop(){CloseJob();Record("host-stop","STOPPED_JOB_CLOSED");}
    public static void Main(){ServiceBase.Run(new ProbeService());}
}
