# Project NEXUS V2.3 — Open-Source Notices and Licensing Architecture

## 1. Project NEXUS License
Project NEXUS application core, gateway, contracts, schemas, and orchestration engines are licensed under the **Apache License, Version 2.0**.

## 2. Third-Party Component Licenses

### Speech-to-Text (STT) — Whisper.cpp
* **Source:** https://github.com/ggerganov/whisper.cpp
* **License:** MIT License
* **Usage:** Local CPU inference for audio transcription from 16 kHz 16-bit mono PCM.

### Text-to-Speech (TTS) — Piper TTS
* **Source:** `OHF-Voice/piper1-gpl` / `rhasspy/piper`
* **License:** GNU General Public License v3.0+ (GPL-3.0+)
* **Architectural Isolation Boundary:** To comply with GPL-3.0+ requirements without contaminating the Apache-2.0 codebase, Piper runs strictly as an independent containerized microservice or isolated external operating system subprocess communicating exclusively via stdin/stdout pipe streams. No proprietary or Apache-2.0 code links statically or dynamically into the Piper binary.

### Local LLM Inference — Ollama
* **Source:** https://github.com/ollama/ollama
* **License:** MIT License
* **Usage:** Sovereign local inference server running on host `127.0.0.1:11434`.

### Model Weights — Qwen 3.5 & LoRA Adapters
* **Architecture:** Qwen 3.5 (Alibaba Cloud)
* **License:** Apache License, Version 2.0
* **Usage:** Fine-tuned local LoRA checkpoint `nexus:0.8b` / `nexus:latest`.
