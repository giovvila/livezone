@echo off
setlocal
rem Reviewed SDK/compiler and reference assemblies; no PATH lookup or downloads.
set "SDK=C:\Program Files\dotnet\sdk\8.0.319"
set "REF=C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
if not exist "%SDK%\Roslyn\bincore\csc.dll" exit /b 1
if not exist "%~dp0generated" mkdir "%~dp0generated"
"C:\Program Files\dotnet\dotnet.exe" exec "%SDK%\Roslyn\bincore\csc.dll" /nologo /target:library /platform:x64 /optimize+ /deterministic+ /debug- /noconfig /nostdlib+ /pathmap:"%~dp0=/_/ledger-gate/" /reference:"%REF%\mscorlib.dll" /reference:"%REF%\System.dll" /reference:"%REF%\System.Core.dll" /out:"%~dp0generated\LedgerExecutionGate.dll" "%~dp0ExecutionGate.cs"
exit /b %errorlevel%
