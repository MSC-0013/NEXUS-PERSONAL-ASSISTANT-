import * as fs from "fs";
import * as path from "path";
import { NexusDatabase } from "../apps/chat-gateway/dist/db.js";
import { AuditAnchor } from "../apps/audit-anchor/dist/index.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test_database", "nexus_phase6_test.sqlite");
const TEST_AUDIT_DIR = path.join(process.cwd(), "data", "test_audit_phase6");
const AUDIT_PORT = 3002;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runPhase6Tests() {
  console.log("==================================================================");
  console.log("   PROJECT NEXUS V2.3 — PHASE 6: SQLITE WAL & AUDIT ANCHOR SUITE");
  console.log("==================================================================");

  // Clean test directories
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const walPath = `${TEST_DB_PATH}-wal`;
  const shmPath = `${TEST_DB_PATH}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  if (fs.existsSync(TEST_AUDIT_DIR)) {
    fs.rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
  }

  const results = [];

  // -----------------------------------------------------------------
  // TEST 1: SQLite WAL Mode, Secure Delete & 15 Tables Schema Check
  // -----------------------------------------------------------------
  console.log("[TEST 1/5] Initializing NexusDatabase and asserting WAL mode & pragmas...");
  fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
  let dbInstance = new NexusDatabase(TEST_DB_PATH);

  const jMode = dbInstance.getJournalMode();
  const secDel = dbInstance.getSecureDelete();
  console.log(`PRAGMA journal_mode: ${jMode}`);
  console.log(`PRAGMA secure_delete: ${secDel}`);

  const tables = dbInstance.db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all();
  const tableNames = tables.map((t) => t.name);
  console.log(`Tables and virtual tables created (${tableNames.length}):`, tableNames.join(", "));

  const requiredTables = [
    "conversations",
    "messages",
    "memories",
    "documents",
    "document_chunks",
    "document_chunks_fts",
    "tasks",
    "task_steps",
    "tool_runs",
    "approval_requests",
    "audit_events",
    "scheduled_jobs",
    "job_runs"
  ];

  const allPresent = requiredTables.every((t) => tableNames.includes(t));
  const pass1 = jMode.toLowerCase() === "wal" && secDel === 1 && allPresent;
  results.push({ test: "SQLite WAL & Schema", passed: pass1, journalMode: jMode, secureDelete: secDel, tableCount: tableNames.length });
  if (!pass1) throw new Error("SQLite WAL mode or required schema table missing!");
  console.log("--> PASS: SQLite WAL mode, secure-delete, and authoritative schema verified.\n");

  // -----------------------------------------------------------------
  // TEST 2: Session & Message Persistence Across Process Restarts
  // -----------------------------------------------------------------
  console.log("[TEST 2/5] Testing session persistence across database close and reopen...");
  const convId = `conv-${Date.now()}`;
  dbInstance.createConversation(convId, "Sovereign Engineering Session", "nexus:latest");
  dbInstance.addMessage(`msg-1`, convId, "user", "Initiate sovereign agent protocol.");
  dbInstance.addMessage(`msg-2`, convId, "assistant", '{"kind":"action","tool_calls":[{"name":"get_current_time"}]}');
  dbInstance.addMessage(`msg-3`, convId, "tool", '{"isoUtc":"2026-10-22T05:50:00Z"}');

  // Close database
  console.log("[INFO] Closing database connection...");
  dbInstance.close();

  // Re-open from disk
  console.log("[INFO] Reopening database from disk...");
  const reopenedDb = new NexusDatabase(TEST_DB_PATH);
  const restoredMessages = reopenedDb.getMessages(convId);
  console.log(`Restored messages count: ${restoredMessages.length}`);
  const pass2 = restoredMessages.length === 3 && restoredMessages[0].content.includes("sovereign agent protocol");
  results.push({ test: "Persistence Across Restarts", passed: pass2, messageCount: restoredMessages.length });
  reopenedDb.close();
  if (!pass2) throw new Error("Message persistence across restart failed!");
  console.log("--> PASS: Conversations and messages survive process restarts identically.\n");

  // -----------------------------------------------------------------
  // TEST 3: Audit Anchor Sidecar HTTP Server & HMAC Chain
  // -----------------------------------------------------------------
  console.log("[TEST 3/5] Starting AuditAnchor HTTP server on port 3002...");
  const anchor = new AuditAnchor(TEST_AUDIT_DIR);
  const server = anchor.startHttpServer(AUDIT_PORT);

  await sleep(300);

  // Health
  const healthRes = await fetch(`http://127.0.0.1:${AUDIT_PORT}/health`);
  const healthData = await healthRes.json();
  console.log("Audit Anchor health:", JSON.stringify(healthData));

  // Record 5 events
  for (let i = 1; i <= 5; i++) {
    const postRes = await fetch(`http://127.0.0.1:${AUDIT_PORT}/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor: i % 2 === 0 ? "agent" : "user",
        action: `tool_execution_step_${i}`,
        payload: { step: i, target: `resource_${i}.ts`, hash: `sha256_${i}` }
      })
    });
    if (!postRes.ok) throw new Error(`Failed to record audit event ${i}`);
  }

  // Verify chain
  const verifyRes = await fetch(`http://127.0.0.1:${AUDIT_PORT}/verify`);
  const verifyData = await verifyRes.json();
  console.log("Audit verification result:", JSON.stringify(verifyData));

  const pass3 = verifyRes.status === 200 && verifyData.valid === true && verifyData.recordsCount === 5;
  results.push({ test: "Audit Chain Integrity", passed: pass3, recordsCount: verifyData.recordsCount });
  if (!pass3) throw new Error("Audit chain verification failed!");
  console.log("--> PASS: Audit Anchor sidecar recorded 5 chained HMAC events and verified chain.\n");

  // -----------------------------------------------------------------
  // TEST 4: Tamper Detection (Adversarial Security Assertion)
  // -----------------------------------------------------------------
  console.log("[TEST 4/5] Simulating single-byte tampering in audit log...");
  const logFile = path.join(TEST_AUDIT_DIR, "anchor_chain.jsonl");
  const originalLog = fs.readFileSync(logFile, "utf-8");
  const lines = originalLog.split("\n").filter(Boolean);

  // Tamper record 3 payload
  const tamperedRecord = JSON.parse(lines[2]);
  tamperedRecord.payload.target = "tampered_resource.ts"; // Alter payload without updating HMAC
  lines[2] = JSON.stringify(tamperedRecord);
  fs.writeFileSync(logFile, lines.join("\n") + "\n", "utf-8");

  // Re-verify: must fail
  const tamperCheck = anchor.verifyChain();
  console.log("Tamper detection outcome:", JSON.stringify(tamperCheck));
  const pass4 = tamperCheck.valid === false && tamperCheck.error?.includes("Tampering Detected");
  results.push({ test: "Tamper Detection", passed: pass4, detectedError: tamperCheck.error });

  // Restore original log
  fs.writeFileSync(logFile, originalLog, "utf-8");
  const restoredCheck = anchor.verifyChain();
  console.log("Restored verification:", JSON.stringify(restoredCheck));
  if (!pass4 || !restoredCheck.valid) throw new Error("Tamper detection test failed!");
  console.log("--> PASS: Cryptographic tampering detected and rejected immediately.\n");

  // -----------------------------------------------------------------
  // TEST 5: Quiescent Barrier Lock & Fail-Closed Behavior
  // -----------------------------------------------------------------
  console.log("[TEST 5/5] Testing Quiescent Barrier Lock (Phase 9/13 backup protocol)...");
  const barrierRes = await fetch(`http://127.0.0.1:${AUDIT_PORT}/barrier`, { method: "POST" });
  const barrierData = await barrierRes.json();
  console.log("Barrier acquired:", JSON.stringify(barrierData));

  // Try to append while locked: must return HTTP 423 / error
  const lockedPostRes = await fetch(`http://127.0.0.1:${AUDIT_PORT}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "user", action: "blocked_write", payload: {} })
  });
  console.log(`Write during barrier lock status: ${lockedPostRes.status}`);

  // Release barrier
  const releaseRes = await fetch(`http://127.0.0.1:${AUDIT_PORT}/release`, { method: "POST" });
  console.log(`Release barrier status: ${releaseRes.status}`);

  // Now append must succeed
  const postAfterRelease = await fetch(`http://127.0.0.1:${AUDIT_PORT}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "system", action: "post_barrier_event", payload: { sequence: 6 } })
  });
  console.log(`Write after release status: ${postAfterRelease.status}`);

  const pass5 = barrierRes.status === 200 && lockedPostRes.status === 423 && releaseRes.status === 200 && postAfterRelease.status === 200;
  results.push({ test: "Barrier Lock & Release", passed: pass5 });
  if (!pass5) throw new Error("Barrier lock protocol failed!");
  console.log("--> PASS: Quiescent barrier lock blocks mutations during backup and releases cleanly.\n");

  server.close();

  console.log("==================================================================");
  console.log("   PHASE 6 VERIFICATION: ALL 5 MANDATORY TESTS PASSED (100%)");
  console.log("==================================================================");

  const report = {
    phase: 6,
    timestamp: new Date().toISOString(),
    status: "PASS",
    results
  };
  fs.writeFileSync("tests/phase6_test_report.json", JSON.stringify(report, null, 2));
  console.log("[INFO] Wrote report to tests/phase6_test_report.json");
}

runPhase6Tests().catch((err) => {
  console.error("PHASE 6 FATAL ERROR:", err);
  process.exit(1);
});
