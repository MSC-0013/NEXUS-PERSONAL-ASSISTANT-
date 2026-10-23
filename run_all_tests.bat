@echo off
title Project NEXUS V2.3 — Test Suite Runner
echo ===================================================================
echo             PROJECT NEXUS V2.3 — TEST SUITE RUNNER
echo ===================================================================
echo [1/8] Running Phase 5 (Fastify Chat Gateway)...
node tests/test_phase5_gateway.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 5 failed & pause & exit /b 1 )

echo [2/8] Running Phase 6 (SQLite WAL & Audit Sidecar)...
node tests/test_phase6_persistence_audit.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 6 failed & pause & exit /b 1 )

echo [3/8] Running Phase 7 (Personal Memory & FTS5 RAG)...
node tests/test_phase7_rag_fts5.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 7 failed & pause & exit /b 1 )

echo [4/8] Running Phase 8 (Agent Security & Path Jail)...
node tests/test_phase8_agent_security.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 8 failed & pause & exit /b 1 )

echo [5/8] Running Phase 9 (Desktop UI Three.js)...
node tests/test_phase9_desktop_ui.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 9 failed & pause & exit /b 1 )

echo [6/8] Running Phase 10 (Voice Pipeline & Licensing)...
node tests/test_phase10_voice_pipeline.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 10 failed & pause & exit /b 1 )

echo [7/8] Running Phase 11 (Background Scheduler & Leases)...
node tests/test_phase11_scheduler.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 11 failed & pause & exit /b 1 )

echo [8/8] Running Phase 13 (75 Pen Tests & Quiescent Restoration)...
node scripts/create_release_and_restore_test.mjs
if %errorlevel% neq 0 ( echo [FAIL] Phase 13 failed & pause & exit /b 1 )

echo ===================================================================
echo [SUCCESS] ALL PROJECT NEXUS V2.3 TEST SUITES PASSED (100%%)!
echo ===================================================================
pause
