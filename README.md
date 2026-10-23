# Project NEXUS V2.3 — Autonomous AI Personal Assistant

Project NEXUS is a sovereign, local-first personal assistant designed for private, deterministic execution on local hardware.

## Architecture
- **Inference Engine**: Native Ollama running `nexus:latest` (fine-tuned Qwen 3.5 architecture) on local NVIDIA RTX GPU.
- **API Gateway**: Fastify gateway on port 3000 providing ChatML orchestration, streaming SSE, and SQLite persistence.
- **Desktop UI**: React + Vite + Tailwind CSS interface inspired by modern, clean conversational design.
- **Agent Closed Tool Contract**:
  1. `get_current_time` (IANA timezone support, exact UTC offsets)
  2. `calculate` (Safe Pratt arithmetic parser with magnitude rejection)
  3. `search_knowledge` (SQLite FTS5 full-text knowledge search)
  4. `read_workspace_file` (Hardened path-jailed file reading & deterministic tabular CSV parsing)
  5. `create_task` (Autonomous task management)
  6. `propose_workspace_write` (Two-phase recoverable atomic file creation)
  7. `propose_workspace_patch` (Two-phase recoverable atomic file modification)

## Security Model
- All operations are strictly local; no cloud API dependencies.
- Untrusted content is contained and evaluated without executing injected instructions.
- File system access is strictly jailed to the project workspace root.
