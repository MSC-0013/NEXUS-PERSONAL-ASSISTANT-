import * as fs from "fs";
import * as path from "path";
import { VoiceBridgeDaemon } from "../apps/voice-bridge/dist/index.js";

async function runPhase10Tests() {
  console.log("==================================================================");
  console.log("   PROJECT NEXUS V2.3 — PHASE 10: VOICE PIPELINE & LICENSING SUITE");
  console.log("==================================================================");

  const results = [];
  const daemon = new VoiceBridgeDaemon();

  // -----------------------------------------------------------------
  // TEST 1: Web Audio 48 kHz to 16 kHz Mono Resampler
  // -----------------------------------------------------------------
  console.log("[TEST 1/5] Testing Web Audio 48 kHz to 16 kHz Mono PCM resampler...");
  const input48k = new Float32Array(48000); // 1 second of 48kHz audio
  for (let i = 0; i < input48k.length; i++) {
    input48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000); // 440Hz tone
  }

  const resampled16k = daemon.resampleTo16kHzMono(input48k, 48000);
  console.log(`Input sample count: ${input48k.length} (48 kHz)`);
  console.log(`Resampled sample count: ${resampled16k.length} (16 kHz mono)`);

  const pass1 = resampled16k.length === 16000 && resampled16k instanceof Int16Array;
  results.push({ test: "Audio Resampler", passed: pass1, targetSamples: resampled16k.length });
  if (!pass1) throw new Error("16 kHz resampler failed!");
  console.log("--> PASS: 48 kHz Web Audio resampled cleanly to 16,000 samples of 16-bit mono PCM.\n");

  // -----------------------------------------------------------------
  // TEST 2: Speech-to-Text Transcription Pipeline
  // -----------------------------------------------------------------
  console.log("[TEST 2/5] Testing local speech-to-text (Whisper) transcription...");
  const pcmBuffer = Buffer.from(resampled16k.buffer);
  const sttResult = await daemon.transcribeAudio(pcmBuffer);
  console.log("STT Transcript:", sttResult.text);
  console.log("STT Confidence:", sttResult.confidence);
  console.log(`STT Processing Time: ${sttResult.durationMs}ms`);

  const pass2 = Boolean(sttResult.text) && sttResult.confidence > 0.9;
  results.push({ test: "Speech-to-Text Pipeline", passed: pass2, confidence: sttResult.confidence });
  if (!pass2) throw new Error("STT transcription pipeline failed!");
  console.log("--> PASS: Local speech transcription verified.\n");

  // -----------------------------------------------------------------
  // TEST 3: Text-to-Speech Synthesis Pipeline
  // -----------------------------------------------------------------
  console.log("[TEST 3/5] Testing text-to-speech (Piper) synthesis...");
  const ttsResult = await daemon.synthesizeSpeech("NEXUS assistant speech synthesis test.");
  console.log(`Synthesized audio buffer size: ${ttsResult.audioBuffer.length} bytes`);
  console.log(`Synthesis latency: ${ttsResult.latencyMs}ms`);

  const pass3 = ttsResult.audioBuffer.length > 0 && daemon.validateAudioFormat(ttsResult.audioBuffer);
  results.push({ test: "Text-to-Speech Pipeline", passed: pass3, bytes: ttsResult.audioBuffer.length });
  if (!pass3) throw new Error("TTS speech synthesis pipeline failed!");
  console.log("--> PASS: TTS audio buffer generated and format validated.\n");

  // -----------------------------------------------------------------
  // TEST 4: Push-to-Talk Interruption Latency Benchmark (< 50ms)
  // -----------------------------------------------------------------
  console.log("[TEST 4/5] Executing Push-to-Talk interruption latency benchmark...");
  // Benchmark 20 interruption trials
  const latencies = [];
  for (let i = 0; i < 20; i++) {
    const irq = daemon.interruptSpeech();
    latencies.push(irq.latencyMs);
  }
  const maxLatency = Math.max(...latencies);
  const avgLatency = Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100;
  console.log(`Interruption latency: avg = ${avgLatency}ms, max = ${maxLatency}ms (target < 50ms)`);

  const pass4 = maxLatency < 50.0;
  results.push({ test: "Interruption Benchmark", passed: pass4, avgLatencyMs: avgLatency, maxLatencyMs: maxLatency });
  if (!pass4) throw new Error(`Interruption latency exceeded 50ms threshold: ${maxLatency}ms`);
  console.log("--> PASS: Push-to-talk interruption latency well within 50ms budget.\n");

  // -----------------------------------------------------------------
  // TEST 5: Licensing Architecture & GPL Isolation Boundary Audit
  // -----------------------------------------------------------------
  console.log("[TEST 5/5] Auditing licensing files and GPL-3.0+ containment boundary...");
  const noticeExists = fs.existsSync("NOTICE.md");
  const voiceDocsExists = fs.existsSync("docs/licensing/voice_models.md");

  const noticeText = noticeExists ? fs.readFileSync("NOTICE.md", "utf-8") : "";
  const hasGPLBoundary = noticeText.includes("GPL-3.0+") && noticeText.includes("Architectural Isolation Boundary");
  const hasApacheNotice = noticeText.includes("Apache License, Version 2.0");

  console.log(`NOTICE.md present: ${noticeExists}`);
  console.log(`docs/licensing/voice_models.md present: ${voiceDocsExists}`);
  console.log(`GPL-3.0+ isolation documented: ${hasGPLBoundary}`);
  console.log(`Apache-2.0 core documented: ${hasApacheNotice}`);

  const pass5 = noticeExists && voiceDocsExists && hasGPLBoundary && hasApacheNotice;
  results.push({ test: "Licensing Audit", passed: pass5 });
  if (!pass5) throw new Error("Licensing audit failed!");
  console.log("--> PASS: Open-source licensing boundaries verified.\n");

  console.log("==================================================================");
  console.log("   PHASE 10 VERIFICATION: ALL 5 VOICE & LICENSE TESTS PASSED (100%)");
  console.log("==================================================================");

  const report = {
    phase: 10,
    timestamp: new Date().toISOString(),
    status: "PASS",
    results
  };
  fs.writeFileSync("tests/phase10_test_report.json", JSON.stringify(report, null, 2));
  console.log("[INFO] Wrote report to tests/phase10_test_report.json");
}

runPhase10Tests().catch((err) => {
  console.error("PHASE 10 FATAL ERROR:", err);
  process.exit(1);
});
