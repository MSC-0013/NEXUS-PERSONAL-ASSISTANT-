@echo off
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "bin" mkdir "bin"

echo Compiling NEXUS Desktop Companion...
"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll /out:bin\NexusDesktopCompanion.exe /recurse:src\*.cs

if %ERRORLEVEL% equ 0 (
    echo Build successful: bin\NexusDesktopCompanion.exe
) else (
    echo Build failed with error %ERRORLEVEL%
)
