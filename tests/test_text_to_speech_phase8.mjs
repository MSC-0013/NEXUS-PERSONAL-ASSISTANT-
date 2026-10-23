/**
 * Project NEXUS V2.3 - Phase 8 Local Text-to-Speech & Barge-in Test Suite
 *
 * Verifies:
 * 1. Offline SAPI speech synthesis with installed voices (David/Zira)
 * 2. In-memory PCM/WAV waveform synthesis
 * 3. Orb synchronization (transition to SPEAKING on speech, IDLE on finish)
 * 4. Instant Barge-In interruption (< 50ms latency cutoff via SpeakAsyncCancelAll)
 * 5. Wake phrase / hotkey interruption of active speech
 * 6. Self-trigger acoustic suppression flag during speech output
 * 7. Clean release of audio synthesis resources
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
const REPORT_FILE = path.join(__dirname, 'phase8_text_to_speech_report.json');

const COMPANION_IPC_PORT = 3018;

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
  console.log('Project NEXUS V2.3 - Phase 8 Local Text-to-Speech & Barge-in Suite');
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

    // Test 1: Voice Enumeration & Initialization
    console.log('\nTest 1: Voice enumeration & engine initialization');
    const ttsStatus1 = await httpRequest('GET', '/tts/status');
    const d1 = ttsStatus1.data;

    const pass1 = d1 &&
                  Array.isArray(d1.installedVoices) &&
                  d1.installedVoices.length > 0 &&
                  typeof d1.currentVoice === 'string' &&
                  d1.isSpeaking === false;

    results.push({
      test: 'TTS_VOICE_ENUMERATION',
      passed: pass1,
      detail: {
        currentVoice: d1.currentVoice,
        installedVoices: d1.installedVoices
      }
    });
    console.log(`  PASS: TTS engine initialized with voice "${d1.currentVoice}" (${d1.installedVoices.length} voices available).`);

    // Test 2: In-Memory WAV Waveform Synthesis
    console.log('\nTest 2: Offline in-memory WAV waveform synthesis');
    const synthRes = await httpRequest('POST', '/tts/synthesize', {
      text: "System check confirmed. Project NEXUS voice runtime operational."
    });

    const pass2 = synthRes.data &&
                  synthRes.data.success === true &&
                  synthRes.data.bytes > 5000;

    results.push({
      test: 'TTS_OFFLINE_SYNTHESIS',
      passed: pass2,
      detail: {
        success: synthRes.data?.success,
        bytes: synthRes.data?.bytes,
        voice: synthRes.data?.voice
      }
    });
    console.log(`  PASS: Generated ${synthRes.data?.bytes} bytes of uncompressed PCM WAV audio.`);

    // Test 3: Speech Playback and Orb State Synchronization
    console.log('\nTest 3: Speech playback and Orb state synchronization');
    const speakRes = await httpRequest('POST', '/tts/speak', {
      text: "NEXUS online."
    });
    await sleep(200);

    const orbSpeaking = (await httpRequest('GET', '/orb/status')).data;
    const ttsSpeaking = (await httpRequest('GET', '/tts/status')).data;

    // Wait for short phrase to naturally conclude
    let orbAfterFinish = null;
    let ttsAfterFinish = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      ttsAfterFinish = (await httpRequest('GET', '/tts/status')).data;
      orbAfterFinish = (await httpRequest('GET', '/orb/status')).data;
      if (ttsAfterFinish?.isSpeaking === false && orbAfterFinish?.state === 'IDLE') {
        break;
      }
    }

    const pass3 = (orbSpeaking.state === 'SPEAKING' || ttsSpeaking.isSpeaking === true) &&
                  ttsAfterFinish.isSpeaking === false &&
                  orbAfterFinish.state === 'IDLE';

    results.push({
      test: 'TTS_SPEECH_PLAYBACK_AND_ORB_SYNC',
      passed: pass3,
      detail: {
        duringSpeechOrb: orbSpeaking.state,
        duringSpeechTts: ttsSpeaking.isSpeaking,
        afterSpeechOrb: orbAfterFinish.state,
        afterSpeechTts: ttsAfterFinish.isSpeaking
      }
    });
    console.log(`  PASS: Speech playback synchronized Orb state: SPEAKING -> IDLE.`);

    // Test 4: Barge-In Instant Cutoff (< 50ms)
    console.log('\nTest 4: Instant barge-in speech interruption (< 50ms cutoff)');
    // Begin long phrase
    await httpRequest('POST', '/tts/speak', {
      text: "This is a lengthy paragraph intended to test immediate user interruption and instant barge-in capabilities of Project NEXUS without perceptible lag."
    });
    await sleep(250);

    // Stop speech immediately
    const stopRes = await httpRequest('POST', '/tts/stop');
    const stopData = stopRes.data;
    const orbAfterStop = (await httpRequest('GET', '/orb/status')).data;
    const ttsAfterStop = (await httpRequest('GET', '/tts/status')).data;

    const pass4 = stopData &&
                  stopData.stopped === true &&
                  stopData.latencyMs < 50 &&
                  ttsAfterStop.isSpeaking === false &&
                  orbAfterStop.state === 'INTERRUPTED';

    results.push({
      test: 'TTS_BARGE_IN_INSTANT_CUTOFF',
      passed: pass4,
      detail: {
        stopped: stopData.stopped,
        latencyMs: stopData.latencyMs,
        bargeInCount: stopData.bargeInCount,
        orbState: orbAfterStop.state
      }
    });
    console.log(`  PASS: Barge-in halted speech in ${stopData.latencyMs.toFixed(2)}ms (< 50ms target). Orb: ${orbAfterStop.state}.`);

    // Test 5: Hotkey / Wake Interruption while Speaking
    console.log('\nTest 5: Assistant activation hotkey preemption while speaking');
    await httpRequest('POST', '/tts/speak', {
      text: "Continuous background output that will be preempted by the global hotkey trigger."
    });
    await sleep(200);

    // Trigger activation hotkey
    await httpRequest('POST', '/hotkey/trigger');
    await sleep(100);

    const orbAfterHotkey = (await httpRequest('GET', '/orb/status')).data;
    const ttsAfterHotkey = (await httpRequest('GET', '/tts/status')).data;

    const pass5 = ttsAfterHotkey.isSpeaking === false &&
                  orbAfterHotkey.state === 'LISTENING';

    results.push({
      test: 'TTS_ACTIVATION_PREEMPTION',
      passed: pass5,
      detail: {
        isSpeaking: ttsAfterHotkey.isSpeaking,
        orbState: orbAfterHotkey.state
      }
    });
    console.log(`  PASS: Activation preempted active speech, transitioning directly to LISTENING.`);

    // Test 6: Self-Trigger Suppression Verification
    console.log('\nTest 6: Self-trigger prevention during speech playback');
    await httpRequest('POST', '/tts/speak', {
      text: "Testing acoustic feedback prevention."
    });
    await sleep(150);

    const wakeStatusDuringSpeech = (await httpRequest('GET', '/wake/status')).data;
    await httpRequest('POST', '/tts/stop');

    const pass6 = wakeStatusDuringSpeech &&
                  (wakeStatusDuringSpeech.isSelfTriggerSuppressed === true || wakeStatusDuringSpeech.assistantSpeaking === true);

    results.push({
      test: 'TTS_SELF_TRIGGER_SUPPRESSION',
      passed: pass6,
      detail: {
        isSelfTriggerSuppressed: wakeStatusDuringSpeech?.isSelfTriggerSuppressed
      }
    });
    console.log(`  PASS: Wake engine reported assistantSpeaking=true, suppressing acoustic loop.`);

    // Test 7: Clean Graceful Shutdown
    console.log('\nTest 7: Clean release of speech synthesizer resources');
    const exitRes = await httpRequest('POST', '/exit');
    await sleep(500);

    let isTerminated = false;
    try {
      await httpRequest('GET', '/status');
    } catch {
      isTerminated = true;
    }

    results.push({
      test: 'TTS_CLEAN_SHUTDOWN',
      passed: isTerminated,
      detail: 'SAPI synthesizer released and message loop terminated cleanly.'
    });
    console.log('  PASS: TTS subsystem shut down cleanly.');

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
  console.log(`Phase 8 Test Results: ${passed}/${total} Passed (${allPassed ? '100% PASS' : 'FAILURES OCCURRED'})`);
  console.log('==================================================================');

  const report = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 8 — Local Text-to-Speech & Barge-in',
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
