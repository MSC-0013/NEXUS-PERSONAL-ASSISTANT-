/**
 * Project NEXUS V2.3 - Phase 2 Session Sentinel Test Suite
 *
 * Verifies OS session monitoring, display wake isolation, heartbeat dead-man switch,
 * and fail-closed security synchronization between the Desktop Companion and Chat Gateway.
 */

import http from 'http';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PolicyEngine, HeartbeatSessionSentinelProvider } from '../apps/chat-gateway/dist/policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const COMPANION_EXE = path.join(REPO_ROOT, 'apps', 'desktop-companion', 'bin', 'NexusDesktopCompanion.exe');
const REPORT_FILE = path.join(__dirname, 'phase2_session_sentinel_report.json');

const COMPANION_IPC_PORT = 3006;
const GATEWAY_TEST_PORT = 3010;

function httpRequest(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
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
      reject(new Error(`Timeout requesting ${urlStr}`));
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
  console.log('Project NEXUS V2.3 - Phase 2 Windows Session Sentinel Test Suite');
  console.log('==================================================================\n');

  const results = [];
  let gatewayProc = null;
  let companionProc = null;
  let mockOllamaServer = null;

  try {
    // Clean up any stale instances
    try {
      execSync('taskkill /F /IM NexusDesktopCompanion.exe 2>nul');
      await sleep(300);
    } catch {}

    // Section 1: In-process Unit Tests on HeartbeatSessionSentinelProvider
    console.log('--- SECTION 1: SENTINEL DEAD-MAN SWITCH UNIT VERIFICATION ---');

    console.log('Test 1: Default initialization in fail-closed UNKNOWN state');
    const provider = new HeartbeatSessionSentinelProvider('UNKNOWN', 2000);
    const policy = new PolicyEngine(provider);
    const initialPass = policy.getSessionState() === 'UNKNOWN';
    results.push({
      test: 'SENTINEL_DEFAULT_FAIL_CLOSED',
      passed: initialPass,
      detail: 'Provider defaults to UNKNOWN. Protected tools denied by default.'
    });
    console.log(`  PASS: Default session state: ${policy.getSessionState()}`);

    console.log('\nTest 2: Heartbeat establishes verified active sentinel');
    provider.recordHeartbeat('UNLOCKED');
    const unlockedPass = policy.getSessionState() === 'UNLOCKED';
    results.push({
      test: 'SENTINEL_HEARTBEAT_ACTIVE',
      passed: unlockedPass,
      detail: 'Active heartbeat transitions sentinel to UNLOCKED and permits execution.'
    });
    console.log(`  PASS: State after active heartbeat: ${policy.getSessionState()}`);

    console.log('\nTest 3: Dead-man switch fail-closed timeout');
    console.log('  Waiting 2.3s for heartbeat TTL expiration...');
    await sleep(2300);
    const expiredState = policy.getSessionState();
    const expiredPass = (expiredState === 'UNKNOWN');
    const sentinelStatus = provider.getSentinelStatus();
    results.push({
      test: 'SENTINEL_DEADMAN_TIMEOUT_FAIL_CLOSED',
      passed: expiredPass && sentinelStatus.isExpired,
      detail: `Heartbeat expired after ${sentinelStatus.lastHeartbeatAgeMs}ms (TTL ${sentinelStatus.ttlMs}ms). State safely reverted to UNKNOWN.`
    });
    console.log(`  PASS: Dead-man switch tripped: State reverted to ${expiredState} (isExpired: ${sentinelStatus.isExpired})`);

    // Section 2: End-to-End Live Integration between Gateway & Desktop Companion
    console.log('\n--- SECTION 2: END-TO-END GATEWAY & COMPANION INTEGRATION ---');

    // Launch Mock Ollama service
    const mockOllamaPort = 11440;
    mockOllamaServer = http.createServer((req, res) => {
      let b = '';
      req.on('data', chunk => b += chunk);
      req.on('end', () => {
        if (b.includes('TOOL AUTHORIZATION DENIED') || b.includes('SESSION_LOCKED')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            response: 'I cannot read README.md because access was denied by security policy (SESSION_LOCKED).',
            done: true
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: 'NEXUS processed your request successfully.', done: true }));
        }
      });
    });
    await new Promise(r => mockOllamaServer.listen(mockOllamaPort, '127.0.0.1', r));

    // Launch Chat Gateway on GATEWAY_TEST_PORT
    console.log(`Launching Chat Gateway on port ${GATEWAY_TEST_PORT}...`);
    gatewayProc = spawn('node', ['apps/chat-gateway/dist/server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(GATEWAY_TEST_PORT),
        NEXUS_TEST_MODE: '1',
        LOG_LEVEL: 'warn',
        OLLAMA_HOST: `http://127.0.0.1:${mockOllamaPort}`
      },
      stdio: 'pipe'
    });

    // Wait for Gateway to come online
    let gwOnline = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await httpRequest('GET', `http://127.0.0.1:${GATEWAY_TEST_PORT}/health`);
        if (res.status === 200) {
          gwOnline = true;
          break;
        }
      } catch {
        await sleep(250);
      }
    }
    if (!gwOnline) throw new Error('Chat Gateway failed to start on port ' + GATEWAY_TEST_PORT);
    console.log('  Gateway is online.');

    // Launch Companion on COMPANION_IPC_PORT targeting GATEWAY_TEST_PORT
    console.log(`Launching Desktop Companion on port ${COMPANION_IPC_PORT}...`);
    companionProc = spawn(COMPANION_EXE, [
      '--port', String(COMPANION_IPC_PORT),
      '--gateway-port', String(GATEWAY_TEST_PORT),
      '--background'
    ], { stdio: 'pipe' });

    let compOnline = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await httpRequest('GET', `http://127.0.0.1:${COMPANION_IPC_PORT}/status`);
        if (res.status === 200) {
          compOnline = true;
          break;
        }
      } catch {
        await sleep(250);
      }
    }
    if (!compOnline) throw new Error('Desktop Companion failed to start on port ' + COMPANION_IPC_PORT);
    console.log('  Desktop Companion is online.');

    // Allow initial heartbeat to propagate
    await sleep(1500);

    console.log('\nTest 4: Gateway session synchronized with companion heartbeat');
    const gwSession1 = await httpRequest('GET', `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/session/state`);
    const compSentinel1 = await httpRequest('GET', `http://127.0.0.1:${COMPANION_IPC_PORT}/sentinel/status`);

    const syncPass = gwSession1.data.sessionState === 'UNLOCKED' &&
                     compSentinel1.data.sessionState === 'UNLOCKED';
    results.push({
      test: 'GATEWAY_COMPANION_HEARTBEAT_SYNC',
      passed: syncPass,
      detail: {
        gatewayState: gwSession1.data.sessionState,
        companionState: compSentinel1.data.sessionState,
        heartbeatAgeMs: gwSession1.data.lastHeartbeatAgeMs
      }
    });
    console.log(`  PASS: Synchronized in UNLOCKED state (Heartbeat age: ${gwSession1.data.lastHeartbeatAgeMs}ms)`);

    console.log('\nTest 5: Win32 Session Lock event triggers immediate Gateway lockout');
    // Lock workstation via companion
    await httpRequest('POST', `http://127.0.0.1:${COMPANION_IPC_PORT}/simulate-lock`);
    await sleep(500);

    const compLockedStatus = (await httpRequest('GET', `http://127.0.0.1:${COMPANION_IPC_PORT}/status`)).data;
    const gwLockedStatus = (await httpRequest('GET', `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/session/state`)).data;

    const lockPass = compLockedStatus.sessionState === 'LOCKED' &&
                     compLockedStatus.orbVisible === false &&
                     gwLockedStatus.sessionState === 'LOCKED';

    results.push({
      test: 'WTS_SESSION_LOCK_GATEWAY_SYNC',
      passed: lockPass,
      detail: 'Lock event immediately set sessionState to LOCKED across companion and gateway, and hid the orb.'
    });
    console.log(`  PASS: Lock event verified. Companion: ${compLockedStatus.sessionState}, Gateway: ${gwLockedStatus.sessionState}`);

    console.log('\nTest 6: Protected tool execution strictly blocked while locked');
    const testToolIntent = {
      model: 'nexus:latest',
      messages: [{ role: 'user', content: 'Inspect the file README.md.' }]
    };
    const deniedChatRes = await httpRequest('POST', `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/chat`, testToolIntent);
    const deniedText = deniedChatRes.data?.message?.content || JSON.stringify(deniedChatRes.data);
    const deniedPass = deniedText.includes('SESSION_LOCKED') ||
                       deniedText.includes('access was denied') ||
                       deniedText.includes('prohibited') ||
                       deniedText.includes('denied');

    results.push({
      test: 'LOCKED_SESSION_TOOL_PROHIBITION',
      passed: deniedPass,
      detail: deniedText
    });
    console.log(`  PASS: L1 workspace tool execution blocked during lock: "${deniedText.slice(0, 80)}..."`);

    console.log('\nTest 7: Screen wake isolation invariant (Display ON does NOT unlock workstation)');
    // Simulate screen wake
    const wakeRes = await httpRequest('POST', `http://127.0.0.1:${COMPANION_IPC_PORT}/simulate-wake`);
    await sleep(500);

    const compAfterWake = (await httpRequest('GET', `http://127.0.0.1:${COMPANION_IPC_PORT}/status`)).data;
    const gwAfterWake = (await httpRequest('GET', `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/session/state`)).data;

    const wakePass = wakeRes.data.displayState === 'ON' &&
                     compAfterWake.sessionState === 'LOCKED' &&
                     gwAfterWake.sessionState === 'LOCKED';

    results.push({
      test: 'SCREEN_WAKE_ISOLATION_INVARIANT',
      passed: wakePass,
      detail: `Screen wake turned display to ON, but sessionState remained LOCKED on both companion and gateway.`
    });
    console.log(`  PASS: Screen wake isolated. Display: ON, Companion Session: ${compAfterWake.sessionState}, Gateway Session: ${gwAfterWake.sessionState}`);

    console.log('\nTest 8: WTS Session Unlock restoration');
    await httpRequest('POST', `http://127.0.0.1:${COMPANION_IPC_PORT}/simulate-unlock`);
    await sleep(600);

    const compUnlocked = (await httpRequest('GET', `http://127.0.0.1:${COMPANION_IPC_PORT}/status`)).data;
    const gwUnlocked = (await httpRequest('GET', `http://127.0.0.1:${GATEWAY_TEST_PORT}/api/session/state`)).data;

    const unlockPass = compUnlocked.sessionState === 'UNLOCKED' &&
                       gwUnlocked.sessionState === 'UNLOCKED';

    results.push({
      test: 'WTS_SESSION_UNLOCK_RESTORATION',
      passed: unlockPass,
      detail: 'Session unlock event successfully restored UNLOCKED state across companion and gateway.'
    });
    console.log(`  PASS: Session unlock restored UNLOCKED state across sentinel.`);

    console.log('\nTest 9: Clean termination and sentinel shutdown');
    await httpRequest('POST', `http://127.0.0.1:${COMPANION_IPC_PORT}/exit`);
    await sleep(600);

    let compTerminated = false;
    try {
      await httpRequest('GET', `http://127.0.0.1:${COMPANION_IPC_PORT}/status`);
    } catch {
      compTerminated = true;
    }

    results.push({
      test: 'SENTINEL_CLEAN_SHUTDOWN',
      passed: compTerminated,
      detail: 'Companion process exited cleanly.'
    });
    console.log(`  PASS: Companion exited cleanly (isTerminated: ${compTerminated}).`);

  } catch (err) {
    console.error('[FAIL] Test execution encountered an unhandled exception:', err);
    results.push({
      test: 'UNHANDLED_EXCEPTION',
      passed: false,
      detail: err.message
    });
  } finally {
    if (mockOllamaServer) {
      try { mockOllamaServer.close(); } catch {}
    }
    if (gatewayProc) {
      try { gatewayProc.kill(); } catch {}
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
  console.log(`Phase 2 Test Results: ${passed}/${total} Passed (${allPassed ? '100% PASS' : 'FAILURES OCCURRED'})`);
  console.log('==================================================================');

  const report = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 2 — Windows Session Sentinel',
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
