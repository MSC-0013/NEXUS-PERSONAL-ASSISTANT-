/**
 * Project NEXUS V2.3 — Authoritative Agent Tool Contracts
 * Strictly mirrors agent-contract-v1.json
 */

export interface GetCurrentTimeArgs {
  timezone?: string;
}

export interface CalculateArgs {
  expression: string;
}

export interface SearchKnowledgeArgs {
  query: string;
  top_k?: number;
}

export interface ReadWorkspaceFileArgs {
  relative_path: string;
  max_lines?: number;
}

export interface CreateTaskArgs {
  goal: string;
  priority?: "low" | "medium" | "high";
}

export interface ProposeWorkspaceWriteArgs {
  relative_path: string;
  proposed_content: string; // Max 4096 characters per contract
}

export interface ProposeWorkspacePatchArgs {
  relative_path: string;
  target_snippet: string;
  replacement_snippet: string;
}

export type ToolCall =
  | { kind: "tool_call"; name: "get_current_time"; arguments: GetCurrentTimeArgs }
  | { kind: "tool_call"; name: "calculate"; arguments: CalculateArgs }
  | { kind: "tool_call"; name: "search_knowledge"; arguments: SearchKnowledgeArgs }
  | { kind: "tool_call"; name: "read_workspace_file"; arguments: ReadWorkspaceFileArgs }
  | { kind: "tool_call"; name: "create_task"; arguments: CreateTaskArgs }
  | { kind: "tool_call"; name: "propose_workspace_write"; arguments: ProposeWorkspaceWriteArgs }
  | { kind: "tool_call"; name: "propose_workspace_patch"; arguments: ProposeWorkspacePatchArgs };

export interface FinalResponse {
  kind: "final";
  content: string;
}

export type NexusModelOutput = ToolCall | FinalResponse;

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface SessionState {
  sessionId: string;
  stepCount: number;
  maxSteps: number;
  isFinished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  timestamp: string;
  action: string;
  actor: "user" | "agent" | "system";
  details: Record<string, unknown>;
  hmacDigest?: string;
}
