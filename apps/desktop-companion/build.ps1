# Build script for NEXUS Desktop Companion using .NET Framework csc.exe
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcFiles = Get-ChildItem -Path (Join-Path $scriptDir "src") -Filter "*.cs" -Recurse | Select-Object -ExpandProperty FullName
$binDir = Join-Path $scriptDir "bin"
$outFile = Join-Path $binDir "NexusDesktopCompanion.exe"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# Pre-build check: Ensure existing binary is not locked by running instance
$runningProcesses = Get-Process NexusDesktopCompanion -ErrorAction SilentlyContinue
if ($runningProcesses) {
    Write-Host "[BUILD] Stopping existing NexusDesktopCompanion process ($($runningProcesses.Count) instance(s))..." -ForegroundColor Yellow
    foreach ($p in $runningProcesses) {
        try {
            $p.Kill()
            $p.WaitForExit(3000)
        } catch { }
    }
    Start-Sleep -Milliseconds 500
}

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}

if (-not (Test-Path $csc)) {
    throw "Visual C# Compiler (csc.exe) not found."
}

Write-Host "Compiling NEXUS Desktop Companion with $csc..." -ForegroundColor Cyan

$references = @(
    "System.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll",
    "C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll"
) -join ","
$args = @(
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/r:$references",
    "/out:$outFile"
) + $srcFiles

& $csc $args

if ($LASTEXITCODE -ne 0) {
    throw "Compilation failed with exit code $LASTEXITCODE"
}

Write-Host "Build complete: $outFile" -ForegroundColor Green
$hash = (Get-FileHash -Algorithm SHA256 $outFile).Hash
Write-Host "Binary SHA-256: $hash" -ForegroundColor Yellow
