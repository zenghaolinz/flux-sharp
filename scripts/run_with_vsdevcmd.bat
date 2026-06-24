@echo off
setlocal
set "VSLANG=1033"
chcp 936 > nul

set "VSDEVCMD=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VSDEVCMD%" set "VSDEVCMD=C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" set "VSDEVCMD=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\Tools\VsDevCmd.bat"

if not exist "%VSDEVCMD%" (
  echo Could not find VsDevCmd.bat.
  exit /b 1
)

call "%VSDEVCMD%"
set "CL=/Zc:preprocessor %CL%"
%*
