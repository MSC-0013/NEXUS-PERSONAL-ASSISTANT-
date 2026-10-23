import * as fs from "fs";
import * as path from "path";
import {
  resolveJailedPath,
  SecurityException,
  SafePrattMathParser,
  RecoverableExecutionEngine,
  BoundedAgentLoop
} from "../apps/chat-gateway/dist/agent.js";

const TEST_WORKSPACE = path.join(process.cwd(), "data", "test_workspace_phase8");
const TEST_BACKUP = path.join(process.cwd(), "data", "test_backups_phase8");

async function runPhase8Tests() {
  console.log("==================================================================");
  console.log("   PROJECT NEXUS V2.3 — PHASE 8: AGENT ORCHESTRATION & SECURITY");
  console.log("==================================================================");

  // Setup test directories
  if (fs.existsSync(TEST_WORKSPACE)) fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  if (fs.existsSync(TEST_BACKUP)) fs.rmSync(TEST_BACKUP, { recursive: true, force: true });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
  fs.mkdirSync(TEST_BACKUP, { recursive: true });

  const results = [];

  // -----------------------------------------------------------------
  // TEST 1: Hardened Path Jail Traversal Defense
  // -----------------------------------------------------------------
  console.log("[TEST 1/5] Testing resolveJailedPath() against path traversal attacks...");
  let passJail = true;

  // Attack 1: Relative traversal
  try {
    resolveJailedPath("../../windows/system32/notepad.exe", TEST_WORKSPACE);
    passJail = false;
  } catch (err) {
    console.log("Attack 1 blocked:", err.message);
  }

  // Attack 2: Absolute Windows drive path
  try {
    resolveJailedPath("C:/Windows/System32/cmd.exe", TEST_WORKSPACE);
    passJail = false;
  } catch (err) {
    console.log("Attack 2 blocked:", err.message);
  }

  // Attack 3: Null byte injection
  try {
    resolveJailedPath("legit_file.txt\0/etc/passwd", TEST_WORKSPACE);
    passJail = false;
  } catch (err) {
    console.log("Attack 3 blocked:", err.message);
  }

  // Legitimate file
  const legitPath = resolveJailedPath("docs/readme.txt", TEST_WORKSPACE);
  console.log("Legitimate path resolved:", legitPath);
  const pass1 = passJail && legitPath.startsWith(path.resolve(TEST_WORKSPACE));
  results.push({ test: "Path Jail Security", passed: pass1 });
  if (!pass1) throw new Error("Path jail traversal defense failed!");
  console.log("--> PASS: Path jail blocked all traversal attacks and permitted valid path.\n");

  // -----------------------------------------------------------------
  // TEST 2: Safe Pratt Math Parser
  // -----------------------------------------------------------------
  console.log("[TEST 2/5] Testing SafePrattMathParser with magnitude & operator guards...");
  const p1 = new SafePrattMathParser("(15 + 5) * 3 - 10 / 2");
  const r1 = p1.parse();
  console.log("(15 + 5) * 3 - 10 / 2 =", r1);

  let blockedDivZero = false;
  try {
    new SafePrattMathParser("100 / 0").parse();
  } catch (err) {
    blockedDivZero = err.message.includes("Division by zero");
    console.log("Division by zero blocked:", err.message);
  }

  let blockedExpOverflow = false;
  try {
    new SafePrattMathParser("2 ^ 500").parse();
  } catch (err) {
    blockedExpOverflow = err.message.includes("Exponent exceeds maximum power limit");
    console.log("Exponent overflow blocked:", err.message);
  }

  const pass2 = r1 === 55 && blockedDivZero && blockedExpOverflow;
  results.push({ test: "Safe Pratt Parser", passed: pass2, standardResult: r1 });
  if (!pass2) throw new Error("Pratt parser validation failed!");
  console.log("--> PASS: Pratt math parser safely evaluated operations and prevented DoS.\n");

  // -----------------------------------------------------------------
  // TEST 3: Two-Phase Recoverable Execution (New File vs Existing)
  // -----------------------------------------------------------------
  console.log("[TEST 3/5] Testing 2-phase recoverable execution protocol...");
  const engine = new RecoverableExecutionEngine(TEST_WORKSPACE, TEST_BACKUP);

  // 3a. New File Creation
  const newContent = "Autonomous sovereign agent artifact content v1.";
  const newExpectedHash = engine.computeSha256(newContent);
  const planNew = {
    executionId: "exec-new-1",
    relativePath: "output.txt",
    isNewFile: true,
    preStateHash: "EMPTY",
    newContent,
    postStateExpectedHash: newExpectedHash
  };

  const resNew = engine.execute(planNew);
  console.log("New file execution result:", resNew.status);
  const tombstoneExists = fs.existsSync(path.join(TEST_BACKUP, "file_history", "pre_exec-new-1.tombstone"));
  console.log("Absence tombstone created:", tombstoneExists);

  // 3b. Collision Defense on Target Exists
  const planCollision = { ...planNew, executionId: "exec-collision-2" };
  const resCollision = engine.execute(planCollision);
  console.log("Collision defense result:", resCollision.error);

  // 3c. Existing File Modification
  const modifiedContent = "Autonomous sovereign agent artifact content v2 (UPDATED).";
  const modExpectedHash = engine.computeSha256(modifiedContent);
  const planMod = {
    executionId: "exec-mod-3",
    relativePath: "output.txt",
    isNewFile: false,
    preStateHash: newExpectedHash,
    newContent: modifiedContent,
    postStateExpectedHash: modExpectedHash
  };
  const resMod = engine.execute(planMod);
  console.log("Modification execution result:", resMod.status);
  const backupExists = fs.existsSync(path.join(TEST_BACKUP, "file_history", "pre_exec-mod-3.bak"));
  console.log("Pre-write snapshot created:", backupExists);

  const pass3 =
    resNew.status === "completed" &&
    tombstoneExists &&
    resCollision.error === "pre_state_drift_target_exists" &&
    resMod.status === "completed" &&
    backupExists;

  results.push({ test: "2-Phase Execution Protocol", passed: pass3 });
  if (!pass3) throw new Error("2-phase recoverable execution protocol failed!");
  console.log("--> PASS: 2-phase execution verified for new files, tombstones, and modifications.\n");

  // -----------------------------------------------------------------
  // TEST 4: Crash Reconciliation Protocol
  // -----------------------------------------------------------------
  console.log("[TEST 4/5] Testing crash reconciliation state machine...");
  // 4a. Post-rename crash -> reconciles to completed
  const recCompleted = engine.reconcileCrash(planMod);
  console.log("Reconcile crash when file was renamed:", recCompleted);

  // 4b. Pre-rename crash on new file -> target absent -> reconciles to approved
  const planPendingNew = {
    executionId: "exec-pending-4",
    relativePath: "unwritten.txt",
    isNewFile: true,
    preStateHash: "EMPTY",
    newContent: "test",
    postStateExpectedHash: "somehash"
  };
  const recApproved = engine.reconcileCrash(planPendingNew);
  console.log("Reconcile crash when new file unwritten:", recApproved);

  const pass4 = recCompleted === "completed" && recApproved === "approved";
  results.push({ test: "Crash Reconciliation", passed: pass4 });
  if (!pass4) throw new Error("Crash reconciliation failed!");
  console.log("--> PASS: Crash recovery deterministic state machine verified.\n");

  // -----------------------------------------------------------------
  // TEST 5: Bounded Agent Loop & User Approval Gate
  // -----------------------------------------------------------------
  console.log("[TEST 5/5] Testing 8-step maximum loop cap and user approval requirements...");
  const agent = new BoundedAgentLoop(TEST_WORKSPACE, 8);

  const step7 = agent.runBoundedLoop(7);
  const step8 = agent.runBoundedLoop(8);
  console.log("Step 7 allowed:", step7.allowed);
  console.log("Step 8 allowed:", step8.allowed, "Terminal reason:", step8.terminalReason);

  // Tool execution requiring confirmation
  const writeToolCall = {
    id: "call-1",
    name: "propose_workspace_write",
    arguments: { relative_path: "proposal.txt", proposed_content: "New proposal" }
  };
  const toolExec = await agent.executeTool(writeToolCall);
  console.log("Write proposal requiresUserConfirmation:", toolExec.requiresUserConfirmation);

  const pass5 = step7.allowed === true && step8.allowed === false && toolExec.requiresUserConfirmation === true;
  results.push({ test: "Bounded Agent Loop & Approval Gate", passed: pass5 });
  if (!pass5) throw new Error("Bounded agent loop verification failed!");
  console.log("--> PASS: 8-step loop boundary enforced and write proposals require user approval.\n");

  console.log("==================================================================");
  console.log("   PHASE 8 VERIFICATION: ALL 5 SECURITY TESTS PASSED (100%)");
  console.log("==================================================================");

  const report = {
    phase: 8,
    timestamp: new Date().toISOString(),
    status: "PASS",
    results
  };
  fs.writeFileSync("tests/phase8_test_report.json", JSON.stringify(report, null, 2));
  console.log("[INFO] Wrote report to tests/phase8_test_report.json");
}

runPhase8Tests().catch((err) => {
  console.error("PHASE 8 FATAL ERROR:", err);
  process.exit(1);
});
