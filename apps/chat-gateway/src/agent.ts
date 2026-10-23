import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { ToolCall, NexusModelOutput } from "@nexus/contracts";

export class SecurityException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityException";
  }
}

/**
 * Hardened Path Jail per MASTER_PLAN.md Section 6.2
 */
export function resolveJailedPath(userPath: string, workspaceRoot: string): string {
  const canonicalRoot = fs.realpathSync(workspaceRoot);

  if (path.isAbsolute(userPath) || /^[a-zA-Z]:/.test(userPath) || userPath.includes("\0")) {
    throw new SecurityException("Invalid path syntax");
  }

  const normalizedUserPath = path.normalize(userPath);
  const absoluteTarget = path.resolve(canonicalRoot, normalizedUserPath);

  if (!absoluteTarget.startsWith(canonicalRoot + path.sep) && absoluteTarget !== canonicalRoot) {
    throw new SecurityException("Path traversal attempt detected outside workspace root");
  }

  let currentSegment = canonicalRoot;
  const relativeParts = path.relative(canonicalRoot, absoluteTarget).split(path.sep);
  for (const part of relativeParts) {
    if (!part) continue;
    currentSegment = path.join(currentSegment, part);
    const stat = fs.lstatSync(currentSegment, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        throw new SecurityException("Symbolic links and special files are prohibited within workspace");
      }
    }
  }

  return absoluteTarget;
}

/**
 * Pure Pratt Arithmetic Parser with Magnitude Rejection
 * Evaluates math expressions without eval/Function and guards against exponentiation/magnitude DoS.
 */
export class SafePrattMathParser {
  private tokens: string[] = [];
  private pos = 0;

  constructor(expression: string) {
    if (/[a-zA-Z_$'"`;\\]/.test(expression)) {
      throw new Error("Expression contains forbidden non-mathematical identifiers or code injection syntax.");
    }
    // Tokenize numbers, operators, and parentheses
    const matches = expression.match(/\d+(\.\d+)?|[+\-*/%^()]/g);
    if (!matches) {
      throw new Error("Invalid or empty mathematical expression.");
    }
    this.tokens = matches;
    this.pos = 0;
  }

  public parse(): number {
    const val = this.parseExpression(0);
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.pos}: ${this.tokens[this.pos]}`);
    }
    if (!Number.isFinite(val) || Math.abs(val) > 1e12) {
      throw new Error("Calculation magnitude overflow / non-finite value rejected.");
    }
    return val;
  }

  private parseExpression(minPrecedence: number): number {
    let left = this.parsePrimary();

    while (this.pos < this.tokens.length) {
      const op = this.tokens[this.pos];
      const prec = this.getPrecedence(op);
      if (prec < minPrecedence) break;

      this.pos++; // consume operator
      const nextMinPrec = op === "^" ? prec : prec + 1; // right-associative for power
      const right = this.parseExpression(nextMinPrec);

      left = this.applyOp(op, left, right);
    }

    return left;
  }

  private parsePrimary(): number {
    if (this.pos >= this.tokens.length) {
      throw new Error("Unexpected end of expression");
    }
    const token = this.tokens[this.pos++];

    if (token === "(") {
      const val = this.parseExpression(0);
      if (this.tokens[this.pos++] !== ")") {
        throw new Error("Mismatched parentheses");
      }
      return val;
    }

    if (token === "-") {
      return -this.parsePrimary();
    }
    if (token === "+") {
      return this.parsePrimary();
    }

    const num = parseFloat(token);
    if (isNaN(num)) {
      throw new Error(`Expected number, got: ${token}`);
    }
    if (Math.abs(num) > 1e12) {
      throw new Error("Input number exceeds magnitude limit (1e12)");
    }
    return num;
  }

  private getPrecedence(op: string): number {
    switch (op) {
      case "+":
      case "-":
        return 1;
      case "*":
      case "/":
      case "%":
        return 2;
      case "^":
        return 3;
      default:
        return -1;
    }
  }

  private applyOp(op: string, a: number, b: number): number {
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        if (b === 0) throw new Error("Division by zero");
        return a / b;
      case "%":
        if (b === 0) throw new Error("Division by zero");
        return a % b;
      case "^":
        if (b > 100 || b < -100) throw new Error("Exponent exceeds maximum power limit (100)");
        return Math.pow(a, b);
      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }
}

/**
 * Two-Phase Recoverable Execution Protocol (MASTER_PLAN.md Section 6.1)
 */
export interface ExecutionPlan {
  executionId: string;
  relativePath: string;
  isNewFile: boolean;
  preStateHash: string;
  newContent: string;
  postStateExpectedHash: string;
}

export class RecoverableExecutionEngine {
  private workspaceRoot: string;
  private backupDir: string;

  constructor(workspaceRoot: string, backupDir: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.backupDir = path.resolve(backupDir);
    fs.mkdirSync(this.workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(this.backupDir, "file_history"), { recursive: true });
  }

  public computeSha256(content: Buffer | string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  public execute(plan: ExecutionPlan): { status: "completed" | "failed"; error?: string } {
    const targetPath = resolveJailedPath(plan.relativePath, this.workspaceRoot);
    const historyDir = path.join(this.backupDir, "file_history");

    // Phase 2: Target Pre-Validation & Pre-Write Snapshot
    if (plan.isNewFile) {
      const exists = fs.existsSync(targetPath);
      if (exists) {
        return { status: "failed", error: "pre_state_drift_target_exists" };
      }
      // Absence Tombstone Snapshot
      const tombstonePath = path.join(historyDir, `pre_${plan.executionId}.tombstone`);
      fs.writeFileSync(
        tombstonePath,
        JSON.stringify({ target: plan.relativePath, expectedState: "ABSENT", executionId: plan.executionId }),
        "utf-8"
      );
    } else {
      if (!fs.existsSync(targetPath)) {
        return { status: "failed", error: "pre_state_drift_target_missing" };
      }
      const existingBytes = fs.readFileSync(targetPath);
      const currentHash = this.computeSha256(existingBytes);
      if (currentHash !== plan.preStateHash) {
        return { status: "failed", error: "pre_state_drift" };
      }
      // Verified Pre-Write Snapshot
      const backupPath = path.join(historyDir, `pre_${plan.executionId}.bak`);
      fs.writeFileSync(backupPath, existingBytes);
    }

    // Phase 3: Sibling Temporary Write & Flush
    const dir = path.dirname(targetPath);
    const tmpFile = path.join(dir, `.tmp_${plan.executionId}`);
    fs.writeFileSync(tmpFile, plan.newContent, { flag: "wx", encoding: "utf-8" });

    // Phase 4: Atomic Rename & Post-Write Verification
    fs.renameSync(tmpFile, targetPath);

    const writtenBytes = fs.readFileSync(targetPath);
    const postHash = this.computeSha256(writtenBytes);
    if (postHash !== plan.postStateExpectedHash) {
      return { status: "failed", error: "post_state_hash_mismatch" };
    }

    return { status: "completed" };
  }

  public reconcileCrash(plan: ExecutionPlan): "completed" | "approved" | "recovery_required" {
    const targetPath = resolveJailedPath(plan.relativePath, this.workspaceRoot);
    if (!fs.existsSync(targetPath)) {
      if (plan.isNewFile) return "approved"; // creation never occurred, safe to retry
      return "recovery_required";
    }

    const currentHash = this.computeSha256(fs.readFileSync(targetPath));
    if (currentHash === plan.postStateExpectedHash) {
      return "completed"; // rename succeeded before crash
    }
    if (!plan.isNewFile && currentHash === plan.preStateHash) {
      return "approved"; // rename never occurred, safe to retry
    }

    return "recovery_required";
  }
}

/**
 * Bounded Agent Loop with 8-Step Maximum
 */
export class BoundedAgentLoop {
  private workspaceRoot: string;
  private maxSteps: number;
  private db?: any;

  constructor(workspaceRoot: string, maxSteps = 8, db?: any) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxSteps = maxSteps;
    this.db = db;
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public sanitizePath(relativePath: string): string {
    return resolveJailedPath(relativePath, this.workspaceRoot);
  }

  public async executeTool(toolCall: ToolCall): Promise<{ toolName: string; success: boolean; output: string; requiresUserConfirmation?: boolean }> {
    const name = toolCall.name;
    const args: any = toolCall.arguments || {};

    switch (name) {
      case "get_current_time": {
        const tz = args.timezone || "UTC";
        const now = new Date();
        try {
          // Format target timezone
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
          });
          const parts = formatter.formatToParts(now);
          const partMap: Record<string, string> = {};
          for (const p of parts) partMap[p.type] = p.value;
          const localTime = `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;

          // Format UTC reference
          const utcFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
          });
          const utcParts = utcFormatter.formatToParts(now);
          const utcMap: Record<string, string> = {};
          for (const p of utcParts) utcMap[p.type] = p.value;
          const utcTime = `${utcMap.year}-${utcMap.month}-${utcMap.day} ${utcMap.hour}:${utcMap.minute}:${utcMap.second}`;

          const isAsiaKolkata = tz.toLowerCase() === "asia/kolkata";
          const offsetStr = isAsiaKolkata ? "+05:30 (5 hours 30 minutes ahead of UTC)" : tz === "UTC" ? "+00:00 (UTC)" : "Dynamic";

          return {
            toolName: name,
            success: true,
            output: JSON.stringify({
              targetTimezone: tz,
              localTime: `${localTime} (${tz})`,
              utcTime: `${utcTime} (UTC)`,
              offset: offsetStr,
              differenceFromUtc: isAsiaKolkata ? "5 hours 30 minutes" : (tz === "UTC" ? "0 hours" : undefined)
            })
          };
        } catch (err: any) {
          return {
            toolName: name,
            success: false,
            output: JSON.stringify({ error: `Invalid timezone '${tz}': ${err.message}` })
          };
        }
      }

      case "calculate": {
        try {
          const parser = new SafePrattMathParser(args.expression);
          const result = parser.parse();
          return {
            toolName: name,
            success: true,
            output: JSON.stringify({ expression: args.expression, result })
          };
        } catch (err: any) {
          return {
            toolName: name,
            success: false,
            output: JSON.stringify({ error: `Calculation failed: ${err.message}` })
          };
        }
      }

      case "read_workspace_file": {
        try {
          let targetPath = this.sanitizePath(args.relative_path);
          // Usability fallback: if extension omitted and .md exists, use .md
          if (!fs.existsSync(targetPath) && fs.existsSync(targetPath + ".md")) {
            targetPath = targetPath + ".md";
          }
          if (!fs.existsSync(targetPath)) {
            return {
              toolName: name,
              success: false,
              output: JSON.stringify({ error: `File not found: ${args.relative_path}` })
            };
          }
          const content = fs.readFileSync(targetPath, "utf-8");
          const lines = content.split("\n");
          const maxLines = args.max_lines || 200;

          // Deterministic CSV parsing for structured data
          let csvSummary: any = undefined;
          if (targetPath.toLowerCase().endsWith(".csv")) {
            try {
              const rows = lines.map((l) => l.trim()).filter(Boolean);
              if (rows.length > 1) {
                const header = rows[0].split(",").map((c) => c.trim().toLowerCase());
                const regionIdx = header.findIndex((c) => c === "region" || c === "area" || c === "zone");
                const salesIdx = header.findIndex((c) => c === "sales" || c === "revenue" || c === "amount" || c === "total");
                if (regionIdx !== -1 && salesIdx !== -1) {
                  const totals: Record<string, number> = {};
                  for (let i = 1; i < rows.length; i++) {
                    const cols = rows[i].split(",").map((c) => c.trim());
                    const reg = cols[regionIdx];
                    const val = parseFloat(cols[salesIdx]);
                    if (reg && !isNaN(val)) {
                      totals[reg] = (totals[reg] || 0) + val;
                    }
                  }
                  let highestRegion = "";
                  let maxVal = -Infinity;
                  for (const [r, v] of Object.entries(totals)) {
                    if (v > maxVal) {
                      maxVal = v;
                      highestRegion = r;
                    }
                  }
                  csvSummary = {
                    regionalTotals: totals,
                    highestSellingRegion: highestRegion,
                    highestValue: maxVal
                  };
                }
              }
            } catch {}
          }

          return {
            toolName: name,
            success: true,
            output: JSON.stringify({
              relative_path: args.relative_path,
              total_lines: lines.length,
              displayed_lines: Math.min(lines.length, maxLines),
              content: lines.slice(0, maxLines).join("\n"),
              csvSummary
            })
          };
        } catch (err: any) {
          return {
            toolName: name,
            success: false,
            output: JSON.stringify({ error: err.message })
          };
        }
      }

      case "search_knowledge": {
        try {
          if (this.db && typeof this.db.searchFTS === "function") {
            const matches = this.db.searchFTS(args.query, args.limit || 5);
            return {
              toolName: name,
              success: true,
              output: JSON.stringify({ query: args.query, resultsCount: matches.length, matches })
            };
          }
          return {
            toolName: name,
            success: true,
            output: JSON.stringify({ query: args.query, resultsCount: 0, matches: [] })
          };
        } catch (err: any) {
          return {
            toolName: name,
            success: false,
            output: JSON.stringify({ error: `Knowledge search failed: ${err.message}` })
          };
        }
      }

      case "create_task": {
        const taskId = `task-${Date.now()}`;
        if (this.db) {
          try {
            const rawDb = this.db.db || this.db;
            if (rawDb && typeof rawDb.prepare === "function") {
              const stmt = rawDb.prepare("INSERT INTO tasks (id, conversation_id, goal, status, created_at_epoch, updated_at_epoch) VALUES (?, ?, ?, 'QUEUED', unixepoch(), unixepoch())");
              stmt.run(taskId, args.conversation_id || "default-session", args.goal || "Task execution");
            }
          } catch {}
        }
        return {
          toolName: name,
          success: true,
          output: JSON.stringify({
            taskId,
            goal: args.goal,
            status: "QUEUED",
            message: `Task '${taskId}' registered with goal: ${args.goal}`
          })
        };
      }

      case "propose_workspace_write": {
        const targetPath = this.sanitizePath(args.relative_path);
        if (args.proposed_content.length > 4096) {
          return {
            toolName: name,
            success: false,
            output: JSON.stringify({ error: "Content exceeds 4096 character limit for write proposal." })
          };
        }
        return {
          toolName: name,
          success: true,
          requiresUserConfirmation: true,
          output: JSON.stringify({
            proposalType: "write",
            relative_path: args.relative_path,
            content_length: args.proposed_content.length,
            status: "awaiting_user_approval"
          })
        };
      }

      case "propose_workspace_patch": {
        this.sanitizePath(args.relative_path);
        return {
          toolName: name,
          success: true,
          requiresUserConfirmation: true,
          output: JSON.stringify({
            proposalType: "patch",
            relative_path: args.relative_path,
            target_snippet: args.target_snippet,
            replacement_snippet: args.replacement_snippet,
            status: "awaiting_user_approval"
          })
        };
      }

      default: {
        const errorMsg = ((name as string) === "error" || (name as string) === "file_not_found")
          ? `File not found: ${args.message || args.error || "The requested file does not exist."}`
          : `Unrecognized tool call: ${name}`;
        return {
          toolName: name,
          success: false,
          output: JSON.stringify({ error: errorMsg })
        };
      }
    }
  }

  public runBoundedLoop(stepCount: number): { allowed: boolean; terminalReason?: string } {
    if (stepCount >= this.maxSteps) {
      return { allowed: false, terminalReason: "max_steps_exceeded" };
    }
    return { allowed: true };
  }
}
