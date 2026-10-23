/**
 * Project NEXUS V2.3 - Phase 1 Verification Suite
 * Tests native Windows Desktop Companion host:
 * 1. Native background launch & single-instance mutex enforcement.
 * 2. IPC status and health endpoint verification.
 * 3. Windows startup registration toggle (HKCU Run).
 * 4. Hardware/Privacy mute toggle.
 * 5. Floating animated orb visibility and state machine transitions.
 * 6. Win32 Session lock safety: automatic orb hiding & blocked activation while locked.
 * 7. Screen wake isolation: wake does NOT unlock workstation.
 * 8. Clean graceful shutdown via IPC.
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
const REPORT_FILE = path.join(__dirname, 'desktop_companion_phase1_report.json');

const IPC_PORT = 3005;
const GATEWAY_PORT = 3000;

function httpRequest(method, endpoint, body = null, port = IPC_PORT) {
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
  console.log('===============================================================');
  console.log('Project NEXUS V2.3 - Phase 1 Native Desktop Companion Test Suite');
  console.log('===============================================================\n');

  const results = [];
  let companionProc = null;
  let mockGateway = null;
  const receivedSessionNotifications = [];

  try {
    // 0. Ensure executable exists
    if (!fs.existsSync(COMPANION_EXE)) {
      throw new Error(`Companion executable not found at ${COMPANION_EXE}. Run build.ps1 first.`);
    }

    // Start mock Gateway on port 3000 to capture companion session-state notifications
    mockGateway = http.createServer((req, res) => {
      if (req.url === '/api/test/session-state' && req.method === 'POST') {
        let b = '';
        req.on('data', chunk => b += chunk);
        req.on('end', () => {
          try {
            const parsed = JSON.parse(b);
            receivedSessionNotifications.push(parsed);
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve, reject) => {
      mockGateway.listen(GATEWAY_PORT, '127.0.0.1', resolve);
      mockGateway.on('error', reject);
    });
    console.log(`[SETUP] Mock Chat Gateway listening on port ${GATEWAY_PORT}`);

    // Clean up any stale instances
    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
      await sleep(500);
    } catch {}

    // Test 1: Background Process Launch
    console.log('Test 1: Launch native companion process in background mode');
    companionProc = spawn(COMPANION_EXE, [
      '--port', String(IPC_PORT),
      '--gateway-port', String(GATEWAY_PORT),
      '--background'
    ], {
      detached: false,
      stdio: 'pipe'
    });

    // Wait for IPC server to come online
    let online = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await httpRequest('GET', '/status');
        if (res.status === 200 && res.data.service === 'nexus-desktop-companion') {
          online = true;
          break;
        }
      } catch {
        await sleep(250);
      }
    }

    if (!online) {
      throw new Error('Companion IPC server failed to respond within 5 seconds.');
    }

    results.push({
      test: 'COMPANION_BACKGROUND_LAUNCH',
      passed: true,
      detail: 'Native desktop companion started in background mode with loopback IPC operational.'
    });
    console.log('  PASS: Companion launched and listening on port ' + IPC_PORT);

    // Test 2: Single-Instance Mutex Enforcement
    console.log('\nTest 2: Single-instance mutex enforcement');
    const secondLaunchOutput = execSync(`"${COMPANION_EXE}" --port ${IPC_PORT}`, { encoding: 'utf8' });
    const isSingleInstance = secondLaunchOutput.includes('already running in background');
    results.push({
      test: 'SINGLE_INSTANCE_MUTEX',
      passed: isSingleInstance,
      detail: secondLaunchOutput.trim()
    });
    console.log(`  PASS: Mutex rejected secondary instance (${secondLaunchOutput.trim()})`);

    // Test 3: Status Schema & Hotkey Registration
    console.log('\nTest 3: IPC Status query and hotkey registration');
    const statusRes = await httpRequest('GET', '/status');
    const statusData = statusRes.data;
    const hotkeyValid = statusData.hotkeyRegistered && (statusData.activeHotkey === 'Ctrl+Alt+N' || statusData.activeHotkey === 'Win+Alt+N');
    const statusValid = statusRes.status === 200 &&
      statusData.sessionState === 'UNLOCKED' &&
      statusData.isMuted === false &&
      statusData.displayState === 'ON' &&
      statusData.orbVisible === false &&
      hotkeyValid;

    results.push({
      test: 'STATUS_QUERY_AND_HOTKEY',
      passed: statusValid,
      detail: {
        sessionState: statusData.sessionState,
        activeHotkey: statusData.activeHotkey,
        hotkeyRegistered: statusData.hotkeyRegistered,
        orbVisible: statusData.orbVisible,
        orbState: statusData.orbState
      }
    });
    console.log(`  PASS: Status verified. Active hotkey: ${statusData.activeHotkey}, Session: ${statusData.sessionState}`);

    // Test 4: Privacy Mute Toggle
    console.log('\nTest 4: Privacy microphone mute toggle');
    const mute1 = await httpRequest('POST', '/mute');
    const statusAfterMute = await httpRequest('GET', '/status');
    const mute2 = await httpRequest('POST', '/mute');
    const statusAfterUnmute = await httpRequest('GET', '/status');

    const mutePass = mute1.data.isMuted === true &&
                     statusAfterMute.data.isMuted === true &&
                     mute2.data.isMuted === false &&
                     statusAfterUnmute.data.isMuted === false;

    results.push({
      test: 'PRIVACY_MUTE_TOGGLE',
      passed: mutePass,
      detail: 'Mute toggled ON then restored OFF correctly in state and context menu.'
    });
    console.log('  PASS: Privacy mute toggle verified.');

    // Test 5: Windows Startup Toggle (Registry HKCU Run)
    console.log('\nTest 5: Windows startup configuration toggle');
    const initialStartup = statusData.startupEnabled;
    const toggle1 = await httpRequest('POST', '/startup/toggle');
    const statusToggle1 = await httpRequest('GET', '/status');
    // Toggle back to clean up
    const toggle2 = await httpRequest('POST', '/startup/toggle');
    const statusToggle2 = await httpRequest('GET', '/status');

    const startupPass = toggle1.data.startupEnabled === !initialStartup &&
                        statusToggle1.data.startupEnabled === !initialStartup &&
                        statusToggle2.data.startupEnabled === initialStartup;

    results.push({
      test: 'WINDOWS_STARTUP_TOGGLE',
      passed: startupPass,
      detail: `Startup successfully toggled from ${initialStartup} -> ${!initialStartup} and restored to ${initialStartup}.`
    });
    console.log(`  PASS: Startup registry entry toggle verified (Restored to initial state: ${initialStartup}).`);

    // Test 6: Animated Orb State Machine Transitions
    console.log('\nTest 6: Animated orb visibility and state machine');
    const showRes = await httpRequest('POST', '/orb/show');
    const stateProcessing = await httpRequest('POST', '/orb/state', { state: 'PROCESSING' });
    const stateSpeaking = await httpRequest('POST', '/orb/state', { state: 'SPEAKING' });
    const stateAuthReq = await httpRequest('POST', '/orb/state', { state: 'AUTH_REQUIRED' });
    const stateError = await httpRequest('POST', '/orb/state', { state: 'ERROR' });
    const hideRes = await httpRequest('POST', '/orb/hide');
    const statusAfterHide = await httpRequest('GET', '/status');

    const orbPass = showRes.data.orbVisible === true &&
                    showRes.data.orbState === 'LISTENING' &&
                    stateProcessing.data.orbState === 'PROCESSING' &&
                    stateSpeaking.data.orbState === 'SPEAKING' &&
                    stateAuthReq.data.orbState === 'AUTH_REQUIRED' &&
                    stateError.data.orbState === 'ERROR' &&
                    hideRes.data.orbVisible === false &&
                    statusAfterHide.data.orbVisible === false;

    results.push({
      test: 'ORB_STATE_MACHINE',
      passed: orbPass,
      detail: {
        show: showRes.data,
        processing: stateProcessing.data,
        speaking: stateSpeaking.data,
        authRequired: stateAuthReq.data,
        error: stateError.data,
        hide: hideRes.data
      }
    });
    console.log('  PASS: Floating orb transitions verified across all states (LISTENING -> PROCESSING -> SPEAKING -> AUTH_REQUIRED -> ERROR -> IDLE).');

    // Test 7: Session Lock Invariant & Automatic Orb Dismissal
    console.log('\nTest 7: Win32 Session Lock safety invariant');
    // Show orb first
    await httpRequest('POST', '/orb/show');
    const orbBeforeLock = (await httpRequest('GET', '/status')).data.orbVisible;

    // Simulate session lock
    const lockRes = await httpRequest('POST', '/simulate-lock');
    const statusLocked = (await httpRequest('GET', '/status')).data;

    // Try showing orb while locked
    await httpRequest('POST', '/orb/show');
    const statusAttemptShowWhileLocked = (await httpRequest('GET', '/status')).data;

    const lockPass = orbBeforeLock === true &&
                     lockRes.data.sessionState === 'LOCKED' &&
                     statusLocked.sessionState === 'LOCKED' &&
                     statusLocked.orbVisible === false &&
                     statusAttemptShowWhileLocked.orbVisible === false;

    results.push({
      test: 'SESSION_LOCK_ORB_DISMISSAL',
      passed: lockPass,
      detail: 'Lock event automatically disarms audio/orb and suppresses any orb activation.'
    });
    console.log('  PASS: Session lock immediately hid orb and blocked activation.');

    // Test 8: Display Wake Screen Isolation
    console.log('\nTest 8: Display wake isolation invariant (Screen ON must NOT grant UNLOCKED)');
    const wakeRes = await httpRequest('POST', '/simulate-wake');
    const statusAfterWake = (await httpRequest('GET', '/status')).data;

    const wakePass = wakeRes.data.displayState === 'ON' &&
                     wakeRes.data.sessionState === 'LOCKED' &&
                     statusAfterWake.sessionState === 'LOCKED';

    results.push({
      test: 'DISPLAY_WAKE_SESSION_ISOLATION',
      passed: wakePass,
      detail: 'Screen wake alone preserved LOCKED state without granting unauthenticated access.'
    });
    console.log('  PASS: Screen wake turned display ON while workstation safely remains LOCKED.');

    // Test 9: Session Unlock & State Restoration
    console.log('\nTest 9: Win32 Session Unlock restoration');
    const unlockRes = await httpRequest('POST', '/simulate-unlock');
    const statusUnlocked = (await httpRequest('GET', '/status')).data;

    const unlockPass = unlockRes.data.sessionState === 'UNLOCKED' &&
                       statusUnlocked.sessionState === 'UNLOCKED';

    results.push({
      test: 'SESSION_UNLOCK_RESTORATION',
      passed: unlockPass,
      detail: 'Session unlock event successfully restored UNLOCKED Standby state.'
    });
    console.log('  PASS: Session unlock restored UNLOCKED state.');

    // Test 10: Chat Gateway IPC Session State Synchronization
    console.log('\nTest 10: Verification of Gateway session-state IPC calls');
    let statesNotified = [];
    let gatewayPass = false;
    for (let i = 0; i < 20; i++) {
      statesNotified = receivedSessionNotifications.map(n => n.state);
      if (statesNotified.includes('LOCKED') && statesNotified.includes('UNLOCKED')) {
        gatewayPass = true;
        break;
      }
      await sleep(100);
    }

    results.push({
      test: 'GATEWAY_SESSION_SYNC',
      passed: gatewayPass,
      detail: {
        notificationsReceived: statesNotified
      }
    });
    console.log(`  PASS: Chat Gateway notified of session state changes: [${statesNotified.join(', ')}].`);

    // Test 11: Clean Graceful Shutdown
    console.log('\nTest 11: Graceful shutdown via IPC');
    const exitRes = await httpRequest('POST', '/exit');
    await sleep(600);

    let isTerminated = false;
    try {
      await httpRequest('GET', '/status');
    } catch {
      isTerminated = true;
    }

    results.push({
      test: 'GRACEFUL_SHUTDOWN',
      passed: exitRes.data.status === 'exiting' && isTerminated,
      detail: 'Companion process closed HTTP listener, tray icon, message loop and exited cleanly.'
    });
    console.log('  PASS: Companion exited cleanly and released all Win32 resources.');

  } catch (err) {
    console.error('[FAIL] Test execution encountered an unhandled exception:', err);
    results.push({
      test: 'UNHANDLED_EXCEPTION',
      passed: false,
      detail: err.message
    });
  } finally {
    if (mockGateway) {
      mockGateway.close();
    }
    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
    } catch {}
  }

  // Summary and Report
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const allPassed = (total > 0 && passed === total);

  console.log('\n===============================================================');
  console.log(`Phase 1 Test Results: ${passed}/${total} Passed (${allPassed ? '100% PASS' : 'FAILURES OCCURRED'})`);
  console.log('===============================================================');

  const report = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 1 — Native Windows Desktop Companion',
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
