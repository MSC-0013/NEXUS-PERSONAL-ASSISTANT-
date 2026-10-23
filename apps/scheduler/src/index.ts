import * as crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { EpochLease } from "@nexus/shared-types";

export interface ScheduledJobRecord {
  id: string;
  jobType: string;
  payloadJson: string;
  scheduleCron?: string;
  nextRunEpoch: number;
  lastRunEpoch?: number;
  lastOutcome?: string;
  failureCount: number;
  missedRunPolicy: "run_once" | "skip" | "notify";
  enabled: boolean;
}

export class NexusScheduler {
  public workerId: string;
  public leaseDurationSec: number;

  constructor(workerId?: string, leaseDurationSec = 60) {
    this.workerId = workerId || `worker-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.leaseDurationSec = leaseDurationSec;
  }

  public computeIdempotencyKey(jobId: string, scheduledForEpoch: number): string {
    return crypto.createHash("sha256").update(`${jobId}:${scheduledForEpoch}`).digest("hex");
  }

  public registerJob(
    db: DatabaseSync,
    id: string,
    jobType: string,
    payload: Record<string, unknown>,
    nextRunEpoch: number,
    missedRunPolicy: "run_once" | "skip" | "notify" = "run_once",
    scheduleCron?: string
  ): void {
    const stmt = db.prepare(`
      INSERT INTO scheduled_jobs (
        id, job_type, payload_json, schedule_cron, next_run_epoch, missed_run_policy, enabled, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch())
    `);
    stmt.run(id, jobType, JSON.stringify(payload), scheduleCron || null, nextRunEpoch, missedRunPolicy);
  }

  public claimJobRun(
    db: DatabaseSync,
    jobId: string,
    scheduledForEpoch: number,
    currentEpoch: number = Math.floor(Date.now() / 1000)
  ): { success: boolean; runId?: string; error?: string } {
    const runId = `run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const leaseExpiresEpoch = currentEpoch + this.leaseDurationSec;
    const idempotencyKey = this.computeIdempotencyKey(jobId, scheduledForEpoch);

    try {
      const stmt = db.prepare(`
        INSERT INTO job_runs (
          id, job_id, scheduled_for_epoch, worker_id, claimed_at_epoch, lease_expires_epoch,
          heartbeat_epoch, attempt_count, idempotency_key, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'claimed')
      `);
      stmt.run(runId, jobId, scheduledForEpoch, this.workerId, currentEpoch, leaseExpiresEpoch, currentEpoch, idempotencyKey);
      return { success: true, runId };
    } catch (err: any) {
      return { success: false, error: "duplicate_lease_claim_blocked" };
    }
  }

  public completeJobRun(
    db: DatabaseSync,
    runId: string,
    jobId: string,
    outcome: Record<string, unknown>,
    completedEpoch: number = Math.floor(Date.now() / 1000)
  ): void {
    const updateRun = db.prepare(`
      UPDATE job_runs
      SET status = 'completed', outcome_json = ?, completed_at_epoch = ?
      WHERE id = ?
    `);
    updateRun.run(JSON.stringify(outcome), completedEpoch, runId);

    const updateJob = db.prepare(`
      UPDATE scheduled_jobs
      SET last_run_epoch = ?, last_outcome = 'success', failure_count = 0
      WHERE id = ?
    `);
    updateJob.run(completedEpoch, jobId);
  }

  public reconcileStaleLeases(db: DatabaseSync, currentEpoch: number = Math.floor(Date.now() / 1000)): number {
    const stmt = db.prepare(`
      UPDATE job_runs
      SET status = 'stale_recovered'
      WHERE status IN ('claimed', 'running') AND lease_expires_epoch < ?
    `);
    const info = stmt.run(currentEpoch);
    return Number(info.changes);
  }

  public handleSleepRecovery(
    db: DatabaseSync,
    currentEpoch: number = Math.floor(Date.now() / 1000),
    sleepThresholdSec = 120
  ): { recoveredCount: number; runOnce: number; skipped: number; notified: number } {
    const stmt = db.prepare(`
      SELECT * FROM scheduled_jobs
      WHERE enabled = 1 AND next_run_epoch < (? - ?)
    `);
    const overdueJobs = stmt.all(currentEpoch, sleepThresholdSec) as any[];

    let runOnce = 0;
    let skipped = 0;
    let notified = 0;

    for (const job of overdueJobs) {
      if (job.missed_run_policy === "run_once") {
        // Execute immediately for currentEpoch
        this.claimJobRun(db, job.id, currentEpoch, currentEpoch);
        runOnce++;
      } else if (job.missed_run_policy === "skip") {
        // Advance schedule without executing backlog
        const nextSchedule = currentEpoch + 3600;
        db.prepare("UPDATE scheduled_jobs SET next_run_epoch = ?, last_outcome = 'skipped' WHERE id = ?").run(nextSchedule, job.id);
        skipped++;
      } else if (job.missed_run_policy === "notify") {
        notified++;
      }
    }

    return {
      recoveredCount: overdueJobs.length,
      runOnce,
      skipped,
      notified
    };
  }
}
