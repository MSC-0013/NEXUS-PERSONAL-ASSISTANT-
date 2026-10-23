import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const PORT = 3001;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runPhase5Tests() {
  console.log("==================================================================");
  console.log("   PROJECT NEXUS V2.3 — PHASE 5: FASTIFY CHAT GATEWAY VERIFICATION");
  console.log("==================================================================");

  // 1. Launch Gateway Child Process
  console.log(`[INFO] Launching Fastify Chat Gateway on port ${PORT}...`);
  const child = spawn("node", ["apps/chat-gateway/dist/server.js"], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (d) => console.log(`[GATEWAY-STDOUT] ${d.toString().trim()}`));
  child.stderr.on("data", (d) => console.error(`[GATEWAY-STDERR] ${d.toString().trim()}`));

  // Wait for server to become responsive
  let started = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        started = true;
        break;
      }
    } catch {
      // still starting
    }
  }

  if (!started) {
    child.kill();
    throw new Error("Chat Gateway failed to start within 15 seconds.");
  }
  console.log(`[INFO] Chat Gateway is online at ${BASE_URL}\n`);

  const results = [];

  try {
    // -----------------------------------------------------------------
    // TEST 1: Health Check Endpoint
    // -----------------------------------------------------------------
    console.log("[TEST 1/5] Verifying /health endpoint...");
    const healthRes = await fetch(`${BASE_URL}/health`);
    const healthData = await healthRes.json();
    console.log("Health payload:", JSON.stringify(healthData));
    const pass1 = healthRes.status === 200 && healthData.status === "ok" && healthData.service === "nexus-chat-gateway";
    results.push({ test: "Health Check", passed: pass1, data: healthData });
    if (!pass1) throw new Error("Health check failed");
    console.log("--> PASS: Health check verified.\n");

    // -----------------------------------------------------------------
    // TEST 2: Model List Endpoint
    // -----------------------------------------------------------------
    console.log("[TEST 2/5] Verifying /api/models endpoint...");
    const modelsRes = await fetch(`${BASE_URL}/api/models`);
    const modelsData = await modelsRes.json();
    console.log("Models list:", JSON.stringify(modelsData.models));
    const hasPromoted = modelsData.models.includes("nexus:latest") && modelsData.models.includes("nexus:0.8b");
    results.push({ test: "Model List Allowlist", passed: hasPromoted, models: modelsData.models });
    if (!hasPromoted) throw new Error("Promoted model not present in model list");
    console.log("--> PASS: Approved model allowlist verified.\n");

    // -----------------------------------------------------------------
    // TEST 3: Model Allowlist Security Boundary Rejection
    // -----------------------------------------------------------------
    console.log("[TEST 3/5] Verifying rejection of unapproved model (gpt-4o-cloud)...");
    const rejectRes = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Test query" }],
        model: "unauthorized-cloud-gpt4"
      })
    });
    const rejectData = await rejectRes.json();
    console.log(`Status: ${rejectRes.status}, Error:`, rejectData.error);
    const pass3 = rejectRes.status === 400 && rejectData.error.includes("not in the approved NEXUS model allowlist");
    results.push({ test: "Model Allowlist Rejection", passed: pass3, status: rejectRes.status });
    if (!pass3) throw new Error("Security boundary failed to reject unauthorized model!");
    console.log("--> PASS: Unauthorized model successfully rejected with HTTP 400.\n");

    // -----------------------------------------------------------------
    // TEST 4: Non-Streaming Chat with Promoted nexus:latest Model
    // -----------------------------------------------------------------
    console.log("[TEST 4/5] Executing real non-streaming inference via /api/chat (nexus:latest)...");
    const chatPayload = {
      messages: [
        {
          role: "user",
          content: "What is the current time in UTC?"
        }
      ],
      model: "nexus:latest",
      maxTokens: 128
    };
    const t0 = performance.now();
    const chatRes = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatPayload)
    });
    const chatData = await chatRes.json();
    const elapsed = Math.round(performance.now() - t0);
    console.log(`Chat response status: ${chatRes.status} in ${elapsed}ms`);
    console.log("Output content:", chatData.message?.content);
    console.log("Parsed output:", JSON.stringify(chatData.parsedOutput));
    console.log(`Telemetry: ${chatData.tokensGenerated} tokens, ${chatData.tokPerSec} tok/s`);

    const pass4 = chatRes.status === 200 && chatData.tokensGenerated > 0 && chatData.parsedOutput !== undefined;
    results.push({
      test: "Non-streaming Inference",
      passed: pass4,
      tokensGenerated: chatData.tokensGenerated,
      tokPerSec: chatData.tokPerSec,
      latencyMs: chatData.latencyMs,
      parsedOutput: chatData.parsedOutput
    });
    if (!pass4) throw new Error("Non-streaming chat inference failed");
    console.log("--> PASS: Non-streaming tool-call inference succeeded.\n");

    // -----------------------------------------------------------------
    // TEST 5: SSE Streaming Chat Endpoint
    // -----------------------------------------------------------------
    console.log("[TEST 5/5] Executing real SSE streaming inference via /api/chat/stream...");
    const streamRes = await fetch(`${BASE_URL}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello and identify your role." }],
        model: "nexus:latest",
        maxTokens: 64
      })
    });

    if (!streamRes.ok) {
      throw new Error(`Streaming request failed with status ${streamRes.status}`);
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let streamChunks = 0;
    let streamContent = "";
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.includes("[DONE]")) {
          sawDone = true;
        } else if (line.startsWith("data: ")) {
          streamChunks++;
          try {
            const p = JSON.parse(line.substring(6));
            if (p.delta) streamContent += p.delta;
          } catch {}
        }
      }
    }

    console.log(`Stream chunks received: ${streamChunks}`);
    console.log(`Streamed text content: "${streamContent.trim()}"`);
    console.log(`Saw [DONE] signal: ${sawDone}`);

    const pass5 = streamRes.status === 200 && streamChunks > 0 && sawDone;
    results.push({ test: "SSE Streaming", passed: pass5, streamChunks, sawDone });
    if (!pass5) throw new Error("Streaming validation failed");
    console.log("--> PASS: SSE Streaming successfully streamed tokens and completed.\n");

    console.log("==================================================================");
    console.log("   PHASE 5 VERIFICATION: ALL 5 MANDATORY TESTS PASSED (100%)");
    console.log("==================================================================");

    const report = {
      phase: 5,
      timestamp: new Date().toISOString(),
      status: "PASS",
      results
    };
    fs.writeFileSync("tests/phase5_test_report.json", JSON.stringify(report, null, 2));
    console.log("[INFO] Wrote report to tests/phase5_test_report.json");
  } finally {
    console.log("[INFO] Terminating gateway process...");
    child.kill();
  }
}

runPhase5Tests().catch((err) => {
  console.error("PHASE 5 FATAL ERROR:", err);
  process.exit(1);
});
