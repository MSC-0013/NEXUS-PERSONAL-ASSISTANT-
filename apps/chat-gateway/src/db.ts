import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { DatabaseSync } from "node:sqlite";

export const FULL_NEXUS_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;

-- 1. Conversation Sessions
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model_identifier TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 2. Message History
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT CHECK(role IN ('system', 'user', 'assistant', 'tool')) NOT NULL,
    content TEXT NOT NULL,
    tool_calls_json TEXT,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at_epoch);

-- 3. Explicit Semantic Personal Memory
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    category TEXT CHECK(category IN ('preference', 'project', 'tech_stack', 'rule')) NOT NULL,
    content TEXT NOT NULL,
    source_message_id TEXT,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

-- 4. Document Ingestion Metadata
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT CHECK(status IN ('pending', 'indexed', 'failed')) NOT NULL,
    indexed_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 5. Document Chunks with Stable Integer Primary Key for FTS5
CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);

-- 6. External-Content FTS5 Virtual Table
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    content,
    content='document_chunks',
    content_rowid='chunk_pk'
);

-- 7. Persistent FTS5 secure-delete Configuration
INSERT INTO document_chunks_fts(document_chunks_fts, rank) VALUES ('secure-delete', 1);

-- 8. Full Synchronization Triggers
CREATE TRIGGER IF NOT EXISTS trig_chunks_ai AFTER INSERT ON document_chunks BEGIN
    INSERT INTO document_chunks_fts(rowid, content) VALUES (new.chunk_pk, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trig_chunks_ad AFTER DELETE ON document_chunks BEGIN
    INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content) VALUES('delete', old.chunk_pk, old.content);
END;

CREATE TRIGGER IF NOT EXISTS trig_chunks_au AFTER UPDATE ON document_chunks BEGIN
    INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content) VALUES('delete', old.chunk_pk, old.content);
    INSERT INTO document_chunks_fts(rowid, content) VALUES (new.chunk_pk, new.content);
END;

-- 9. Persistent Agent Tasks
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT CHECK(status IN ('QUEUED', 'PLANNING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'EXPIRED')) NOT NULL,
    iteration_count INTEGER DEFAULT 0,
    max_iterations INTEGER DEFAULT 8,
    terminal_reason TEXT,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- 10. Ordered Task Steps
CREATE TABLE IF NOT EXISTS task_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed')) NOT NULL,
    plan_json TEXT,
    expected_result TEXT,
    actual_result TEXT,
    started_at_epoch INTEGER,
    completed_at_epoch INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(task_id, step_number)
);
CREATE INDEX IF NOT EXISTS idx_task_steps_order ON task_steps(task_id, step_number);

-- 11. Tool Execution Logs
CREATE TABLE IF NOT EXISTS tool_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_id TEXT,
    tool_name TEXT NOT NULL,
    input_args_json TEXT NOT NULL,
    output_result_json TEXT,
    status TEXT CHECK(status IN ('success', 'failure', 'rejected')) NOT NULL,
    duration_ms INTEGER,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (step_id) REFERENCES task_steps(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_runs_task ON tool_runs(task_id);

-- 12. Transactional Approval Gate with Replay Prevention & Execution Tracking
CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    tool_run_id TEXT,
    tool_name TEXT NOT NULL,
    target_resource TEXT NOT NULL,
    normalized_action_json TEXT NOT NULL,
    pre_state_hash TEXT NOT NULL,
    post_state_expected_hash TEXT NOT NULL,
    proposed_diff_text TEXT,
    session_id TEXT NOT NULL,
    execution_id TEXT UNIQUE,
    status TEXT CHECK(status IN ('pending', 'approved', 'executing', 'completed', 'rejected', 'expired', 'failed', 'recovery_required')) NOT NULL,
    expires_at_epoch INTEGER NOT NULL,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    decided_at_epoch INTEGER,
    completed_at_epoch INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (tool_run_id) REFERENCES tool_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_lookup ON approval_requests(status, expires_at_epoch);

-- 13. Tamper-Evident Audit Chain with Anchor Tracking
CREATE TABLE IF NOT EXISTS audit_events (
    sequence_num INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    task_id TEXT,
    tool_name TEXT,
    details_json TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    prev_hash TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    anchor_status TEXT CHECK(anchor_status IN ('pending_anchor', 'anchored', 'failed')) NOT NULL DEFAULT 'pending_anchor'
);
CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_events(sequence_num);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type, created_at_epoch);

-- 14. Persistent Scheduled Jobs
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    schedule_cron TEXT,
    next_run_epoch INTEGER NOT NULL,
    last_run_epoch INTEGER,
    last_outcome TEXT CHECK(last_outcome IN ('success', 'failure', 'skipped', NULL)),
    failure_count INTEGER DEFAULT 0,
    missed_run_policy TEXT CHECK(missed_run_policy IN ('run_once', 'skip', 'notify')) NOT NULL,
    enabled BOOLEAN DEFAULT 1,
    created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_jobs_next ON scheduled_jobs(enabled, next_run_epoch);

-- 15. Scheduler Lease Ledger
CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    scheduled_for_epoch INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    claimed_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    lease_expires_epoch INTEGER NOT NULL,
    heartbeat_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
    attempt_count INTEGER DEFAULT 1,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT CHECK(status IN ('claimed', 'running', 'completed', 'failed', 'stale_recovered', 'skipped')) NOT NULL,
    outcome_json TEXT,
    last_error TEXT,
    completed_at_epoch INTEGER,
    FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id) ON DELETE RESTRICT,
    UNIQUE(job_id, scheduled_for_epoch)
);
CREATE INDEX IF NOT EXISTS idx_job_runs_lookup ON job_runs(job_id, scheduled_for_epoch);
CREATE INDEX IF NOT EXISTS idx_job_runs_lease ON job_runs(status, lease_expires_epoch);
`;

export class NexusDatabase {
  public db: DatabaseSync;
  public dbPath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.dbPath = customPath;
    } else {
      const dataDir = path.join(process.cwd(), "data", "database");
      fs.mkdirSync(dataDir, { recursive: true });
      this.dbPath = path.join(dataDir, "nexus.sqlite");
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(FULL_NEXUS_SCHEMA);
  }

  public getJournalMode(): string {
    const res = this.db.prepare("PRAGMA journal_mode;").get() as any;
    return res ? res.journal_mode : "";
  }

  public getSecureDelete(): number {
    const res = this.db.prepare("PRAGMA secure_delete;").get() as any;
    return res ? res.secure_delete : 0;
  }

  public createConversation(id: string, title: string, model: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO conversations (id, title, model_identifier, created_at_epoch, updated_at_epoch)
      VALUES (?, ?, ?, unixepoch(), unixepoch())
    `);
    stmt.run(id, title, model);
  }

  public addMessage(id: string, conversationId: string, role: string, content: string, toolCallsJson?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, tool_calls_json, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, unixepoch())
    `);
    stmt.run(id, conversationId, role, content, toolCallsJson || null);
  }

  public getMessages(conversationId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at_epoch ASC
    `);
    return stmt.all(conversationId) as any[];
  }

  // Personal Semantic Memory CRUD
  public addMemory(id: string, category: "preference" | "project" | "tech_stack" | "rule", content: string, sourceMessageId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, category, content, source_message_id, created_at_epoch, updated_at_epoch)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    `);
    stmt.run(id, category, content, sourceMessageId || null);
  }

  public getMemories(category?: string): any[] {
    if (category) {
      const stmt = this.db.prepare("SELECT * FROM memories WHERE category = ? ORDER BY created_at_epoch DESC");
      return stmt.all(category) as any[];
    }
    const stmt = this.db.prepare("SELECT * FROM memories ORDER BY created_at_epoch DESC");
    return stmt.all() as any[];
  }

  public deleteMemory(id: string): void {
    const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
    stmt.run(id);
  }

  // Document Ingestion & Chunking
  public ingestDocument(id: string, filename: string, filepath: string, content: string, chunks: { id: string; chunkIndex: number; content: string; tokenCount: number }[]): void {
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    const docStmt = this.db.prepare(`
      INSERT INTO documents (id, filename, filepath, content_hash, mime_type, size_bytes, status, indexed_at_epoch)
      VALUES (?, ?, ?, ?, 'text/markdown', ?, 'indexed', unixepoch())
    `);
    docStmt.run(id, filename, filepath, contentHash, Buffer.byteLength(content, "utf-8"));

    const chunkStmt = this.db.prepare(`
      INSERT INTO document_chunks (id, document_id, chunk_index, content, token_count)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      chunkStmt.run(chunk.id, id, chunk.chunkIndex, chunk.content, chunk.tokenCount);
    }
  }

  // FTS5 Full-Text Search
  public searchFTS(query: string, limit = 5): any[] {
    const stmt = this.db.prepare(`
      SELECT d.filepath, c.chunk_index, c.content, f.rank
      FROM document_chunks_fts f
      JOIN document_chunks c ON f.rowid = c.chunk_pk
      JOIN documents d ON c.document_id = d.id
      WHERE document_chunks_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `);
    return stmt.all(query, limit) as any[];
  }

  public updateChunkContent(chunkId: string, newContent: string): void {
    const stmt = this.db.prepare("UPDATE document_chunks SET content = ? WHERE id = ?");
    stmt.run(newContent, chunkId);
  }

  public deleteDocument(documentId: string): void {
    const stmt = this.db.prepare("DELETE FROM documents WHERE id = ?");
    stmt.run(documentId);
  }

  public rebuildFTS(): void {
    this.db.exec("INSERT INTO document_chunks_fts(document_chunks_fts) VALUES('rebuild');");
  }

  public checkpointTruncate(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  public close(): void {
    this.db.close();
  }
}

