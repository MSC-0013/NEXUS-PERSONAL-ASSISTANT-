@echo off
title Project NEXUS V2.3 — Sovereign AI Assistant
echo ===================================================================
echo             PROJECT NEXUS V2.3 — SYSTEM STARTUP
echo ===================================================================
echo [1/3] Checking Ollama Inference Runtime (http://127.0.0.1:11434)...
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Starting Ollama in background...
    start /b ollama serve
    timeout /t 3 /nobreak >nul
) else (
    echo [OK] Ollama is active.
)

echo [2/3] Starting NEXUS Fastify Chat Gateway on port 3000...
start "NEXUS Chat Gateway" cmd /k "cd /d %~dp0 && node apps/chat-gateway/dist/server.js"
timeout /t 2 /nobreak >nul

echo [3/3] Launching NEXUS Desktop UI on http://localhost:5173...
start "NEXUS Desktop UI" cmd /k "cd /d %~dp0 && npx vite apps/desktop-ui --port 5173 --open"

echo ===================================================================
echo [ONLINE] NEXUS V2.3 is running!
echo Gateway API: http://127.0.0.1:3000/health
echo Web Interface: http://localhost:5173
echo Active Model: nexus:latest (Local RTX 4050 GPU)
echo ===================================================================
