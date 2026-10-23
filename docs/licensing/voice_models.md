# Project NEXUS — Voice Models Licensing & Isolation Architecture

## 1. Overview
Project NEXUS provides a 100% offline push-to-talk voice pipeline adhering strictly to open-source software and open-weight model licensing boundaries.

## 2. Voice Pipeline Architecture
```
[Microphone] ──(Web Audio 16kHz)──► [Whisper.cpp (MIT, CPU)] ──► [Chat Gateway]
                                                                        │
[Speaker Output] ◄──(Pipe I/O)─── [Piper TTS (GPL-3.0+ Isolated)] ◄─────┘
```

## 3. GPL-3.0+ Isolation Contract
1. **Subprocess Boundary:** Piper runs out-of-process via standard OS streams (`stdin` input text, `stdout` PCM audio).
2. **License Containment:** The main TypeScript / Fastify application links only against standard runtime libraries. No GPL code is compiled into or distributed within NEXUS core packages.
3. **Model License Auditing:** Default voice model checkpoints (e.g. `en_US-lessac-medium.onnx`) are released under Creative Commons or Open Data licenses as documented in each model repository manifest.
