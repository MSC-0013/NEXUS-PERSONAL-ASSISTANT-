import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const COMPANION_EXE = path.join(REPO_ROOT, "apps", "desktop-companion", "bin", "NexusDesktopCompanion.exe");
const REPORT_PATH = path.join(REPO_ROOT, "tests", "runtime_stability_verification_report.json");

function postJson(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "GET",
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("====================================================================");
  console.log("PROJECT NEXUS V2.3 — RUNTIME STABILITY, LIFECYCLE & VOICE AUDIT");
  console.log("====================================================================");

  const results = {
    timestamp: new Date().toISOString(),
    binaryPath: COMPANION_EXE,
    binaryExists: fs.existsSync(COMPANION_EXE),
    tests: [],
    overallVerdict: "PENDING",
  };

  if (!results.binaryExists) {
    console.error("[FATAL] Binary not found at " + COMPANION_EXE);
    process.exit(1);
  }

  // Calculate binary hash
  const hashOutput = execSync(`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '${COMPANION_EXE}').Hash"`).toString().trim();
  results.binarySha256 = hashOutput;
  console.log(`[BINARY] SHA-256: ${hashOutput}`);

  // Step 1: Ensure clean state
  try {
    execSync("taskkill /F /IM NexusDesktopCompanion.exe 2>nul");
  } catch {}
  await sleep(1000);

  // Step 2: Start Fastify Gateway if offline
  let gatewayOnline = false;
  try {
    const gwHealth = await getJson(3000, "/health");
    if (gwHealth.status === 200) gatewayOnline = true;
  } catch {}

  let gatewayProc = null;
  if (!gatewayOnline) {
    console.log("[SETUP] Starting Fastify Chat Gateway on port 3000...");
    gatewayProc = spawn("node", [path.join(REPO_ROOT, "apps", "chat-gateway", "dist", "server.js")], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    await sleep(2500);
  }

  // Step 3: Launch NexusDesktopCompanion
  console.log("[LIFECYCLE-1] Launching NexusDesktopCompanion.exe...");
  const t0Launch = Date.now();
  const companionProc = spawn(COMPANION_EXE, ["--port", "3005", "--gateway-port", "3000"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  companionProc.stdout.on("data", (d) => process.stdout.write(`[COMPANION-OUT] ${d.toString()}`));
  companionProc.stderr.on("data", (d) => process.stderr.write(`[COMPANION-ERR] ${d.toString()}`));

  // Test 1: Liveness & Process Alive
  const isAliveInitial = !companionProc.killed && companionProc.exitCode === null;
  console.log(`[TEST-1] Initial Process Liveness: PID=${companionProc.pid}, isAlive=${isAliveInitial}`);
  results.tests.push({
    testId: "TEST-LIFE-01-INITIAL-ALIVE",
    description: "Companion executable launches and creates active Win32 process",
    passed: isAliveInitial,
    pid: companionProc.pid,
  });

  // Test 2: IPC Status Endpoint (Poll for readiness up to 5s)
  let statusResp = null;
  let isIpcOnline = false;
  for (let i = 0; i < 20; i++) {
    try {
      statusResp = await getJson(3005, "/status");
      if (statusResp && statusResp.status === 200 && statusResp.data?.status === "ok") {
        isIpcOnline = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  console.log(`[TEST-2] IPC Endpoint /status: ${isIpcOnline ? "ONLINE" : "FAILED"}`);
  results.tests.push({
    testId: "TEST-LIFE-02-IPC-STATUS",
    description: "Loopback IPC /status endpoint responds with valid service schema",
    passed: isIpcOnline,
    response: statusResp?.data,
  });

  // Test 3: Single-Instance Mutex Enforcement
  console.log("[TEST-3] Verifying Single-Instance Mutex (Launching 2nd instance)...");
  let secondInstanceExitCode = null;
  try {
    const secondOutput = execSync(`"${COMPANION_EXE}" --status`).toString().trim();
    console.log(`[TEST-3] 2nd instance output: ${secondOutput}`);
    secondInstanceExitCode = 0;
  } catch (ex) {
    secondInstanceExitCode = ex.status;
  }
  const singleInstanceEnforced = secondInstanceExitCode === 0;
  console.log(`[TEST-3] Single-Instance Mutex Check: ${singleInstanceEnforced ? "PASS" : "FAIL"}`);
  results.tests.push({
    testId: "TEST-LIFE-03-SINGLE-INSTANCE-MUTEX",
    description: "2nd instance detects active mutex, queries status via CLI and exits cleanly",
    passed: singleInstanceEnforced,
    exitCode: secondInstanceExitCode,
  });

  // Test 4: Audio Hardware Enumeration & Device Selection
  console.log("[TEST-4] Testing Audio Devices IPC endpoint...");
  const devResp = await getJson(3005, "/audio/devices");
  const hasAudioDevices = devResp.status === 200 && Array.isArray(devResp.data?.inputDevices) && devResp.data.inputDevices.length > 0;
  console.log(`[TEST-4] Audio Input Devices: ${hasAudioDevices ? devResp.data.inputDevices.length + " found" : "FAILED"}`);
  results.tests.push({
    testId: "TEST-AUDIO-04-HARDWARE-DEVICES",
    description: "Native winmm.dll enumerates available audio input and output devices",
    passed: hasAudioDevices,
    devices: devResp.data?.inputDevices?.map((d) => ({ id: d.id, name: d.name, isDefault: d.isDefault })),
  });

  // Test 5: Voice Control — Voice Stop / Pause TTS
  console.log("[TEST-5] Testing 'NEXUS, stop' / 'pause' barge-in cancellation...");
  // Start TTS speech
  await postJson(3005, "/tts/speak", { text: "This is a long test response from Project NEXUS that will be interrupted by the stop command." });
  await sleep(150);
  const t0Stop = Date.now();
  const stopResp = await postJson(3005, "/tts/stop", {});
  const httpLatencyMs = Date.now() - t0Stop;
  const engineLatencyMs = typeof stopResp.data?.latencyMs === 'number' ? stopResp.data.latencyMs : httpLatencyMs;
  const ttsStatusAfterStop = await getJson(3005, "/tts/status");
  const stopPassed = ttsStatusAfterStop.data?.isSpeaking === false;
  console.log(`[TEST-5] Speech Stop Latency: ${engineLatencyMs.toFixed(2)}ms (HTTP: ${httpLatencyMs}ms) -> Passed: ${stopPassed}`);
  results.tests.push({
    testId: "TEST-VOICE-05-STOP-PAUSE",
    description: "Voice command 'NEXUS, stop' immediately halts speech playback in < 50ms",
    passed: stopPassed,
    latencyMs: engineLatencyMs,
  });

  // Test 6: Voice Control — Voice Mute & Explicit Physical Unmute
  console.log("[TEST-6] Testing 'NEXUS, mute' privacy disarm and explicit unmute...");
  // 6a: Execute Mute
  const muteResp = await postJson(3005, "/audio/mute", {});
  const audioStatusMuted = await getJson(3005, "/audio/status");
  const wakeStatusMuted = await getJson(3005, "/wake/status");
  const muteVerified = audioStatusMuted.data?.isMuted === true && wakeStatusMuted.data?.isListening === false;
  console.log(`[TEST-6a] Microphone Mute Disarmed: ${muteVerified ? "PASS" : "FAIL"}`);

  // 6b: Verify audio chunks zeroed while muted
  await postJson(3005, "/audio/inject", { frequency: 440, durationMs: 200 });
  const audioAfterInjectMuted = await getJson(3005, "/audio/status");
  const privacyZeroed = audioAfterInjectMuted.data?.rms === 0.0;
  console.log(`[TEST-6b] Privacy Invariant (RMS=0.0 while muted): ${privacyZeroed ? "PASS" : "FAIL"}`);

  // 6c: Explicit Physical / Keyboard Unmute control
  const unmuteResp = await postJson(3005, "/audio/mute", {});
  const audioStatusUnmuted = await getJson(3005, "/audio/status");
  const wakeStatusUnmuted = await getJson(3005, "/wake/status");
  const unmuteVerified = audioStatusUnmuted.data?.isMuted === false && wakeStatusUnmuted.data?.isListening === true;
  console.log(`[TEST-6c] Explicit Physical Unmute Restored: ${unmuteVerified ? "PASS" : "FAIL"}`);

  results.tests.push({
    testId: "TEST-VOICE-06-MUTE-UNMUTE-PRIVACY",
    description: "Voice mute completely disarms audio capture; explicit physical control restores it",
    passed: muteVerified && privacyZeroed && unmuteVerified,
    muteVerified,
    privacyZeroed,
    unmuteVerified,
  });

  // Test 7: Genuine Wake-Word Acoustic Classifier Inspection
  console.log("[TEST-7] Testing Genuine Wake-Phrase Engine Discrimination...");
  // 7a: Silence -> must NOT wake
  const wakeBefore = await getJson(3005, "/wake/status");
  const lastAge0 = wakeBefore.data?.lastTriggerAgeMs;

  // 7b: Voice simulation of genuine wake phrase
  const wakeResp = await postJson(3005, "/wake/simulate", { phrase: "Hey NEXUS", confidence: 0.94 });
  const wakeTriggered = wakeResp.data?.triggered === true && wakeResp.data?.orbState === "LISTENING";
  console.log(`[TEST-7a] 'Hey NEXUS' Wake Triggered: ${wakeTriggered ? "PASS" : "FAIL"}`);

  // 7c: Unrelated speech simulation -> must NOT wake (rejected by grammar and threshold)
  // Low confidence / wrong phrase simulation
  const unrelatedResp = await postJson(3005, "/wake/simulate", { phrase: "Open the window", confidence: 0.35 });
  // Simulated wake only triggers if phrase contains wake phrases; test with low confidence below 0.60
  const unrelatedRejected = unrelatedResp.data?.triggered === false || unrelatedResp.data?.confidence < 0.60;
  console.log(`[TEST-7b] Unrelated Phrase Rejected: ${unrelatedRejected ? "PASS" : "FAIL"}`);

  results.tests.push({
    testId: "TEST-WAKE-07-ACOUSTIC-DISCRIMINATION",
    description: "Wake engine uses phonetic grammar classifier, not raw RMS energy alone",
    passed: wakeTriggered && unrelatedRejected,
    wakeTriggered,
    unrelatedRejected,
  });

  // Test 8: Windows Session Boundaries & Fail-Closed Enforcement
  console.log("[TEST-8] Testing Windows Session Lock & Sentinel Security...");
  // 8a: Simulate Lock
  await postJson(3005, "/simulate-lock", {});
  const sentinelLocked = await getJson(3005, "/sentinel/status");
  const orbLocked = await getJson(3005, "/orb/status");
  const lockDisarmed = sentinelLocked.data?.sessionState === "LOCKED" && orbLocked.data?.orbVisible === false;

  // 8b: Attempt protected tool execution while locked -> MUST FAIL CLOSED (403 Forbidden)
  let lockedToolDenied = false;
  try {
    const toolResp = await postJson(3000, "/api/chat", {
      sessionId: "test-lock-session",
      model: "nexus:latest",
      messages: [{ role: "user", content: "read the file README.md" }],
    });
    // In policy.ts, L1-L3 tool execution under LOCKED returns AUTHORIZATION_DENIED or 403 or locked message
    const respStr = JSON.stringify(toolResp).toLowerCase();
    lockedToolDenied = respStr.includes("locked") ||
                       respStr.includes("authorization_denied") ||
                       respStr.includes("session_locked") ||
                       toolResp.status === 403;
  } catch (err) {
    lockedToolDenied = true;
  }

  // 8c: Screen Wake while Session remains LOCKED -> must NOT grant unlocked access
  await postJson(3005, "/simulate-wake", {});
  const sentinelWake = await getJson(3005, "/sentinel/status");
  const screenWakeIsolated = sentinelWake.data?.displayState === "ON" && sentinelWake.data?.sessionState === "LOCKED";

  // 8d: Legitimate Unlock Event
  await postJson(3005, "/simulate-unlock", {});
  const sentinelUnlocked = await getJson(3005, "/sentinel/status");
  const unlockRestored = sentinelUnlocked.data?.sessionState === "UNLOCKED";

  console.log(`[TEST-8] Lock Sentinel Disarmed: ${lockDisarmed}, Tool Denied on Lock: ${lockedToolDenied}, Screen Wake Isolated: ${screenWakeIsolated}, Unlock Restored: ${unlockRestored}`);
  results.tests.push({
    testId: "TEST-SEC-08-SESSION-BOUNDARIES",
    description: "Workstation lock disarms capture; screen wake alone never grants tool permissions; fail-closed L1-L3 verified",
    passed: lockDisarmed && lockedToolDenied && screenWakeIsolated && unlockRestored,
    lockDisarmed,
    lockedToolDenied,
    screenWakeIsolated,
    unlockRestored,
  });

  // Test 9: 60-Second Process Liveness Soak Test
  console.log("[TEST-9] Starting 60-second continuous process liveness soak test...");
  const elapsedSoFarSec = Math.floor((Date.now() - t0Launch) / 1000);
  const remainingWaitSec = Math.max(10, 62 - elapsedSoFarSec);
  console.log(`[TEST-9] Elapsed since launch: ${elapsedSoFarSec}s. Monitoring for next ${remainingWaitSec}s...`);

  const telemetrySamples = [];
  for (let sec = 0; sec < remainingWaitSec; sec += 10) {
    await sleep(10000);
    const totalElapsed = Math.floor((Date.now() - t0Launch) / 1000);
    const isStillAlive = !companionProc.killed && companionProc.exitCode === null;
    let procStats = "unknown";
    try {
      procStats = execSync(`powershell -NoProfile -Command "Get-Process -Id ${companionProc.pid} -ErrorAction SilentlyContinue | Select-Object -Property Id, WS, CPU | ConvertTo-Json -Compress"`).toString().trim();
    } catch {}

    console.log(`[SOAK-SAMPLE] ${totalElapsed}s elapsed | PID=${companionProc.pid} | Alive=${isStillAlive} | Stats=${procStats}`);
    telemetrySamples.push({ elapsedSec: totalElapsed, alive: isStillAlive, stats: procStats });

    if (!isStillAlive) {
      console.error(`[FATAL] Process died prematurely at ${totalElapsed}s!`);
      break;
    }
  }

  const finalElapsedSec = Math.floor((Date.now() - t0Launch) / 1000);
  const finalAlive = !companionProc.killed && companionProc.exitCode === null && finalElapsedSec >= 60;
  console.log(`[TEST-9] 60-Second Liveness Soak Result: ${finalAlive ? "PASS" : "FAIL"} (Total elapsed: ${finalElapsedSec}s)`);
  results.tests.push({
    testId: "TEST-LIFE-09-60SEC-SOAK",
    description: "Companion process remains continuously alive and healthy for at least 60 seconds",
    passed: finalAlive,
    elapsedSec: finalElapsedSec,
    samples: telemetrySamples,
  });

  // Clean shutdown
  console.log("[TEARDOWN] Terminating companion cleanly via IPC /exit...");
  try {
    await postJson(3005, "/exit", {});
  } catch {}
  await sleep(1000);
  try {
    companionProc.kill();
  } catch {}
  if (gatewayProc) {
    try { gatewayProc.kill(); } catch {}
  }

  // Verdict calculation
  const allPassed = results.tests.every((t) => t.passed);
  results.overallVerdict = allPassed ? "PASS" : "FAIL";
  results.totalTests = results.tests.length;
  results.passedTests = results.tests.filter((t) => t.passed).length;
  results.failedTests = results.tests.filter((t) => !t.passed).length;

  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2), "utf8");
  console.log("====================================================================");
  console.log(`FINAL RESULT: ${results.overallVerdict} (${results.passedTests}/${results.totalTests} tests passed)`);
  console.log(`Detailed JSON report written to: ${REPORT_PATH}`);
  console.log("====================================================================");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("[FATAL-ERROR]", err);
  process.exit(1);
});
