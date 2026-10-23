/**
 * Project NEXUS V2.3 - Master Voice-First Regression Certification Suite
 *
 * Runs all 11 phase test suites sequentially in dependency order:
 * Phase 0: Centralized Gateway Policy & Authorization
 * Phase 1: Native Windows Desktop Companion Host
 * Phase 2: Windows Session Sentinel & Fail-Closed Dead-Man Switch
 * Phase 3: Native Win32 Audio Subsystem
 * Phase 4: Local Wake-Phrase Engine ("Hey NEXUS")
 * Phase 5: Local Speech-to-Text Engine & EOU Silence Detector
 * Phase 6: Voice-to-Gateway Pipeline & Pre-Execution Defense
 * Phase 7: Production-Quality Floating Orb & Visual Polish
 * Phase 8: Local Text-to-Speech & Instant Barge-In Interruption
 * Phase 9: Complete End-to-End Autonomous Voice Loop
 * Phase 10: Hardening, Packaging, Autostart & Release Certification
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MASTER_REPORT = path.join(__dirname, 'nexus_master_regression_report.json');

const SUITES = [
  { phase: 0, name: "Gateway Security Policy", file: "test_gateway_security_policy.mjs" },
  { phase: 1, name: "Native Desktop Companion", file: "test_desktop_companion_phase1.mjs" },
  { phase: 2, name: "Session Sentinel & Heartbeat", file: "test_session_sentinel_phase2.mjs" },
  { phase: 3, name: "Native Audio Subsystem", file: "test_native_audio_phase3.mjs" },
  { phase: 4, name: "Local Wake-Phrase Engine", file: "test_wake_phrase_phase4.mjs" },
  { phase: 5, name: "Local Speech-to-Text & EOU", file: "test_speech_to_text_phase5.mjs" },
  { phase: 6, name: "Voice-to-Gateway Pipeline", file: "test_voice_gateway_phase6.mjs" },
  { phase: 7, name: "Production-Quality Floating Orb", file: "test_floating_orb_phase7.mjs" },
  { phase: 8, name: "Local Text-to-Speech & Barge-In", file: "test_text_to_speech_phase8.mjs" },
  { phase: 9, name: "Complete End-to-End Voice Loop", file: "test_end_to_end_voice_phase9.mjs" },
  { phase: 10, name: "Hardening & Release Certification", file: "test_hardening_release_phase10.mjs" }
];

async function main() {
  console.log('========================================================================');
  console.log('PROJECT NEXUS V2.3 — MASTER VOICE-FIRST REGRESSION SUITE (PHASES 0-10)');
  console.log('========================================================================\n');

  const suiteResults = [];
  let totalTestsAcrossAll = 0;
  let totalPassAcrossAll = 0;

  for (const s of SUITES) {
    const fullPath = path.join(__dirname, s.file);
    console.log(`>>> [RUNNING PHASE ${s.phase}] ${s.name} (${s.file})...`);
    const t0 = Date.now();

    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
    } catch {}

    let output = '';
    let exitCode = 0;

    try {
      output = execSync(`node "${fullPath}"`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 45000
      });
      exitCode = 0;
    } catch (ex) {
      exitCode = ex.status || 1;
      output = (ex.stdout || '').toString() + '\n' + (ex.stderr || '').toString();
    }

    const durationMs = Date.now() - t0;
    const passed = (exitCode === 0);

    // Extract test counts if matching format
    const countMatch = output.match(/(\d+)\/(\d+)\s+Passed/i);
    const testsPassed = countMatch ? parseInt(countMatch[1]) : (passed ? 1 : 0);
    const testsTotal = countMatch ? parseInt(countMatch[2]) : 1;

    totalTestsAcrossAll += testsTotal;
    totalPassAcrossAll += testsPassed;

    suiteResults.push({
      phase: s.phase,
      name: s.name,
      script: s.file,
      passed,
      testsPassed,
      testsTotal,
      durationMs,
      exitCode
    });

    console.log(`    Result: ${passed ? '✅ 100% PASS' : '❌ FAIL'} (${testsPassed}/${testsTotal} tests, ${durationMs}ms)\n`);
  }

  const allPassed = (totalPassAcrossAll === totalTestsAcrossAll && suiteResults.every(r => r.passed));

  console.log('========================================================================');
  console.log(`MASTER REGRESSION VERDICT: ${allPassed ? '✅ 100% CERTIFIED' : '❌ FAILURES OCCURRED'}`);
  console.log(`Total Passing Tests: ${totalPassAcrossAll} / ${totalTestsAcrossAll} (${suiteResults.length} Phases Tested)`);
  console.log('========================================================================\n');

  const report = {
    timestamp: new Date().toISOString(),
    verdict: allPassed ? "PASSED_AND_CERTIFIED" : "FAILURES_DETECTED",
    totalPhases: SUITES.length,
    totalTests: totalTestsAcrossAll,
    passedTests: totalPassAcrossAll,
    allPassed,
    suites: suiteResults
  };

  fs.writeFileSync(MASTER_REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Master regression report saved to ${MASTER_REPORT}`);

  if (!allPassed) {
    process.exit(1);
  }
}

main();
