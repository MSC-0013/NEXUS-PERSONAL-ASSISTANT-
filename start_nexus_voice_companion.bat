@echo off
setlocal enabledelayedexpansion

echo ====================================================================
echo Project NEXUS V2.3 - Voice-First Windows Desktop Assistant Launcher
echo ====================================================================
echo.

set REPO_ROOT=%~dp0
set COMPANION_EXE=%REPO_ROOT%apps\desktop-companion\bin\NexusDesktopCompanion.exe
set GATEWAY_DIR=%REPO_ROOT%apps\chat-gateway

if not exist "%COMPANION_EXE%" (
    echo [ERROR] NexusDesktopCompanion.exe not found at:
    echo         %COMPANION_EXE%
    echo Please compile it first via apps\desktop-companion\build.ps1.
    pause
    exit /b 1
)

echo [1/4] Checking Ollama Local AI Runtime (http://127.0.0.1:11434)...
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Starting Ollama server in background...
    start "Ollama Server" /min ollama serve
    timeout /t 3 /nobreak >nul
) else (
    echo [OK] Ollama server is active.
)

echo [2/4] Checking NEXUS Chat Gateway (http://127.0.0.1:3000)...
curl -s http://127.0.0.1:3000/health >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Starting NEXUS Chat Gateway...
    start "NEXUS Chat Gateway" /min node "%GATEWAY_DIR%\dist\server.js"
    timeout /t 2 /nobreak >nul
) else (
    echo [OK] Chat Gateway is online on port 3000.
)

echo [3/4] Checking NEXUS Desktop Companion (http://127.0.0.1:3005)...
curl -s http://127.0.0.1:3005/status >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Launching NEXUS Desktop Companion...
    start "" "%COMPANION_EXE%" --background --port 3005 --gateway-port 3000
    timeout /t 2 /nobreak >nul
) else (
    echo [OK] NEXUS Desktop Companion is active.
)

echo [4/4] Verifying End-to-End Voice Subsystem...
curl -s http://127.0.0.1:3005/orb/status >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Floating Orb and Speech Subsystem operational.
)

echo.
echo ====================================================================
echo Project NEXUS V2.3 Voice Assistant is ONLINE and active.
echo.
echo Activation triggers:
echo   - Acoustic: Say "Hey NEXUS" into your microphone
echo   - Hotkey:   Press Ctrl+Alt+N (or Win+Alt+N)
echo   - Tray Icon: Double-click animated orb tray icon in notification area
echo.
echo Privacy ^& Security:
echo   - Workstation Lock (Win+L): Instantly disarms audio and fails closed
echo   - Privacy Mute: Right-click tray icon -^> "Mute Microphone"
echo.
echo Diagnostic CLI:
echo   - Status: apps\desktop-companion\bin\NexusDesktopCompanion.exe --status
echo   - Exit:   apps\desktop-companion\bin\NexusDesktopCompanion.exe --exit
echo ====================================================================
echo.

:InteractionLoop
echo Type a question to test NEXUS (or press Enter on empty prompt to run in background):
set USER_INPUT=
set /p USER_INPUT="Ask NEXUS > "
if "%USER_INPUT%"=="" goto :BackgroundExit

echo [Dispatching to NEXUS Voice Loop...]
powershell -NoProfile -Command "$prompt = @\"%USER_INPUT%\"@; try { $body = @{ text = $prompt } | ConvertTo-Json; $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3005/voice/dispatch' -Method Post -ContentType 'application/json' -Body $body; Write-Host ('[NEXUS Answer]: ' + $resp.message.content) -ForegroundColor Green } catch { Write-Host ('[Error]: ' + $_.Exception.Message) -ForegroundColor Red }"
echo.
goto :InteractionLoop

:BackgroundExit
echo.
echo [INFO] NEXUS is running quietly in the background in your system tray.
echo Use the tray icon, press Ctrl+Alt+N, or say "Hey NEXUS" anytime.
echo.
pause
