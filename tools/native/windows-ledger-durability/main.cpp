// Storage operations only. No ledger policy, network, shell or privileges.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdio>
#include <string>
#include <vector>
#include <utility>
#if !defined(_M_X64)
#error This helper requires an x64 target
#endif

static const char* phase="arguments";
struct Failure { int exit; DWORD error; };
static void reject(int code, DWORD error = ERROR_NOT_SUPPORTED) { throw Failure{code,error}; }
static void checked(BOOL result) { if (!result) reject(5,GetLastError()); }
struct Handle {
    HANDLE value;
    explicit Handle(HANDLE h):value(h) { if(h==INVALID_HANDLE_VALUE) reject(5,GetLastError()); }
    ~Handle() { if(value!=INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(Handle&& h) noexcept:value(std::exchange(h.value,INVALID_HANDLE_VALUE)) {}
    Handle(const Handle&)=delete;
};
static bool same(const std::wstring& a,const std::wstring& b) { return _wcsicmp(a.c_str(),b.c_str())==0; }
static std::wstring canonical(const wchar_t* input) {
    const std::wstring p(input);
    // Deliberately narrow: absolute DOS paths, no UNC/devices/ADS/aliases.
    if(p.size()<3 || p.size()>4096 || !iswalpha(p[0]) || p[1]!=L':' || p[2]!=L'\\' ||
       p.find(L'/',0)!=std::wstring::npos || p.find(L':',2)!=std::wstring::npos) reject(3,ERROR_INVALID_NAME);
    for(size_t start=3;start<p.size();) {
        size_t end=p.find(L'\\',start); if(end==std::wstring::npos) end=p.size();
        const auto part=p.substr(start,end-start);
        if(part.empty() || part==L"." || part==L".." || part.back()==L'.' || part.back()==L' ' ||
           part.find_first_of(L"*?\"<>|")!=std::wstring::npos) reject(3,ERROR_INVALID_NAME);
        start=end+1;
    }
    wchar_t full[4097]; DWORD n=GetFullPathNameW(p.c_str(),4097,full,nullptr);
    if(!n || n>=4097) reject(3,ERROR_INVALID_NAME);
    std::wstring result(full);
    if(result.size()>3 && result.back()==L'\\') result.pop_back();
    auto original=p; if(original.size()>3 && original.back()==L'\\') original.pop_back();
    if(!same(result,original)) reject(3,ERROR_INVALID_NAME);
    return result;
}
static std::wstring finalName(HANDLE h,DWORD volume) {
    wchar_t out[4097]; DWORD n=GetFinalPathNameByHandleW(h,out,4097,FILE_NAME_NORMALIZED|volume);
    if(!n || n>=4097) reject(4,n?ERROR_BUFFER_OVERFLOW:GetLastError());
    return out;
}
static void ordinary(HANDLE h,bool directory) {
    BY_HANDLE_FILE_INFORMATION info{}; checked(GetFileInformationByHandle(h,&info));
    if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT) ||
       bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory || (!directory && info.nNumberOfLinks!=1))
        reject(3,ERROR_INVALID_PARAMETER);
    if(GetFileType(h)!=FILE_TYPE_DISK) reject(4);
}
struct Directory {
    std::wstring path,volume;
    DWORD serial=0;
    std::vector<Handle> chain;
    explicit Directory(const std::wstring& p):path(p) {
        // Pin every ancestor against rename/delete while checking reparse points.
        for(size_t end=3;;) {
            const std::wstring part=p.substr(0,end);
            const bool last=end==p.size();
            phase=last?"open-directory":"open-ancestor";
            chain.emplace_back(CreateFileW(part.c_str(),last?(GENERIC_READ|GENERIC_WRITE):0,
                FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            ordinary(chain.back().value,true);
            if(last) break;
            auto next=p.find(L'\\',end==3?3:end+1);
            end=next==std::wstring::npos?p.size():next;
        }
        phase="canonical-directory";
        const auto dos=finalName(handle(),VOLUME_NAME_DOS);
        if(dos.size()<4 || !same(dos.substr(4),p)) reject(4,ERROR_INVALID_NAME);
        const auto guid=finalName(handle(),VOLUME_NAME_GUID);
        const auto end=guid.find(L"}\\");
        if(guid.rfind(L"\\\\?\\Volume{",0)!=0 || end==std::wstring::npos) reject(4);
        volume=guid.substr(0,end+2);
        wchar_t mount[4097],mountedVolume[4097],fs[64]; DWORD flags=0;
        phase="volume-path";
        checked(GetVolumePathNameW(p.c_str(),mount,4097));
        checked(GetVolumeNameForVolumeMountPointW(mount,mountedVolume,4097));
        if(!same(volume,mountedVolume) || GetDriveTypeW(volume.c_str())!=DRIVE_FIXED) reject(4);
        phase="filesystem";
        checked(GetVolumeInformationByHandleW(handle(),nullptr,0,&serial,nullptr,&flags,fs,64));
        if(wcscmp(fs,L"NTFS")!=0 || (flags&FILE_READ_ONLY_VOLUME)) reject(4);
    }
    HANDLE handle() const { return chain.back().value; }
    void flush() const { phase="directory-flush";checked(FlushFileBuffers(handle())); }
};
static std::wstring parent(const std::wstring& p) {
    const size_t at=p.find_last_of(L'\\');
    if(at==std::wstring::npos || p.size()<=3) reject(3,ERROR_INVALID_NAME);
    return at==2?p.substr(0,3):p.substr(0,at);
}
static Handle file(const std::wstring& p) {
    Handle h(CreateFileW(p.c_str(),GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
        nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    ordinary(h.value,false);
    const auto name=finalName(h.value,VOLUME_NAME_DOS);
    if(name.size()<4 || !same(name.substr(4),p)) reject(3,ERROR_INVALID_NAME);
    return h;
}
static std::string jsonString(const std::wstring& p) {
    int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,p.data(),static_cast<int>(p.size()),nullptr,0,nullptr,nullptr);
    if(!n) reject(3,GetLastError());
    std::string utf(n,' '); checked(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,p.data(),static_cast<int>(p.size()),utf.data(),n,nullptr,nullptr));
    std::string out="\"";
    for(unsigned char c:utf) { if(c=='"'||c=='\\') {out+='\\';out+=c;} else if(c<32) {char b[7];sprintf_s(b,"\\u%04x",c);out+=b;} else out+=c; }
    return out+'"';
}
static DWORD WINAPI deadline(void*) {
    Sleep(5000);
    // No success can be inferred after termination, even if a mutation occurred.
    // Do not block the watchdog on an unread stdout pipe. Timeout has no ACK.
    TerminateProcess(GetCurrentProcess(),7);
    return 7;
}
int wmain(int argc,wchar_t** argv) {
    const char* command="invalid";
    try {
        HANDLE thread=CreateThread(nullptr,0,deadline,nullptr,0,nullptr);
        if(!thread)reject(5,GetLastError());
        Handle watchdog(thread);
        if(argc<2) reject(2,ERROR_BAD_ARGUMENTS);
        bool mutation=false,remove=false,replace=false;
        if(wcscmp(argv[1],L"capability")==0) command="capability";
        else if(wcscmp(argv[1],L"sync-directory")==0) command="sync-directory";
        else if(wcscmp(argv[1],L"durable-replace")==0) {command="durable-replace";mutation=true;replace=true;}
        else if(wcscmp(argv[1],L"durable-archive")==0) {command="durable-archive";mutation=true;}
        else if(wcscmp(argv[1],L"durable-remove")==0) {command="durable-remove";mutation=true;remove=true;}
        else reject(2,ERROR_BAD_ARGUMENTS);
        if(argc!=(mutation&&!remove?4:3)) reject(2,ERROR_BAD_ARGUMENTS);
        auto source=canonical(argv[2]);
        Directory directory(mutation?parent(source):source);
        if(mutation) {
            auto opened=file(source); checked(FlushFileBuffers(opened.value));
            if(remove) {
                checked(DeleteFileW(source.c_str()));
                // Complete delete-on-close before flushing the parent.
                checked(CloseHandle(opened.value)); opened.value=INVALID_HANDLE_VALUE;
            } else {
                auto destination=canonical(argv[3]);
                if(!same(parent(destination),directory.path) || same(source,destination)) reject(3,ERROR_INVALID_NAME);
                DWORD attrs=GetFileAttributesW(destination.c_str());
                if(attrs!=INVALID_FILE_ATTRIBUTES) {auto target=file(destination);}
                else if(GetLastError()!=ERROR_FILE_NOT_FOUND) reject(5,GetLastError());
                // No COPY_ALLOWED: only same-directory, same-volume rename.
                checked(MoveFileExW(source.c_str(),destination.c_str(),MOVEFILE_WRITE_THROUGH|(replace?MOVEFILE_REPLACE_EXISTING:0)));
                auto installed=file(destination); checked(FlushFileBuffers(installed.value));
            }
        }
        // Capability performs the identical actual NTFS directory flush.
        directory.flush();
        const auto path=jsonString(directory.path),volume=jsonString(directory.volume);
        std::printf("{\"helper\":\"livezone-windows-ledger-durability\",\"version\":\"1.0.0\",\"protocol\":1,\"architecture\":\"x64\",\"command\":\"%s\",\"ok\":true,\"directory\":%s,\"volume\":%s,\"volumeSerial\":%lu,\"filesystem\":\"NTFS\",\"local\":true,\"barrier\":\"NTFS_DIRECTORY_FLUSH\"}\n",command,path.c_str(),volume.c_str(),directory.serial);
        return 0;
    } catch(const Failure& f) {
        std::printf("{\"helper\":\"livezone-windows-ledger-durability\",\"version\":\"1.0.0\",\"protocol\":1,\"architecture\":\"x64\",\"command\":\"%s\",\"ok\":false,\"exit\":%d,\"win32\":%lu,\"phase\":\"%s\"}\n",command,f.exit,f.error,phase);
        return f.exit;
    } catch(...) { std::puts("{\"ok\":false,\"exit\":6}"); return 6; }
}
