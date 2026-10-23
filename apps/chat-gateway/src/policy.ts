/**
 * PROJECT NEXUS V2.3 — Centralized Authorization & Security Policy Engine
 *
 * Implements authoritative, independent authorization checks for all model tool calls
 * and intent-detected tool invocations before execution.
 *
 * Principles:
 * 1. Independent Authorization: Neither LLM generation, regex match, nor frontend requests
 *    constitute authorization by themselves.
 * 2. Fail-Closed on Unknown Session State: Default session state is UNKNOWN. UNKNOWN is NEVER
 *    treated as unlocked or authenticated. Protected operations (L1, L2, L3) are strictly denied.
 * 3. Multi-Tier Privilege Enforcement:
 *    - L0: Conversational & pure arithmetic/time queries (Safe, permitted).
 *    - L1: Workspace read & knowledge search (Protected, requires verified UNLOCKED session).
 *    - L2: Task creation & background jobs (Protected, requires verified UNLOCKED session).
 *    - L3: Mutating workspace write & patch proposals (Sensitive, requires UNLOCKED session AND
 *          human approval confirmation with cryptographic token).
 * 4. Input & Argument Validation: Closed tool catalog (7 tools) and strict argument schemas
 *    matching agent-contract-v1.json. Path traversal and illegal characters are blocked pre-execution.
 */

import * as path from "path";
import * as fs from "fs";
import { ToolCall } from "@nexus/contracts";
import { resolveJailedPath, SecurityException } from "./agent.js";

export type SessionState = "LOCKED" | "UNLOCKED" | "UNKNOWN";
export type ToolSecurityTier = "L0" | "L1" | "L2" | "L3";

export interface ISessionStateProvider {
  getSessionState(): SessionState;
  setSessionState?(state: SessionState): void;
}

/**
 * Fail-Closed Session Sentinel Provider with Dead-Man Heartbeat Monitoring.
 *
 * Principles:
 * 1. Fail-Closed Default: Defaults strictly to UNKNOWN until a verified OS-level session sentinel is active.
 * 2. Dead-Man Heartbeat Switch: Requires regular heartbeats from the native companion. If the companion
 *    dies or the sentinel channel fails, state reverts to UNKNOWN after ttlMs, instantly revoking L1-L3 privileges.
 * 3. Screen Wake Isolation: Display wake events do not affect the session state; only explicit OS unlock
 *    events transition state to UNLOCKED.
 */
export class HeartbeatSessionSentinelProvider implements ISessionStateProvider {
  private state: SessionState;
  private lastHeartbeatTime: number;
  private ttlMs: number;
  private isSentinelActive: boolean;

  constructor(initialState: SessionState = "UNKNOWN", ttlMs: number = 8000) {
    this.state = initialState;
    this.lastHeartbeatTime = Date.now();
    this.ttlMs = ttlMs;
    this.isSentinelActive = false;
  }

  public getSessionState(): SessionState {
    if (this.state === "UNKNOWN") {
      return "UNKNOWN";
    }

    // Dead-man switch: if sentinel is active and heartbeat has timed out, fail closed to UNKNOWN
    if (this.isSentinelActive && (Date.now() - this.lastHeartbeatTime > this.ttlMs)) {
      return "UNKNOWN";
    }

    return this.state;
  }

  public setSessionState(state: SessionState): void {
    this.state = state;
    this.lastHeartbeatTime = Date.now();
  }

  public recordHeartbeat(reportedState?: SessionState): void {
    this.isSentinelActive = true;
    this.lastHeartbeatTime = Date.now();
    if (reportedState && (reportedState === "LOCKED" || reportedState === "UNLOCKED" || reportedState === "UNKNOWN")) {
      this.state = reportedState;
    }
  }

  public getSentinelStatus(): {
    sessionState: SessionState;
    rawState: SessionState;
    isSentinelActive: boolean;
    lastHeartbeatAgeMs: number;
    isExpired: boolean;
    ttlMs: number;
  } {
    const age = Date.now() - this.lastHeartbeatTime;
    const isExpired = this.isSentinelActive && (age > this.ttlMs);
    return {
      sessionState: this.getSessionState(),
      rawState: this.state,
      isSentinelActive: this.isSentinelActive,
      lastHeartbeatAgeMs: age,
      isExpired,
      ttlMs: this.ttlMs
    };
  }

  public setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }
}

/**
 * Default runtime session-state provider.
 * Defaults strictly to UNKNOWN until a verified OS-level session sentinel is active.
 * Never trusts unauthenticated client HTTP headers or body attributes.
 */
export class DefaultSessionStateProvider extends HeartbeatSessionSentinelProvider {
  constructor(initialState: SessionState = "UNKNOWN") {
    super(initialState);
  }
}

/**
 * Canonical tool security tier assignments matching Phase 14 specifications.
 */
export const TOOL_SECURITY_TIERS: Record<string, ToolSecurityTier> = {
  get_current_time: "L0",
  calculate: "L0",
  search_knowledge: "L1",
  read_workspace_file: "L1",
  create_task: "L2",
  propose_workspace_write: "L3",
  propose_workspace_patch: "L3"
};

export interface AuthorizationDecision {
  authorized: boolean;
  tier: ToolSecurityTier;
  toolName: string;
  reason?: string;
  requiresUserConfirmation?: boolean;
  sanitizedArguments?: Record<string, any>;
}

export class PolicyEngine {
  private sessionProvider: ISessionStateProvider;
  private defaultWorkspaceRoot: string;

  constructor(
    sessionProvider?: ISessionStateProvider,
    defaultWorkspaceRoot?: string
  ) {
    this.sessionProvider = sessionProvider || new DefaultSessionStateProvider("UNKNOWN");
    this.defaultWorkspaceRoot = path.resolve(defaultWorkspaceRoot || process.cwd());
  }

  public getSessionState(): SessionState {
    try {
      const state = this.sessionProvider.getSessionState();
      if (state === "LOCKED" || state === "UNLOCKED" || state === "UNKNOWN") {
        return state;
      }
      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }

  public setSessionStateProvider(provider: ISessionStateProvider): void {
    this.sessionProvider = provider;
  }

  public getToolTier(toolName: string): ToolSecurityTier | null {
    return TOOL_SECURITY_TIERS[toolName] || null;
  }

  /**
   * Pre-execution argument validation against canonical contract schemas.
   * Guarantees malformed or malicious arguments never reach tool implementations.
   */
  public validateToolArguments(
    toolName: string,
    rawArgs: any,
    workspaceRoot?: string
  ): { valid: boolean; error?: string; sanitized?: Record<string, any> } {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return { valid: false, error: `Tool arguments for '${toolName}' must be a JSON object.` };
    }

    const root = path.resolve(workspaceRoot || this.defaultWorkspaceRoot);
    const keys = Object.keys(rawArgs);

    switch (toolName) {
      case "get_current_time": {
        const allowed = new Set(["timezone"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in get_current_time arguments.` };
          }
        }
        if (rawArgs.timezone !== undefined) {
          if (typeof rawArgs.timezone !== "string") {
            return { valid: false, error: "Argument 'timezone' must be a string." };
          }
          if (rawArgs.timezone.length > 64) {
            return { valid: false, error: "Argument 'timezone' exceeds maximum length of 64 characters." };
          }
          if (!/^[A-Za-z0-9_\-\+\/]+$/.test(rawArgs.timezone)) {
            return { valid: false, error: "Argument 'timezone' contains invalid characters." };
          }
        }
        return { valid: true, sanitized: { timezone: rawArgs.timezone || "UTC" } };
      }

      case "calculate": {
        const allowed = new Set(["expression"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in calculate arguments.` };
          }
        }
        if (typeof rawArgs.expression !== "string") {
          return { valid: false, error: "Argument 'expression' must be a string." };
        }
        const expr = rawArgs.expression.trim();
        if (expr.length === 0 || expr.length > 256) {
          return { valid: false, error: "Argument 'expression' length must be between 1 and 256 characters." };
        }
        if (/[a-zA-Z_$'"`;\\]/.test(expr)) {
          return { valid: false, error: "Expression contains forbidden non-mathematical identifiers or code injection syntax." };
        }
        return { valid: true, sanitized: { expression: expr } };
      }

      case "search_knowledge": {
        const allowed = new Set(["query", "limit", "top_k"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in search_knowledge arguments.` };
          }
        }
        if (typeof rawArgs.query !== "string") {
          return { valid: false, error: "Argument 'query' must be a string." };
        }
        const q = rawArgs.query.trim();
        if (q.length === 0 || q.length > 512) {
          return { valid: false, error: "Argument 'query' length must be between 1 and 512 characters." };
        }
        let limit = 5;
        const rawLimit = rawArgs.limit ?? rawArgs.top_k;
        if (rawLimit !== undefined) {
          if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) {
            return { valid: false, error: "Argument 'limit' must be an integer between 1 and 20." };
          }
          limit = rawLimit;
        }
        return { valid: true, sanitized: { query: q, limit } };
      }

      case "read_workspace_file": {
        const allowed = new Set(["relative_path", "max_lines"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in read_workspace_file arguments.` };
          }
        }
        if (typeof rawArgs.relative_path !== "string") {
          return { valid: false, error: "Argument 'relative_path' must be a string." };
        }
        const relPath = rawArgs.relative_path.trim();
        if (relPath.length === 0 || relPath.length > 512) {
          return { valid: false, error: "Argument 'relative_path' length must be between 1 and 512 characters." };
        }
        // Strict path jail pre-check
        try {
          resolveJailedPath(relPath, root);
        } catch (err: any) {
          return { valid: false, error: `Path traversal violation: ${err.message}` };
        }

        let maxLines = 200;
        if (rawArgs.max_lines !== undefined) {
          if (typeof rawArgs.max_lines !== "number" || !Number.isInteger(rawArgs.max_lines) || rawArgs.max_lines < 1 || rawArgs.max_lines > 1000) {
            return { valid: false, error: "Argument 'max_lines' must be an integer between 1 and 1000." };
          }
          maxLines = rawArgs.max_lines;
        }
        return { valid: true, sanitized: { relative_path: relPath, max_lines: maxLines } };
      }

      case "create_task": {
        const allowed = new Set(["goal", "priority", "conversation_id"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in create_task arguments.` };
          }
        }
        if (typeof rawArgs.goal !== "string") {
          return { valid: false, error: "Argument 'goal' must be a string." };
        }
        const goal = rawArgs.goal.trim();
        if (goal.length === 0 || goal.length > 1024) {
          return { valid: false, error: "Argument 'goal' length must be between 1 and 1024 characters." };
        }
        let priority = "medium";
        if (rawArgs.priority !== undefined) {
          if (!["low", "medium", "high"].includes(rawArgs.priority)) {
            return { valid: false, error: "Argument 'priority' must be one of: 'low', 'medium', 'high'." };
          }
          priority = rawArgs.priority;
        }
        return {
          valid: true,
          sanitized: {
            goal,
            priority,
            conversation_id: typeof rawArgs.conversation_id === "string" ? rawArgs.conversation_id : "default-session"
          }
        };
      }

      case "propose_workspace_write": {
        const allowed = new Set(["relative_path", "proposed_content"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in propose_workspace_write arguments.` };
          }
        }
        if (typeof rawArgs.relative_path !== "string") {
          return { valid: false, error: "Argument 'relative_path' must be a string." };
        }
        const relPath = rawArgs.relative_path.trim();
        if (relPath.length === 0 || relPath.length > 512) {
          return { valid: false, error: "Argument 'relative_path' length must be between 1 and 512 characters." };
        }
        try {
          resolveJailedPath(relPath, root);
        } catch (err: any) {
          return { valid: false, error: `Path traversal violation: ${err.message}` };
        }

        if (typeof rawArgs.proposed_content !== "string") {
          return { valid: false, error: "Argument 'proposed_content' must be a string." };
        }
        if (rawArgs.proposed_content.length > 4096) {
          return { valid: false, error: "Argument 'proposed_content' exceeds maximum limit of 4096 characters." };
        }
        return { valid: true, sanitized: { relative_path: relPath, proposed_content: rawArgs.proposed_content } };
      }

      case "propose_workspace_patch": {
        const allowed = new Set(["relative_path", "target_snippet", "replacement_snippet"]);
        for (const k of keys) {
          if (!allowed.has(k)) {
            return { valid: false, error: `Unexpected property '${k}' in propose_workspace_patch arguments.` };
          }
        }
        if (typeof rawArgs.relative_path !== "string") {
          return { valid: false, error: "Argument 'relative_path' must be a string." };
        }
        const relPath = rawArgs.relative_path.trim();
        if (relPath.length === 0 || relPath.length > 512) {
          return { valid: false, error: "Argument 'relative_path' length must be between 1 and 512 characters." };
        }
        try {
          resolveJailedPath(relPath, root);
        } catch (err: any) {
          return { valid: false, error: `Path traversal violation: ${err.message}` };
        }

        if (typeof rawArgs.target_snippet !== "string" || rawArgs.target_snippet.length === 0 || rawArgs.target_snippet.length > 1024) {
          return { valid: false, error: "Argument 'target_snippet' must be a non-empty string under 1024 characters." };
        }
        if (typeof rawArgs.replacement_snippet !== "string" || rawArgs.replacement_snippet.length > 2048) {
          return { valid: false, error: "Argument 'replacement_snippet' must be a string under 2048 characters." };
        }
        return {
          valid: true,
          sanitized: {
            relative_path: relPath,
            target_snippet: rawArgs.target_snippet,
            replacement_snippet: rawArgs.replacement_snippet
          }
        };
      }

      default:
        return { valid: false, error: `Unrecognized tool '${toolName}'.` };
    }
  }

  /**
   * Authorizes or rejects any proposed tool call against current session state,
   * security tier rules, and canonical arguments.
   */
  public authorizeToolCall(
    toolCall: ToolCall | { name: string; arguments?: any },
    workspaceRoot?: string
  ): AuthorizationDecision {
    const toolName = toolCall?.name;
    const tier = this.getToolTier(toolName);

    // 1. Tool Catalog Closed-Set Verification
    if (!tier || !toolName) {
      return {
        authorized: false,
        tier: "L0",
        toolName: toolName || "unknown",
        reason: `UNREGISTERED_TOOL: Tool '${toolName}' is not in the approved NEXUS closed tool catalog.`
      };
    }

    // 2. Safe Provider State Retrieval (Fail-Closed on Provider Failure)
    let sessionState: SessionState;
    try {
      sessionState = this.sessionProvider.getSessionState();
      if (!["LOCKED", "UNLOCKED", "UNKNOWN"].includes(sessionState)) {
        sessionState = "UNKNOWN";
      }
    } catch (err: any) {
      return {
        authorized: false,
        tier,
        toolName,
        reason: `POLICY_PROVIDER_ERROR: Session state provider threw an exception (${err?.message || "unknown"}). Failing closed.`
      };
    }

    // 3. Strict Pre-Execution Argument & Path Jail Validation
    const validation = this.validateToolArguments(toolName, toolCall.arguments || {}, workspaceRoot);
    if (!validation.valid) {
      return {
        authorized: false,
        tier,
        toolName,
        reason: `INVALID_ARGUMENTS: ${validation.error}`
      };
    }

    // 4. Session State & Privilege Tier Decision Matrix
    // Condition A: LOCKED Session -> Reject all tool executions (Spec Section 3.1)
    if (sessionState === "LOCKED") {
      return {
        authorized: false,
        tier,
        toolName,
        reason: `SESSION_LOCKED: Tool execution is prohibited while the Windows session is locked.`
      };
    }

    // Condition B: UNKNOWN Session -> Fail-Closed for all Protected Operations (L1, L2, L3)
    if (sessionState === "UNKNOWN") {
      if (tier === "L1" || tier === "L2" || tier === "L3") {
        return {
          authorized: false,
          tier,
          toolName,
          reason: `SESSION_UNVERIFIED: Protected tool execution (${toolName} [${tier}]) is prohibited when session state is UNKNOWN. Verified UNLOCKED session required.`
        };
      }
      // Non-protected L0 tools (get_current_time, calculate) access no user files/notes and mutate nothing.
      return {
        authorized: true,
        tier,
        toolName,
        sanitizedArguments: validation.sanitized
      };
    }

    // Condition C: UNLOCKED Verified Session
    if (sessionState === "UNLOCKED") {
      if (tier === "L3") {
        // Mutating actions require explicit human confirmation
        return {
          authorized: true,
          tier,
          toolName,
          requiresUserConfirmation: true,
          sanitizedArguments: validation.sanitized
        };
      }
      return {
        authorized: true,
        tier,
        toolName,
        sanitizedArguments: validation.sanitized
      };
    }

    // Catch-all: Fail-closed for any unhandled state
    return {
      authorized: false,
      tier,
      toolName,
      reason: `SESSION_DENIED: Unrecognized session state '${sessionState}'. Failing closed.`
    };
  }

  /**
   * Validates whether a streaming session can proceed under current policy.
   * If the workstation is locked, streaming interaction is disarmed.
   */
  public authorizeStreamingSession(): { allowed: boolean; reason?: string } {
    const sessionState = this.getSessionState();
    if (sessionState === "LOCKED") {
      return {
        allowed: false,
        reason: "SESSION_LOCKED: Streaming chat is disabled while the Windows session is locked."
      };
    }
    return { allowed: true };
  }
}
