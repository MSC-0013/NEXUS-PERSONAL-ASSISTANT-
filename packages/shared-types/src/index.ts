/**
 * Project NEXUS V2.3 — Common DTOs, Audit Schemas, and Lease Types
 */

import { NexusModelOutput, AgentMessage } from "@nexus/contracts";

export interface EpochLease {
  resourceId: string;
  leaseId: string;
  holderId: string;
  expiresAt: string; // ISO 8601 UTC
  renewedAt: string; // ISO 8601 UTC
  epochNumber: number;
}

export interface CryptographicAuditRecord {
  sequenceNumber: number;
  timestamp: string; // ISO 8601 UTC
  actor: "user" | "agent" | "system";
  action: string;
  payload: Record<string, unknown>;
  previousHash: string;
  recordHash: string; // SHA-256(prevHash + seq + timestamp + payload)
  signature?: string;
}

export interface MemoryRecord {
  id: string;
  documentPath?: string;
  chunkIndex: number;
  content: string;
  embeddingVector?: number[]; // 768 or 384 dimensions
  tokenCount: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRecord {
  id: string;
  goal: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: "low" | "medium" | "high";
  resultSummary?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ChatGatewayRequest {
  sessionId?: string;
  messages: AgentMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatGatewayStreamChunk {
  id: string;
  delta: string;
  finishReason?: "stop" | "tool_call" | "length" | null;
  toolCall?: NexusModelOutput;
}

export interface ChatGatewayResponse {
  id: string;
  sessionId: string;
  message: AgentMessage;
  parsedOutput?: NexusModelOutput;
  tokensGenerated: number;
  latencyMs: number;
  tokPerSec: number;
}
