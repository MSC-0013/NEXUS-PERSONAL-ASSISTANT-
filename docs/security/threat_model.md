# Project NEXUS V2.3 — Windows Desktop Security Architecture & Threat Model

**Authoritative Specification:** MASTER_PLAN.md V2.3  
**Classification:** Sovereign Air-Gapped Local-First Personal AI Assistant  
**Author:** NEXUS Security & Systems Engineering  
**Status:** SIGNED OFF (Phase 12)  

---

## 1. System Architecture & Isolation Boundaries

Project NEXUS enforces strict multi-layered isolation across the host Windows 11 environment, local inference, and external network interfaces:

```
┌────────────────────────────────────────────────────────────────────────┐
│ HOST SYSTEM: Windows 11 (NTFS, RTX 4050 Laptop GPU, 16 GB RAM)        │
│                                                                        │
│  ┌───────────────────────┐             ┌────────────────────────────┐  │
│  │ Native Windows Ollama │             │ Fastify Chat Gateway       │  │
│  │ (127.0.0.1:11434)     │◄────────────┤ (127.0.0.1:3000)           │  │
│  │ Model Allowlist Only  │ HTTP Loopback│ - Schema Validation        │  │
│  │ Zero Public Expose    │             │ - 8-Step Bounded Loop      │  │
│  └───────────────────────┘             │ - Jailed File System       │  │
│                                        └─────────────┬──────────────┘  │
│                                                      │                 │
│                 ┌────────────────────────────────────┼─────────────┐   │
│                 ▼                                    ▼             │   │
│  ┌───────────────────────────────┐     ┌────────────────────────┐  │   │
│  │ Audit Anchor Sidecar          │     │ SQLite 3 Database      │  │   │
│  │ (127.0.0.1:3002)              │     │ (WAL Mode, Secure Del) │  │   │
│  │ - Exclusive HMAC-SHA256 Chain │     │ - 15 Strict Tables     │  │   │
│  │ - Fail-Closed Barrier Lock    │     │ - FTS5 Secure Delete   │  │   │
│  └───────────────────────────────┘     └────────────────────────┘  │   │
│                                                                        │
│  ┌───────────────────────────────┐     ┌────────────────────────┐  │   │
│  │ Desktop UI (Vite / React)     │     │ Workspace Jail Sandbox │  │   │
│  │ - Loopback Only               │     │ /data/workspace/       │  │   │
│  │ - 2D / 3D Avatar Fallback     │     │ (Zero Traversal)       │  │   │
│  └───────────────────────────────┘     └────────────────────────┘  │   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Vector Matrix & Empirical Defenses

| Threat Vector ID | Threat Description | Attack Surface | Implemented Technical Mitigation | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **TV-01** | Path Traversal Outside Workspace | File Read / Write Proposals (`read_workspace_file`, `propose_workspace_write`) | `resolveJailedPath()` validates canonical realpath against workspace root. Blocks `../`, absolute drive letters (`C:/`), null bytes (`\0`), symlinks, and sockets. | `tests/test_phase8_agent_security.mjs` (All attacks thrown as `SecurityException`). |
| **TV-02** | Arbitrary Shell & Remote Code Execution | Model Tool Invocations | Closed JSON tool schema (`agent-contract-v1.json`, `additionalProperties: false`). Pratt recursive descent math parser replacing `eval()`/`Function()`. Zero shell execution tools exist in the contract. | `tests/test_phase8_agent_security.mjs` (Pratt parser magnitude & operator rejection). |
| **TV-03** | Unauthorized Model Swapping / Cloud Leakage | Fastify API Gateway (`/api/chat`) | Model Allowlist Enforcement (`ALLOWED_MODELS`). Strict rejection of unapproved or cloud model tags with HTTP 400. Zero cloud network egress. | `tests/test_phase5_gateway.mjs` (Rejection of `unauthorized-cloud-gpt4` with HTTP 400). |
| **TV-04** | Prompt Injection / Hallucinated Tool Calls | LLM Generation Output | Deterministic JSON schema decoding (`format: "json"`). Closed tool argument schemas. Dual evaluation gate with 0 hallucinations on critical test partition. | Phase 3 Gate A/B evaluation report (100% schema validity, 0 critical violations). |
| **TV-05** | Audit Log Tampering & Repudiation | Forensic Event History | Append-only HMAC-SHA256 rolling hash chain sidecar (`AuditAnchor`). Quiescent barrier lock. Detection of arbitrary single-byte alteration, deletion, or truncation. | `tests/test_phase6_persistence_audit.mjs` (Single-byte modification detected and rejected). |
| **TV-06** | Data Remanence on Sensitive Deletions | SQLite Database Pages & WAL | `PRAGMA secure_delete = ON`, `PRAGMA journal_mode = WAL`, and active `PRAGMA wal_checkpoint(TRUNCATE)`. Zeroes disk blocks upon deletion. | `tests/test_phase7_rag_fts5.mjs` (Binary disk scan confirmed zero plain-text fragments). |
| **TV-07** | Scheduler Concurrency & Race Conditions | Background Leases (`job_runs`) | Atomic epoch leases with SHA-256 idempotency key and `UNIQUE(job_id, scheduled_for_epoch)`. Stale recovery on crash and sleep recovery policies. | `tests/test_phase11_scheduler.mjs` (Duplicate claims blocked; crashed leases recovered). |

---

## 3. Host Process Boundary & Security Boundary Sign-Off

1. **Loopback Binding Invariant:** All services (`ollama`, `chat-gateway`, `audit-anchor`, `desktop-ui`) bind strictly to host loopback (`127.0.0.1`). Public interface exposure (`0.0.0.0` to LAN/WAN) is blocked.
2. **Fail-Closed Execution Policy:** If the Audit Anchor sidecar is unreachable or locked during quiescent backup, mutating operations fail closed with HTTP 423 / 500.
3. **Approval Boundary:** All destructive workspace modifications (`propose_workspace_write`, `propose_workspace_patch`) require human user authorization with pre-state and post-state SHA-256 verification and pre-write backup snapshots.

**Gate 12 Status:** SIGNED OFF (All criteria verified).
