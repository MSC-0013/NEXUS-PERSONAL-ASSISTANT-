import * as fs from "fs";
import * as path from "path";
import { NexusDatabase } from "../apps/chat-gateway/dist/db.js";
import { NexusScheduler } from "../apps/scheduler/dist/index.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test_database", "nexus_phase11_scheduler.sqlite");

async function runPhase11Tests() {
  console.log("==================================================================");
  console.log("   PROJECT NEXUS V2.3 — PHASE 11: SCHEDULER & LEASE SUITE");
  console.log("==================================================================");

  // Clean test DB
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const walPath = `${TEST_DB_PATH}-wal`;
  const shmPath = `${TEST_DB_PATH}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
  const nexusDb = new NexusDatabase(TEST_DB_PATH);
  const db = nexusDb.db;

  const results = [];
  const scheduler = new NexusScheduler("worker-alpha", 60);

  // -----------------------------------------------------------------
  // TEST 1: Job Registration & Atomic Lease Claim
  // -----------------------------------------------------------------
  console.log("[TEST 1/5] Registering job and claiming atomic lease...");
  const jobId = "job-daily-backup";
  const targetEpoch = 1750000000;
  scheduler.registerJob(db, jobId, "system_backup", { target: "workspace" }, targetEpoch, "run_once");

  const claim1 = scheduler.claimJobRun(db, jobId, targetEpoch, targetEpoch);
  console.log("Worker 1 claim outcome:", claim1.success, "Run ID:", claim1.runId);

  const pass1 = claim1.success === true && Boolean(claim1.runId);
  results.push({ test: "Atomic Lease Claim", passed: pass1, runId: claim1.runId });
  if (!pass1) throw new Error("Worker failed to claim initial atomic lease!");
  console.log("--> PASS: Worker successfully claimed unique atomic lease.\n");

  // -----------------------------------------------------------------
  // TEST 2: Duplicate Lease Claim Blocking (Occurrence Uniqueness)
  // -----------------------------------------------------------------
  console.log("[TEST 2/5] Testing duplicate lease claim blocking from competing worker...");
  const competingScheduler = new NexusScheduler("worker-beta", 60);
  const claim2 = competingScheduler.claimJobRun(db, jobId, targetEpoch, targetEpoch);
  console.log("Worker 2 claim outcome:", claim2.success, "Error:", claim2.error);

  const pass2 = claim2.success === false && claim2.error === "duplicate_lease_claim_blocked";
  results.push({ test: "Duplicate Lease Blocked", passed: pass2 });
  if (!pass2) throw new Error("Database failed to block duplicate lease claim!");
  console.log("--> PASS: Duplicate lease claim blocked by UNIQUE(job_id, scheduled_for_epoch).\n");

  // -----------------------------------------------------------------
  // TEST 3: Job Run Completion & Status Update
  // -----------------------------------------------------------------
  console.log("[TEST 3/5] Completing job execution and asserting ledger update...");
  scheduler.completeJobRun(db, claim1.runId, jobId, { bytesArchived: 1048576 }, targetEpoch + 5);

  const runRecord = db.prepare("SELECT * FROM job_runs WHERE id = ?").get(claim1.runId);
  const jobRecord = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(jobId);
  console.log("Run status:", runRecord.status, "Job outcome:", jobRecord.last_outcome);

  const pass3 = runRecord.status === "completed" && jobRecord.last_outcome === "success";
  results.push({ test: "Run Completion", passed: pass3 });
  if (!pass3) throw new Error("Job run completion update failed!");
  console.log("--> PASS: Job run completed and persistent state updated cleanly.\n");

  // -----------------------------------------------------------------
  // TEST 4: Stale Lease Recovery After Worker Crash
  // -----------------------------------------------------------------
  console.log("[TEST 4/5] Testing stale lease recovery for crashed worker...");
  // Simulate crashed worker by inserting an expired lease
  const crashEpoch = 1750001000;
  scheduler.registerJob(db, "job-crashed", "maintenance", {}, crashEpoch, "run_once");
  scheduler.claimJobRun(db, "job-crashed", crashEpoch, crashEpoch); // Lease expires in 60s

  // Reconcile leases 1 hour later
  const recoveredStale = scheduler.reconcileStaleLeases(db, crashEpoch + 3600);
  console.log(`Stale leases recovered: ${recoveredStale}`);

  const staleRun = db.prepare("SELECT * FROM job_runs WHERE job_id = 'job-crashed'").get();
  console.log("Crashed run transitioned status:", staleRun.status);

  const pass4 = recoveredStale >= 1 && staleRun.status === "stale_recovered";
  results.push({ test: "Stale Lease Recovery", passed: pass4, recoveredCount: recoveredStale });
  if (!pass4) throw new Error("Stale lease recovery failed!");
  console.log("--> PASS: Stale lease from crashed worker safely transitioned to 'stale_recovered'.\n");

  // -----------------------------------------------------------------
  // TEST 5: Laptop Sleep / Wake Recovery Policies
  // -----------------------------------------------------------------
  console.log("[TEST 5/5] Testing laptop sleep recovery policies (run_once, skip, notify)...");
  // Clean prior test jobs so only the 3 sleep test jobs are evaluated
  db.prepare("DELETE FROM job_runs").run();
  db.prepare("DELETE FROM scheduled_jobs").run();

  const sleepPastEpoch = 1750002000;
  const wakeCurrentEpoch = sleepPastEpoch + 18000; // 5 hours after sleep

  scheduler.registerJob(db, "job-sleep-run-once", "sync", {}, sleepPastEpoch, "run_once");
  scheduler.registerJob(db, "job-sleep-skip", "metric_flush", {}, sleepPastEpoch, "skip");
  scheduler.registerJob(db, "job-sleep-notify", "report", {}, sleepPastEpoch, "notify");

  const recoverySummary = scheduler.handleSleepRecovery(db, wakeCurrentEpoch, 120);
  console.log("Sleep recovery summary:", JSON.stringify(recoverySummary));

  const pass5 =
    recoverySummary.recoveredCount === 3 &&
    recoverySummary.runOnce === 1 &&
    recoverySummary.skipped === 1 &&
    recoverySummary.notified === 1;

  results.push({ test: "Sleep Recovery Policies", passed: pass5, summary: recoverySummary });
  nexusDb.close();
  if (!pass5) throw new Error("Sleep recovery policies failed!");
  console.log("--> PASS: Laptop sleep/wake recovery policies successfully executed.\n");

  console.log("==================================================================");
  console.log("   PHASE 11 VERIFICATION: ALL 5 SCHEDULER TESTS PASSED (100%)");
  console.log("==================================================================");

  const report = {
    phase: 11,
    timestamp: new Date().toISOString(),
    status: "PASS",
    results
  };
  fs.writeFileSync("tests/phase11_test_report.json", JSON.stringify(report, null, 2));
  console.log("[INFO] Wrote report to tests/phase11_test_report.json");
}

runPhase11Tests().catch((err) => {
  console.error("PHASE 11 FATAL ERROR:", err);
  process.exit(1);
});
