import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";
import { CryptographicAuditRecord } from "@nexus/shared-types";

export class AuditAnchor {
  private logPath: string;
  private hmacKey: string;
  private lastHash: string;
  private sequenceNumber: number;
  private isLocked: boolean;

  constructor(logDir: string, secretKey?: string) {
    this.logPath = path.join(logDir, "anchor_chain.jsonl");
    this.hmacKey = secretKey || process.env.AUDIT_HMAC_SECRET || "nexus-sovereign-audit-hmac-v1";
    this.lastHash = "0".repeat(64); // Genesis hash
    this.sequenceNumber = 0;
    this.isLocked = false;

    fs.mkdirSync(logDir, { recursive: true });
    this.initializeChain();
  }

  public initializeChain(): void {
    if (!fs.existsSync(this.logPath)) {
      return;
    }

    const lines = fs.readFileSync(this.logPath, "utf-8").split("\n").filter(Boolean);
    let currentHash = "0".repeat(64);
    let expectedSeq = 0;

    for (const line of lines) {
      const record: CryptographicAuditRecord = JSON.parse(line);
      expectedSeq++;

      if (record.sequenceNumber !== expectedSeq) {
        throw new Error(`Audit Chain Sequence Violation: Expected ${expectedSeq}, got ${record.sequenceNumber}`);
      }

      if (record.previousHash !== currentHash) {
        throw new Error(`Audit Chain Broken at sequence ${record.sequenceNumber}: Hash mismatch.`);
      }

      const computedHash = this.computeRecordHash(
        record.previousHash,
        record.sequenceNumber,
        record.timestamp,
        record.actor,
        record.action,
        record.payload
      );
      if (record.recordHash !== computedHash) {
        throw new Error(`Audit Record Tampering Detected at sequence ${record.sequenceNumber}!`);
      }

      currentHash = record.recordHash;
    }

    this.sequenceNumber = expectedSeq;
    this.lastHash = currentHash;
  }

  public computeRecordHash(
    prevHash: string,
    seq: number,
    timestamp: string,
    actor: string,
    action: string,
    payload: Record<string, unknown>
  ): string {
    const raw = `${prevHash}|${seq}|${timestamp}|${actor}|${action}|${JSON.stringify(payload)}`;
    return crypto.createHmac("sha256", this.hmacKey).update(raw).digest("hex");
  }

  public recordEvent(
    actor: "user" | "agent" | "system",
    action: string,
    payload: Record<string, unknown>
  ): CryptographicAuditRecord {
    if (this.isLocked) {
      throw new Error("Audit Anchor Chain is locked by an active barrier.");
    }

    this.sequenceNumber++;
    const timestamp = new Date().toISOString();
    const recordHash = this.computeRecordHash(this.lastHash, this.sequenceNumber, timestamp, actor, action, payload);

    const record: CryptographicAuditRecord = {
      sequenceNumber: this.sequenceNumber,
      timestamp,
      actor,
      action,
      payload,
      previousHash: this.lastHash,
      recordHash
    };

    fs.appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
    this.lastHash = recordHash;
    return record;
  }

  public verifyChain(): { valid: boolean; recordsCount: number; error?: string } {
    try {
      this.initializeChain();
      return { valid: true, recordsCount: this.sequenceNumber };
    } catch (err: any) {
      return { valid: false, recordsCount: this.sequenceNumber, error: err.message };
    }
  }

  public acquireBarrier(): { current_sequence: number; current_hash: string } {
    this.isLocked = true;
    return {
      current_sequence: this.sequenceNumber,
      current_hash: this.lastHash
    };
  }

  public releaseBarrier(): void {
    this.isLocked = false;
  }

  public getHead(): { sequenceNumber: number; lastHash: string; isLocked: boolean } {
    return {
      sequenceNumber: this.sequenceNumber,
      lastHash: this.lastHash,
      isLocked: this.isLocked
    };
  }

  public startHttpServer(port = 3002): http.Server {
    const server = http.createServer((req, res) => {
      const url = req.url || "/";
      const method = req.method || "GET";

      if (url === "/health" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", service: "nexus-audit-anchor", head: this.getHead() }));
      }

      if (url === "/verify" && method === "GET") {
        const result = this.verifyChain();
        res.writeHead(result.valid ? 200 : 409, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(result));
      }

      if (url === "/barrier" && method === "POST") {
        const barrier = this.acquireBarrier();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(barrier));
      }

      if (url === "/release" && method === "POST") {
        this.releaseBarrier();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "released" }));
      }

      if (url === "/record" && method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            const rec = this.recordEvent(data.actor || "system", data.action || "generic", data.payload || {});
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(rec));
          } catch (err: any) {
            const status = this.isLocked ? 423 : 400;
            res.writeHead(status, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not found" }));
    });

    server.listen(port, "127.0.0.1");
    return server;
  }
}
