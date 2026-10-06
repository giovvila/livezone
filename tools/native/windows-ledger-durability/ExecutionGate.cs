// Loaded from reviewed bytes, never by an assembly pathname. Windows/.NET are the trust root.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class LedgerExecutionGate {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder path, uint length, uint flags);
    sealed class Pin : IDisposable {
        public SafeFileHandle Handle; public string Path; public Info Identity; public string Security;
        public Pin(string path, bool directory) {
            Path=path;
            // Ancestors remain nonempty: their next child is held without delete
            // sharing. NTFS refuses setting a reparse point on a nonempty directory.
            Handle=CreateFileW(path, directory?0U:0x80000000U, directory?3U:1U, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if(Handle.IsInvalid) throw new IOException("Cannot pin executable namespace", Marshal.GetLastWin32Error());
            try {
                Identity=Inspect(); Security=Acl();
                if(((Identity.Attributes & 16)!=0)!=directory || (!directory && Identity.Links!=1)) throw new IOException("Invalid executable kind/links");
            } catch {Handle.Dispose();throw;}
        }
        Info Inspect() {
            Info i; var path=new StringBuilder(32768);
            if(!GetFileInformationByHandle(Handle,out i) || (i.Attributes&0x400)!=0 ||
                GetFinalPathNameByHandleW(Handle,path,(uint)path.Capacity,0)==0 ||
                !String.Equals(path.ToString(),"\\\\?\\"+Path,StringComparison.OrdinalIgnoreCase)) throw new IOException("Executable identity unavailable");
            return i;
        }
        string Acl() { return ((Identity.Attributes&16)!=0?(System.Security.AccessControl.FileSystemSecurity)Directory.GetAccessControl(Path):File.GetAccessControl(Path)).GetSecurityDescriptorSddlForm(System.Security.AccessControl.AccessControlSections.Owner|System.Security.AccessControl.AccessControlSections.Access); }
        public void Revalidate() {
            var i=Inspect();
            if(i.Volume!=Identity.Volume || i.IndexHigh!=Identity.IndexHigh || i.IndexLow!=Identity.IndexLow ||
                i.SizeHigh!=Identity.SizeHigh || i.SizeLow!=Identity.SizeLow || i.Links!=Identity.Links ||
                i.Attributes!=Identity.Attributes || i.CreationLow!=Identity.CreationLow || i.CreationHigh!=Identity.CreationHigh ||
                ((i.Attributes&16)==0 && (i.WriteLow!=Identity.WriteLow || i.WriteHigh!=Identity.WriteHigh)) || Acl()!=Security)
                throw new IOException("Executable identity changed");
        }
        public string ExecutionPath() {
            var path=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandleW(Handle,path,(uint)path.Capacity,1);
            string value=path.ToString();
            if(length==0 || length>=path.Capacity || !value.StartsWith("\\\\?\\Volume{",StringComparison.OrdinalIgnoreCase))
                throw new IOException("Executable volume path unavailable");
            return value;
        }
        public void Dispose() { Handle.Dispose(); }
    }
    static byte[] Verify(Pin file,string hash) {
        // Keep ownership of the pinned handle; FileStream must not close it.
        var borrowed=new SafeFileHandle(file.Handle.DangerousGetHandle(),false);
        byte[] bytes;
        using(var stream=new FileStream(borrowed,FileAccess.Read)) {
            stream.Position=0;
            if(stream.Length!=190976) throw new IOException("Executable size mismatch");
            bytes=new byte[stream.Length]; int offset=0,count;
            while(offset<bytes.Length && (count=stream.Read(bytes,offset,bytes.Length-offset))>0)offset+=count;
            if(offset!=bytes.Length)throw new IOException("Incomplete executable");
        }
        using(var sha=SHA256.Create()) if(BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant()!=hash)throw new IOException("Executable digest mismatch");
        int pe=BitConverter.ToInt32(bytes,60);
        if(bytes[0]!=77 || bytes[1]!=90 || pe<64 || pe+26>bytes.Length || BitConverter.ToUInt32(bytes,pe)!=0x4550 || BitConverter.ToUInt16(bytes,pe+4)!=0x8664)
            throw new IOException("Executable architecture mismatch");
        return bytes;
    }
    static string Quote(string value) {
        var result=new StringBuilder("\"");int slashes=0;
        foreach(char c in value) {if(c=='\\') {slashes++;continue;}result.Append('\\',c=='\"'?slashes*2+1:slashes);result.Append(c);slashes=0;}
        result.Append('\\',slashes*2);return result.Append('"').ToString();
    }
    // stdin: assembly bytes (consumed by host), helper path, approved digest, command, paths; each is base64 UTF-8.
    public static int Run() {
        var pins=new List<Pin>();
        try {
            var lines=new List<string>(); string line;
            while((line=Console.ReadLine())!=null)lines.Add(Encoding.UTF8.GetString(Convert.FromBase64String(line)));
            if(lines.Count<4 || lines.Count>5)throw new IOException("Invalid execution request");
            string executable=lines[0],root=System.IO.Path.GetPathRoot(executable);
            if(root.Length!=3 || executable.Length>4096 || !String.Equals(System.IO.Path.GetFullPath(executable),executable,StringComparison.OrdinalIgnoreCase) || executable.Substring(2).Contains(":"))throw new IOException("Invalid executable path");
            var drive=new DriveInfo(root);
            if(drive.DriveType!=DriveType.Fixed || drive.DriveFormat!="NTFS")throw new IOException("Unsupported executable volume");
            // Pin from root down: a later component cannot be redirected before it is opened.
            pins.Add(new Pin(root,true));
            string current=root;
            var components=executable.Substring(3).Split('\\');
            for(int i=0;i<components.Length;i++) {
                if(components[i].Length==0 || components[i].EndsWith(".") || components[i].EndsWith(" "))throw new IOException("Executable alias");
                current=System.IO.Path.Combine(current,components[i]); pins.Add(new Pin(current,i<components.Length-1));
            }
            Pin image=pins[pins.Count-1]; Verify(image,lines[1]);
            foreach(var pin in pins)pin.Revalidate();
            // Launch through the held object's volume GUID path, avoiding a second
            // resolution of the caller's mutable DOS drive-letter mapping.
            var start=new ProcessStartInfo(image.ExecutionPath()); start.UseShellExecute=false; start.CreateNoWindow=true;
            start.RedirectStandardOutput=true; start.RedirectStandardError=true;
            var arguments=new List<string>();for(int i=2;i<lines.Count;i++)arguments.Add(Quote(lines[i]));
            start.Arguments=String.Join(" ",arguments.ToArray());
            using(var child=Process.Start(start)) {
                var stdout=child.StandardOutput.ReadToEndAsync(); var stderr=child.StandardError.ReadToEndAsync();
                if(!child.WaitForExit(3000)) {child.Kill();child.WaitForExit();throw new IOException("Executable timeout");}
                if(child.ExitCode!=0 || !stdout.Wait(1000) || !stderr.Wait(1000) || stderr.Result.Length!=0 || stdout.Result.Length>65536)throw new IOException("Executable failed");
                foreach(var pin in pins)pin.Revalidate(); Verify(image,lines[1]);
                // No acknowledgement escapes before post-execution checks, with all pins still held.
                Console.Write(stdout.Result); return 0;
            }
        } catch {return 70;}
        finally {for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();}
    }
}
