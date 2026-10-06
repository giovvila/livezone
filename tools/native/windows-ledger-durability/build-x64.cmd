@echo off
setlocal
rem Discover installed Build Tools; no assumed VS2022/v143 environment.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" exit /b 1
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT exit /b 1
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" -vcvars_ver=14.51 10.0.26100.0
if errorlevel 1 exit /b 1
if not "%VSCMD_ARG_TGT_ARCH%"=="x64" exit /b 1
set "OUT=%~dp0generated"
if not exist "%OUT%" mkdir "%OUT%"
cl /nologo /Bv /std:c++17 /EHsc /W4 /WX /O2 /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fo"%OUT%\main.obj" /Fe"%OUT%\windows-ledger-durability.exe" "%~dp0main.cpp" /link /MACHINE:X64 /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /Brepro
if errorlevel 1 exit /b 1
dumpbin /headers "%OUT%\windows-ledger-durability.exe" | findstr /i "machine"
dumpbin /dependents "%OUT%\windows-ledger-durability.exe"
exit /b %errorlevel%
