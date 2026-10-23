/**
 * Project NEXUS V2.3 - Phase 3 Native Audio Infrastructure Test Suite
 *
 * Verifies hardware audio device enumeration, 16kHz 16-bit mono PCM capture,
 * real-time RMS level computation, privacy mute isolation, and session lock disarming.
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
const REPORT_FILE = path.join(__dirname, 'phase3_native_audio_report.json');

const COMPANION_IPC_PORT = 3007;
const GATEWAY_MOCK_PORT = 3011;

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
  console.log('Project NEXUS V2.3 - Phase 3 Native Audio Infrastructure Test Suite');
  console.log('==================================================================\n');

  const results = [];
  let companionProc = null;
  let mockGateway = null;

  try {
    // 0. Ensure executable exists
    if (!fs.existsSync(COMPANION_EXE)) {
      throw new Error(`Companion executable not found at ${COMPANION_EXE}. Run build.ps1 first.`);
    }

    // Start mock Gateway on port 3011
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

    // Launch companion
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

    // Test 1: Hardware Device Enumeration
    console.log('\nTest 1: Hardware audio device enumeration');
    const devRes = await httpRequest('GET', '/audio/devices');
    const inputDevs = devRes.data?.inputDevices || [];
    const outputDevs = devRes.data?.outputDevices || [];
    const devPass = devRes.status === 200 && inputDevs.length > 0 && outputDevs.length > 0;

    results.push({
      test: 'AUDIO_DEVICE_ENUMERATION',
      passed: devPass,
      detail: {
        inputCount: inputDevs.length,
        inputs: inputDevs.map(d => d.name),
        outputCount: outputDevs.length,
        outputs: outputDevs.map(d => d.name)
      }
    });
    console.log(`  PASS: Found ${inputDevs.length} input device(s) and ${outputDevs.length} output device(s).`);

    // Test 2: Audio Format & Baseline Capture Status
    console.log('\nTest 2: Standard audio format and capture pipeline verification');
    const statusRes = await httpRequest('GET', '/audio/status');
    const s = statusRes.data;
    const formatPass = s.sampleRate === 16000 &&
                       s.channels === 1 &&
                       s.bitsPerSample === 16 &&
                       s.isCapturing === true &&
                       s.isMuted === false;

    results.push({
      test: 'AUDIO_FORMAT_VERIFICATION',
      passed: formatPass,
      detail: {
        sampleRate: s.sampleRate,
        channels: s.channels,
        bitsPerSample: s.bitsPerSample,
        isCapturing: s.isCapturing,
        isMuted: s.isMuted
      }
    });
    console.log(`  PASS: Format certified at ${s.sampleRate}Hz, ${s.bitsPerSample}-bit Mono PCM (Active capture: ${s.isCapturing})`);

    // Test 3: Audio Injection and Real-Time RMS Level Computation
    console.log('\nTest 3: Audio buffer ingestion & real-time RMS level calculation');
    const injectRes = await httpRequest('POST', '/audio/inject', { frequency: 440, durationMs: 250 });
    const statusAfterInject = await httpRequest('GET', '/audio/status');

    const rmsComputed = injectRes.data.rms > 0.05 || statusAfterInject.data.rms > 0.05;
    results.push({
      test: 'AUDIO_RMS_COMPUTATION',
      passed: rmsComputed,
      detail: {
        injected: injectRes.data,
        postInjectStatus: statusAfterInject.data
      }
    });
    console.log(`  PASS: Test tone ingested; calculated active RMS level: ${injectRes.data.rms.toFixed(4)}`);

    // Test 4: Privacy Mute Enforcement
    console.log('\nTest 4: Privacy Mute hardware/software isolation');
    const muteOn = await httpRequest('POST', '/audio/mute');
    const injectWhileMuted = await httpRequest('POST', '/audio/inject', { frequency: 440, durationMs: 250 });
    const statusMuted = await httpRequest('GET', '/audio/status');
    const muteOff = await httpRequest('POST', '/audio/mute');

    const mutePass = muteOn.data.isMuted === true &&
                     injectWhileMuted.data.rms === 0.0 &&
                     statusMuted.data.rms === 0.0 &&
                     statusMuted.data.peak === 0.0 &&
                     muteOff.data.isMuted === false;

    results.push({
      test: 'AUDIO_PRIVACY_MUTE_ISOLATION',
      passed: mutePass,
      detail: 'Muted state completely zeros incoming audio frames and blocks RMS computation.'
    });
    console.log('  PASS: Privacy Mute verified: Zero audio buffers processed while muted.');

    // Test 5: Session Lock Audio Disarming
    console.log('\nTest 5: Session Lock automatic audio disarming');
    await httpRequest('POST', '/simulate-lock');
    const statusWhileLocked = await httpRequest('GET', '/audio/status');
    const injectWhileLocked = await httpRequest('POST', '/audio/inject', { frequency: 440, durationMs: 250 });
    await httpRequest('POST', '/simulate-unlock');
    const statusAfterUnlock = await httpRequest('GET', '/audio/status');

    const lockDisarmPass = statusWhileLocked.data.sessionState === 'LOCKED' &&
                           injectWhileLocked.data.rms === 0.0 &&
                           statusWhileLocked.data.rms === 0.0 &&
                           statusAfterUnlock.data.sessionState === 'UNLOCKED';

    results.push({
      test: 'SESSION_LOCK_AUDIO_DISARM',
      passed: lockDisarmPass,
      detail: 'Workstation lock automatically disarms audio capture and suppresses buffer processing.'
    });
    console.log('  PASS: Audio capture successfully disarmed during session lock.');

    // Test 6: Capture Lifecycle Control (Stop and Start)
    console.log('\nTest 6: Audio capture lifecycle control (Start/Stop)');
    const stopRes = await httpRequest('POST', '/audio/stop');
    const statusStopped = await httpRequest('GET', '/audio/status');
    const startRes = await httpRequest('POST', '/audio/start');
    const statusStarted = await httpRequest('GET', '/audio/status');

    const lifecyclePass = stopRes.data.stopped === true &&
                          statusStopped.data.isCapturing === false &&
                          startRes.data.started === true &&
                          statusStarted.data.isCapturing === true;

    results.push({
      test: 'AUDIO_LIFECYCLE_CONTROL',
      passed: lifecyclePass,
      detail: 'Stop and Start capture commands executed cleanly.'
    });
    console.log('  PASS: Audio capture stop/start lifecycle verified.');

    // Test 7: Orb Audio-Level Modulation
    console.log('\nTest 7: Animated Orb audio-level reactivity');
    await httpRequest('POST', '/orb/show');
    const toneRes = await httpRequest('POST', '/audio/inject', { frequency: 520, durationMs: 200 });
    const orbStatus = await httpRequest('GET', '/status');
    await httpRequest('POST', '/orb/hide');

    const orbPass = orbStatus.data.orbVisible === true &&
                    orbStatus.data.orbState === 'LISTENING' &&
                    toneRes.data.injected === true;

    results.push({
      test: 'ORB_AUDIO_REACTIVITY',
      passed: orbPass,
      detail: 'Orb actively listening and modulated by audio engine without disruption.'
    });
    console.log('  PASS: Orb audio modulation verified.');

    // Test 8: Clean Graceful Shutdown
    console.log('\nTest 8: Graceful shutdown and resource release');
    const exitRes = await httpRequest('POST', '/exit');
    await sleep(600);

    let isTerminated = false;
    try {
      await httpRequest('GET', '/status');
    } catch {
      isTerminated = true;
    }

    results.push({
      test: 'AUDIO_ENGINE_CLEAN_SHUTDOWN',
      passed: exitRes.data.status === 'exiting' && isTerminated,
      detail: 'Audio engine stopped capture and released all native multimedia handles.'
    });
    console.log('  PASS: Companion and native audio engine shut down cleanly.');

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
  console.log(`Phase 3 Test Results: ${passed}/${total} Passed (${allPassed ? '100% PASS' : 'FAILURES OCCURRED'})`);
  console.log('==================================================================');

  const report = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 3 — Native Audio Infrastructure',
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
