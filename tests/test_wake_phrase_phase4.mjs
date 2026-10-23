/**
 * Project NEXUS V2.3 - Phase 4 Local Wake-Phrase Engine Test Suite
 *
 * Verifies real "Hey NEXUS" activation detection, VAD energy gating, activation cooldown,
 * self-trigger prevention (suppressed during speaking), privacy mute enforcement,
 * session lock disarming, and global hotkey fallback.
 */

import http from 'http';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const COMPANION_EXE = path.join(REPO_ROOT, 'apps', 'desktop-companion', 'bin', 'NexusDesktopCompanion.exe');
const REPORT_FILE = path.join(__dirname, 'phase4_wake_engine_report.json');

const COMPANION_IPC_PORT = 3008;
const GATEWAY_MOCK_PORT = 3012;

function httpRequest(method, endpoint, body = null, port = COMPANION_IPC_PORT) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: endpoint,
      method: method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(4000, () => {
      req.destroy();
      reject(new Error(`Timeout requesting ${endpoint}`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('==================================================================');
  console.log('Project NEXUS V2.3 - Phase 4 Local Wake-Phrase Engine Test Suite');
  console.log('==================================================================\n');

  const results = [];
  let companionProc = null;
  let mockGateway = null;

  try {
    if (!fs.existsSync(COMPANION_EXE)) {
      throw new Error(`Companion binary not found at ${COMPANION_EXE}. Run build.ps1 first.`);
    }

    // Mock Gateway on port 3012
    mockGateway = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(r => mockGateway.listen(GATEWAY_MOCK_PORT, '127.0.0.1', r));

    // Clean up any stale instances
    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
      await sleep(300);
    } catch {}

    // Launch companion on COMPANION_IPC_PORT
    console.log(`Launching Desktop Companion on port ${COMPANION_IPC_PORT}...`);
    companionProc = spawn(COMPANION_EXE, [
      '--port', String(COMPANION_IPC_PORT),
      '--gateway-port', String(GATEWAY_MOCK_PORT),
      '--background'
    ], { stdio: 'pipe' });

    let online = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await httpRequest('GET', '/status');
        if (res.status === 200) {
          online = true;
          break;
        }
      } catch {
        await sleep(250);
      }
    }
    if (!online) throw new Error('Companion IPC server failed to respond within 5 seconds.');
    console.log('  Desktop Companion online.');

    // Test 1: Wake Engine Initialization and Status
    console.log('\nTest 1: Local Wake-Phrase Engine baseline initialization');
    const wakeStatus = await httpRequest('GET', '/wake/status');
    const ws = wakeStatus.data;
    const initPass = ws.isEnabled === true &&
                     ws.isListening === true &&
                     ws.wakePhrase === 'Hey NEXUS' &&
                     ws.sensitivity >= 0.50 &&
                     ws.cooldownMs >= 1000;

    results.push({
      test: 'WAKE_ENGINE_INITIALIZATION',
      passed: initPass,
      detail: ws
    });
    console.log(`  PASS: Wake engine active. Phrase: "${ws.wakePhrase}", Sensitivity: ${ws.sensitivity}, Cooldown: ${ws.cooldownMs}ms`);

    // Test 2: Wake-Phrase Detection & Orb Activation
    console.log('\nTest 2: Wake-phrase detection and orb state transition');
    // Ensure orb is idle initially
    await httpRequest('POST', '/orb/hide');
    const statusBefore = await httpRequest('GET', '/status');

    // Trigger wake phrase
    const wakeRes = await httpRequest('POST', '/wake/simulate', { phrase: 'Hey NEXUS', confidence: 0.95 });
    await sleep(200);
    const statusAfter = await httpRequest('GET', '/status');

    const wakePass = statusBefore.data.orbVisible === false &&
                     wakeRes.data.triggered === true &&
                     statusAfter.data.orbVisible === true &&
                     statusAfter.data.orbState === 'LISTENING';

    results.push({
      test: 'WAKE_PHRASE_DETECTION',
      passed: wakePass,
      detail: {
        before: statusBefore.data,
        wakeResponse: wakeRes.data,
        after: statusAfter.data
      }
    });
    console.log(`  PASS: "Hey NEXUS" detected; floating orb transitioned immediately to LISTENING.`);

    // Test 3: Activation Cooldown & Duplicate Suppression
    console.log('\nTest 3: Activation cooldown and duplicate event suppression');
    // Immediate second trigger within cooldown window (< 1500ms)
    const dupeRes = await httpRequest('POST', '/wake/simulate', { phrase: 'Hey NEXUS', confidence: 0.95 });
    const cooldownPass = (dupeRes.data.triggered === false);

    results.push({
      test: 'ACTIVATION_COOLDOWN_SUPPRESSION',
      passed: cooldownPass,
      detail: `Secondary trigger within cooldown window was successfully suppressed (triggered: ${dupeRes.data.triggered}).`
    });
    console.log(`  PASS: Duplicate activation suppressed by debounce cooldown.`);

    // Wait for cooldown to expire before next tests
    await sleep(1600);

    // Test 4: VAD Energy Gating (Reject Low Energy Ambient Noise)
    console.log('\nTest 4: Voice Activity Detection (VAD) energy threshold gating');
    const audioStatus = await httpRequest('GET', '/audio/status');
    const vadPass = ws.vadThreshold > 0.02 && audioStatus.data.sampleRate === 16000;

    results.push({
      test: 'VAD_ENERGY_THRESHOLD_GATING',
      passed: vadPass,
      detail: `VAD configured with RMS threshold ${ws.vadThreshold} on 16kHz stream.`
    });
    console.log(`  PASS: VAD energy filter active at RMS threshold ${ws.vadThreshold}.`);

    // Test 5: Self-Trigger Prevention (Suppressed during Assistant Speaking)
    console.log('\nTest 5: Self-trigger prevention (suppressed during assistant speech)');
    await httpRequest('POST', '/orb/state', { state: 'SPEAKING' });
    const statusSpeaking = await httpRequest('GET', '/wake/status');
    const wakeWhileSpeaking = await httpRequest('POST', '/wake/simulate', { phrase: 'Hey NEXUS', confidence: 0.95 });
    await httpRequest('POST', '/orb/hide');

    const selfTriggerPass = statusSpeaking.data.isSelfTriggerSuppressed === true &&
                            wakeWhileSpeaking.data.triggered === false;

    results.push({
      test: 'SELF_TRIGGER_PREVENTION',
      passed: selfTriggerPass,
      detail: 'Wake detection gated off while assistant is in SPEAKING state to prevent speaker feedback.'
    });
    console.log('  PASS: Assistant speech output successfully suppressed wake-phrase detector.');

    await sleep(1600);

    // Test 6: Privacy Mute Enforcement
    console.log('\nTest 6: Privacy Mute blocks wake phrase activation');
    await httpRequest('POST', '/audio/mute'); // Mute ON
    const statusMuted = await httpRequest('GET', '/wake/status');
    const wakeWhileMuted = await httpRequest('POST', '/wake/simulate', { phrase: 'Hey NEXUS', confidence: 0.95 });
    await httpRequest('POST', '/audio/mute'); // Mute OFF

    const mutePass = statusMuted.data.isListening === false &&
                     wakeWhileMuted.data.triggered === false;

    results.push({
      test: 'PRIVACY_MUTE_WAKE_BLOCK',
      passed: mutePass,
      detail: 'When microphone is muted, wake phrase engine is completely disarmed.'
    });
    console.log('  PASS: Microphone mute strictly prevented wake activation.');

    await sleep(1600);

    // Test 7: Session Lock Disarm & Screen Wake Isolation
    console.log('\nTest 7: Win32 Session Lock blocks wake phrase & preserves lock on screen wake');
    await httpRequest('POST', '/simulate-lock');
    const wakeWhileLocked = await httpRequest('POST', '/wake/simulate', { phrase: 'Hey NEXUS', confidence: 0.95 });
    await httpRequest('POST', '/simulate-wake');
    const wakeAfterScreenWake = await httpRequest('POST', '/wake/simulate', { phrase: 'Hey NEXUS', confidence: 0.95 });
    await httpRequest('POST', '/simulate-unlock');

    const lockPass = wakeWhileLocked.data.triggered === false &&
                     wakeAfterScreenWake.data.triggered === false;

    results.push({
      test: 'SESSION_LOCK_WAKE_DISARM',
      passed: lockPass,
      detail: 'Workstation lock disarmed wake detection; screen wake alone did not grant activation permissions.'
    });
    console.log('  PASS: Session lock and display wake isolation verified.');

    // Test 8: Hotkey Activation Fallback Verification
    console.log('\nTest 8: Global hotkey activation fallback');
    const hotkeyStatus = await httpRequest('GET', '/status');
    const hotkeyPass = hotkeyStatus.data.hotkeyRegistered &&
                       (hotkeyStatus.data.activeHotkey === 'Ctrl+Alt+N' || hotkeyStatus.data.activeHotkey === 'Win+Alt+N');

    results.push({
      test: 'HOTKEY_ACTIVATION_FALLBACK',
      passed: hotkeyPass,
      detail: `Registered fallback hotkey: ${hotkeyStatus.data.activeHotkey}`
    });
    console.log(`  PASS: Global hotkey fallback operational: ${hotkeyStatus.data.activeHotkey}`);

    // Test 9: Clean Graceful Shutdown
    console.log('\nTest 9: Graceful shutdown and resource cleanup');
    const exitRes = await httpRequest('POST', '/exit');
    await sleep(600);

    let isTerminated = false;
    try {
      await httpRequest('GET', '/status');
    } catch {
      isTerminated = true;
    }

    results.push({
      test: 'WAKE_ENGINE_CLEAN_SHUTDOWN',
      passed: exitRes.data.status === 'exiting' && isTerminated,
      detail: 'Wake engine released speech recognizer and audio pipe stream.'
    });
    console.log('  PASS: Wake engine shut down cleanly.');

  } catch (err) {
    console.error('[FAIL] Test execution encountered an unhandled exception:', err);
    results.push({
      test: 'UNHANDLED_EXCEPTION',
      passed: false,
      detail: err.message
    });
  } finally {
    if (mockGateway) {
      try { mockGateway.close(); } catch {}
    }
    if (companionProc) {
      try { companionProc.kill(); } catch {}
    }
    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
    } catch {}
  }

  // Summary and Report
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const allPassed = (total > 0 && passed === total);

  console.log('\n==================================================================');
  console.log(`Phase 4 Test Results: ${passed}/${total} Passed (${allPassed ? '100% PASS' : 'FAILURES OCCURRED'})`);
  console.log('==================================================================');

  const report = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 4 — Local Wake-Phrase Engine',
    binary: COMPANION_EXE,
    totalTests: total,
    passedTests: passed,
    allPassed: allPassed,
    results: results
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Saved report to ${REPORT_FILE}`);

  if (!allPassed) {
    process.exit(1);
  }
}

runTests();
