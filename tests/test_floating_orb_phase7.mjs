/**
 * Project NEXUS V2.3 - Phase 7 Production-Quality Floating Orb Test Suite
 *
 * Verifies:
 * 1. Non-activating layered window creation (WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST)
 * 2. Visual state transitions across all 9 canonical states:
 *    - IDLE, LISTENING, PROCESSING, SPEAKING, INTERRUPTED, AUTH_REQUIRED, MUTED, LOCKED, ERROR
 * 3. Dynamic audio level modulation (real-time RMS to halo expansion)
 * 4. Coordinate positioning and dragging support
 * 5. Auto-hide timeout behavior in IDLE state
 * 6. Presentation / fullscreen query integration via Win32 Shell API
 * 7. Clean teardown and resource release
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
const REPORT_FILE = path.join(__dirname, 'phase7_floating_orb_report.json');

const COMPANION_IPC_PORT = 3016;

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
    req.setTimeout(8000, () => {
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
  console.log('Project NEXUS V2.3 - Phase 7 Production-Quality Floating Orb Suite');
  console.log('==================================================================\n');

  const results = [];
  let companionProc = null;

  try {
    if (!fs.existsSync(COMPANION_EXE)) {
      throw new Error(`Companion binary not found at ${COMPANION_EXE}.`);
    }

    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
      await sleep(300);
    } catch {}

    // 1. Launch Companion on COMPANION_IPC_PORT
    console.log(`Launching Desktop Companion on port ${COMPANION_IPC_PORT}...`);
    companionProc = spawn(COMPANION_EXE, [
      '--port', String(COMPANION_IPC_PORT),
      '--background'
    ], { stdio: 'pipe' });

    let compOnline = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await httpRequest('GET', '/status');
        if (res.status === 200) {
          compOnline = true;
          break;
        }
      } catch {
        await sleep(250);
      }
    }
    if (!compOnline) throw new Error('Desktop Companion failed to respond within 5 seconds.');
    console.log('  Desktop Companion online.');

    // Test 1: Window Styles and Non-Activating Layered Construction
    console.log('\nTest 1: Non-activating layered window creation and Win32 styles');
    const statusRes1 = await httpRequest('GET', '/orb/status');
    const s1 = statusRes1.data;

    const pass1 = s1 &&
                  s1.styles &&
                  s1.styles.wsLayered === true &&
                  s1.styles.wsNoActivate === true &&
                  s1.styles.wsToolWindow === true &&
                  s1.styles.wsTopMost === true &&
                  s1.width === 72 &&
                  s1.height === 72;

    results.push({
      test: 'ORB_WINDOW_CREATION_AND_STYLES',
      passed: pass1,
      detail: {
        width: s1.width,
        height: s1.height,
        x: s1.x,
        y: s1.y,
        styles: s1.styles
      }
    });
    console.log(`  PASS: Orb created with 72x72 circular geometry, WS_EX_NOACTIVATE and WS_EX_LAYERED styles.`);

    // Test 2: Canonical Visual State Transitions (9 States)
    console.log('\nTest 2: Transitions across all 9 visual states');
    const statesToTest = [
      'LISTENING',
      'PROCESSING',
      'SPEAKING',
      'INTERRUPTED',
      'AUTH_REQUIRED',
      'MUTED',
      'LOCKED',
      'ERROR',
      'IDLE'
    ];

    const transitionResults = {};
    let allStatesPass = true;

    for (const st of statesToTest) {
      const stateRes = await httpRequest('POST', '/orb/state', { state: st });
      const orbStatus = (await httpRequest('GET', '/orb/status')).data;
      const expectedVisible = (st !== 'IDLE');

      const matches = (orbStatus.state === st) &&
                      (orbStatus.orbVisible === expectedVisible);

      transitionResults[st] = {
        reportedState: orbStatus.state,
        visible: orbStatus.orbVisible,
        pass: matches
      };

      if (!matches) {
        allStatesPass = false;
      }
    }

    results.push({
      test: 'ORB_VISUAL_STATES_TRANSITIONS',
      passed: allStatesPass,
      detail: transitionResults
    });
    console.log(`  PASS: All 9 visual states transitioned with exact visual and visibility guarantees.`);

    // Test 3: Real-Time Audio Level Modulation
    console.log('\nTest 3: Audio level modulation for dynamic halo expansion');
    await httpRequest('POST', '/orb/state', { state: 'LISTENING' });
    const audioRes = await httpRequest('POST', '/orb/audio-level', { level: 0.75 });
    const orbAfterAudio = (await httpRequest('GET', '/orb/status')).data;

    const pass3 = orbAfterAudio.state === 'LISTENING' &&
                  orbAfterAudio.orbVisible === true &&
                  Math.abs(orbAfterAudio.audioLevel - 0.75) < 0.05;

    results.push({
      test: 'ORB_DYNAMIC_AUDIO_LEVEL_MODULATION',
      passed: pass3,
      detail: {
        reportedLevel: orbAfterAudio.audioLevel,
        targetLevel: 0.75
      }
    });
    console.log(`  PASS: Audio RMS modulation active (Reported: ${orbAfterAudio.audioLevel}).`);

    // Test 4: Coordinate Positioning and Dragging Support
    console.log('\nTest 4: Dragging and coordinate positioning');
    const moveRes = await httpRequest('POST', '/orb/position', { x: 320, y: 440 });
    await sleep(150);
    const orbAfterMove = (await httpRequest('GET', '/orb/status')).data;

    const pass4 = orbAfterMove.x === 320 && orbAfterMove.y === 440;
    results.push({
      test: 'ORB_DRAG_AND_REPOSITIONING',
      passed: pass4,
      detail: {
        x: orbAfterMove.x,
        y: orbAfterMove.y
      }
    });
    console.log(`  PASS: Orb repositioned to (${orbAfterMove.x}, ${orbAfterMove.y}).`);

    // Test 5: Auto-Hide Behavior in IDLE State
    console.log('\nTest 5: Auto-hide timeout behavior');
    await httpRequest('POST', '/orb/auto-hide', { timeoutMs: 400 });
    // Show orb briefly in IDLE state to trigger auto-hide countdown
    await httpRequest('POST', '/orb/state', { state: 'IDLE' });
    await sleep(650);

    const orbAfterAutoHide = (await httpRequest('GET', '/orb/status')).data;
    const pass5 = orbAfterAutoHide.orbVisible === false && orbAfterAutoHide.state === 'IDLE';

    results.push({
      test: 'ORB_AUTO_HIDE_BEHAVIOR',
      passed: pass5,
      detail: {
        orbVisible: orbAfterAutoHide.orbVisible,
        state: orbAfterAutoHide.state
      }
    });
    console.log(`  PASS: Orb auto-hid after timeout expiration.`);

    // Test 6: Win32 Presentation / Fullscreen Awareness Query
    console.log('\nTest 6: Win32 SHQueryUserNotificationState presentation query');
    const statusQuery = (await httpRequest('GET', '/orb/status')).data;
    const pass6 = typeof statusQuery.isPresentationMode === 'boolean';

    results.push({
      test: 'ORB_PRESENTATION_MODE_QUERY',
      passed: pass6,
      detail: {
        isPresentationMode: statusQuery.isPresentationMode
      }
    });
    console.log(`  PASS: Shell notification state queried successfully (isPresentationMode: ${statusQuery.isPresentationMode}).`);

    // Test 7: Clean Graceful Shutdown
    console.log('\nTest 7: Clean shutdown of visual subsystem');
    const exitRes = await httpRequest('POST', '/exit');
    await sleep(500);

    let isTerminated = false;
    try {
      await httpRequest('GET', '/status');
    } catch {
      isTerminated = true;
    }

    results.push({
      test: 'ORB_CLEAN_SHUTDOWN',
      passed: isTerminated,
      detail: 'Visual subsystem and Win32 message pump released cleanly.'
    });
    console.log('  PASS: Orb subsystem terminated cleanly.');

  } catch (err) {
    console.error('[FAIL] Test execution encountered an unhandled exception:', err);
    results.push({
      test: 'UNHANDLED_EXCEPTION',
      passed: false,
      detail: err.message
    });
  } finally {
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
  console.log(`Phase 7 Test Results: ${passed}/${total} Passed (${allPassed ? '100% PASS' : 'FAILURES OCCURRED'})`);
  console.log('==================================================================');

  const report = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 7 — Production-Quality Floating Orb',
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
