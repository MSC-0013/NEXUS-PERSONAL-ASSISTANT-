# Project NEXUS: Phase 0 Hardware Profiling & Benchmark Report

**Date of Profiling:** 21 October 2026  
**Host Hardware:** Windows 11 Laptop  
**Dedicated GPU:** NVIDIA GeForce RTX 4050 Laptop GPU (Ada Lovelace, AD107, Compute Capability 8.9)  
**Dedicated VRAM:** 6,141 MiB (~6.0 GiB) GDDR6  
**Host System RAM:** 16,397,508 KB (~15.6 GiB total, 3.8 GiB available physical RAM at idle)  
**NVIDIA Driver:** 592.82 (Direct WDDM on Host, WSL2 Direct vGPU Passthrough active)  
**CUDA Version:** 13.1  
**WSL2 Environment:** Ubuntu 26.04 LTS (Kernel: Linux 6.6+, direct CUDA passthrough verified)  
**Inference Runtime:** Ollama (Windows native server on port 11434, direct CUDA 13.1 backend)  

---

## 1. Initial Hardware Baseline (Step 1)

### 1.1 Idle Telemetry (Measured via `nvidia-smi`)
```text
GPU: NVIDIA GeForce RTX 4050 Laptop GPU
Driver Version: 592.82
CUDA Version: 13.1
Display Active (Disp.A): Off (Internal display driven by integrated graphics adapter)
Initial VRAM Used: 0 MiB / 6141 MiB (100% of dedicated VRAM available for compute)
GPU Utilization: 0%
GPU Temperature at Idle: 49°C - 50°C
Power Draw at Idle: 7W - 8W (Cap: 30W - 35W)
```

### 1.2 WSL2 Direct Passthrough Verification
- Command: `wsl -d Ubuntu -e bash -c "nvidia-smi"`
- Result: Code 0
- Direct passthrough recognized GPU with Compute Capability 8.9 and 0 MiB used.

---

## 2. GPU Inference Baseline & Backend Verification (Step 2)

### 2.1 Backend Discovery Telemetry (Ollama Server Log)
```text
Library: CUDA
Compute Capability: 8.9 (NVIDIA Ada Lovelace Tensor Cores)
Driver: 13.1
Total VRAM Reported: 6.0 GiB
Available VRAM for Context/Weights: 5.8 GiB
Default Context Window allocated: 4,096 tokens
Flash Attention: Auto -> Enabled
Backend Library Loaded: C:\Users\HP\AppData\Local\Programs\Ollama\lib\ollama\cuda_v13\ggml-cuda.dll
```
*Verification:* Confirmed execution on **CUDA backend with Flash Attention enabled**. Zero fallback to Vulkan or CPU compute for the GPU-offloaded layers.

### 2.3 Model Loading & Heavy Baseline (`llama2:7b`)
- **Test Model:** `llama2:7b` (Q4_0, 3.8 GB on disk, 6.74B parameters)
- **VRAM Utilization under Load:** 5,105 MiB / 6,141 MiB
- **Active Layers Offloaded to CUDA0:** 28 of 33 layers
- **VRAM Buffer Breakdown:**
  - CUDA0 Model Buffer: 3,040.63 MiB
  - CUDA0 KV Cache: 1,792.00 MiB (4,096 cells, 32 layers, F16)
  - CUDA0 Compute Graph: 353.00 MiB
  - Total GPU Memory Allocated: 5,105 MiB
- **Peak GPU Temperature under Load:** 51°C

---

## 3. Candidate Model Inference Benchmarking (Step 3)

### 3.1 Standard Benchmark Parameters
All candidate models are evaluated under the strictly frozen runtime contract:
- **Context Window (`num_ctx`):** 4,096 tokens
- **Output Token Budget (`num_predict`):** 128 tokens
- **Temperature:** 0.2
- **Prompt:** Standardized 100-word concurrency explanation ("Explain the difference between synchronous and asynchronous execution in computer programming in 100 words.")
- **Test Protocol:** 1 Cold Run (cold model load + inference) followed by 5 consecutive Warm Runs under active Windows desktop workload.

---

### 3.2 Empirical Measurements: `qwen2.5:1.5b` (Cross-Family Baseline)
- **Model Tag:** `qwen2.5:1.5b` (Q4_K_M, 986 MB on disk, 1.54B parameters)
- **Ollama Engine:** Native Windows CUDA 13.1, Flash Attention Enabled

#### Cold Run Telemetry
- **Total Latency:** 29,998.80 ms
- **Cold TTFT:** 22,654.18 ms (Ollama reported `load_duration`: 22,364.00 ms)
- **Decode Throughput:** 133.39 tokens/sec
- **Prompt Evaluation:** 48 tokens in 254.05 ms (188.94 tokens/sec)
- **Peak VRAM Allocated:** 1,467.0 MiB / 6,141 MiB
- **Peak GPU Temperature:** 56.0°C

#### Five Consecutive Warm Runs (Active Laptop Desktop Workload)
| Warm Run # | TTFT (Client-side) | Server Decode Speed | Peak VRAM | Free VRAM | Peak Temp | Avail Sys RAM |
|---|---|---|---|---|---|---|
| **Run 1** | 350.97 ms | 118.20 tok/s | 1,467.0 MiB | 4,454.0 MiB | 57.0°C | 3.26 GB |
| **Run 2** | 394.71 ms | 116.22 tok/s | 1,467.0 MiB | 4,454.0 MiB | 57.0°C | 3.27 GB |
| **Run 3** | 328.83 ms | 126.25 tok/s | 1,467.0 MiB | 4,454.0 MiB | 57.0°C | 3.24 GB |
| **Run 4** | 352.86 ms | 127.66 tok/s | 1,467.0 MiB | 4,454.0 MiB | 58.0°C | 3.23 GB |
| **Run 5** | 388.23 ms | 135.18 tok/s | 1,467.0 MiB | 4,454.0 MiB | 58.0°C | 3.23 GB |

#### Warm Summary Statistics
- **Warm TTFT:** Min: **328.83 ms** | Median: **352.86 ms** | Max: **394.71 ms**
- **Decode Throughput:** Min: **116.22 tok/s** | Median: **126.25 tok/s** | Max: **135.18 tok/s**
- **VRAM Footprint:** **1,467.0 MiB** (Leaves **4,454.0 MiB safety headroom**, >4.4 GB free!)
- **Peak GPU Temperature:** **58.0°C** (Well within thermal envelope; fan noise minimal)
- **Performance Evaluation vs Route B Target:** The measured median decode throughput of **126.25 tokens/second** exceeds the $\ge 30\text{ tok/s}$ threshold by **420%**.

---

### 3.3 Empirical Measurements: `qwen3.5:2b-q4_K_M` (Primary Candidate)
- **Model Tag:** `qwen3.5:2b-q4_K_M`
- **Manifest SHA-256 Digest:** `1e2d21a4f03ab9e4a9c1976a4b7e88f21de61d65f2c5485d8fde8942be73f1e7`
- **Artifact Size on Disk:** `1,945,781,358` bytes (~1.81 GiB / 1.95 GB)
- **Quantization:** `Q4_K_M` (`gguf`, runner: `llamacpp`)
- **Exact Parameter Count:** `1,881,825,088` (1.9B)
- **Benchmark Artifact:** `benchmark_qwen3.5_2b-q4_K_M_20261021T055138Z.json`
- **Ollama Engine:** Native Windows CUDA 13.1, server version 0.40.6

#### Cold Run Telemetry
- **Total Latency:** 103,186.17 ms
- **Cold TTFT:** 103,186.17 ms (Ollama reported `load_duration`: 55,936.79 ms)
- **Decode Throughput:** 29.30 tokens/sec
- **Prompt Evaluation:** 29 tokens in 36,979.00 ms
- **Peak VRAM Allocated:** 2,297.0 MiB / 6,141 MiB
- **Peak GPU Temperature:** 58.0°C

#### Five Consecutive Warm Runs (Active Laptop Desktop Workload)
| Warm Run # | TTFT (Client-side) | Server Decode Speed | Peak VRAM | Free VRAM | Peak Temp | Avail Sys RAM |
|---|---|---|---|---|---|---|
| **Run 1** | 8,081.33 ms | 87.06 tok/s | 2,297.0 MiB | 3,624.0 MiB | 60.0°C | 3.25 GB |
| **Run 2** | 8,399.89 ms | 73.55 tok/s | 2,297.0 MiB | 3,624.0 MiB | 59.0°C | 2.96 GB |
| **Run 3** | 8,458.91 ms | 71.94 tok/s | 2,297.0 MiB | 3,624.0 MiB | 60.0°C | 2.83 GB |
| **Run 4** | 8,665.52 ms | 70.91 tok/s | 2,297.0 MiB | 3,624.0 MiB | 60.0°C | 3.13 GB |
| **Run 5** | 8,527.26 ms | 72.47 tok/s | 2,297.0 MiB | 3,624.0 MiB | 61.0°C | 3.12 GB |

#### Warm Summary Statistics
- **Warm TTFT:** Min: **8,081.33 ms** | Median: **8,458.91 ms** | Max: **8,665.52 ms**
- **Decode Throughput:** Min: **70.91 tok/s** | Median: **72.47 tok/s** | Max: **87.06 tok/s**
- **VRAM Footprint:** **2,297.0 MiB** (Leaves **3,624.0 MiB safety headroom**, >3.6 GB free!)
- **Peak GPU Temperature:** **61.0°C** (Stable thermal state)
- **Post-Unload Telemetry:** `0.0 MiB` allocated, `5,920.0 MiB` free (100% memory deallocation confirmed under `keep_alive=0`)
- **Verdict:** **PASS** (Exceeds $\ge 25\text{ tok/s}$ gate by 2.9x; well below $\le 3,500\text{ MiB}$ VRAM threshold).

---

### 3.4 Empirical Measurements: `qwen3.5:0.8b` (Fallback Candidate)
- **Model Tag:** `qwen3.5:0.8b`
- **Manifest SHA-256 Digest:** `de63045f29755d4721c09d54c9b45c2dadb644f4fd7d604d4cac90d96049971c`
- **Artifact Size on Disk:** `1,322,069,277` bytes (~1.23 GiB / 1.32 GB)
- **Quantization:** `Q8_0` (`gguf`, runner: `llamacpp`)
- **Exact Parameter Count:** `752,393,024` (752.4M)
- **Benchmark Artifact:** `benchmark_qwen3.5_0.8b_20261021T063257Z.json`
- **Ollama Engine:** Native Windows CUDA 13.1, server version 0.40.6

#### Cold Run Telemetry
- **Total Latency:** 22,398.85 ms
- **Cold TTFT:** 22,398.85 ms (Ollama reported `load_duration`: 10,960.34 ms)
- **Decode Throughput:** 94.94 tokens/sec
- **Prompt Evaluation:** 29 tokens in 263.38 ms
- **Peak VRAM Allocated:** 1,691.0 MiB / 6,141 MiB
- **Peak GPU Temperature:** 58.0°C

#### Five Consecutive Warm Runs (Active Laptop Desktop Workload)
| Warm Run # | TTFT (Client-side) | Server Decode Speed | Peak VRAM | Free VRAM | Peak Temp | Avail Sys RAM |
|---|---|---|---|---|---|---|
| **Run 1** | 6,410.91 ms | 101.77 tok/s | 1,691.0 MiB | 4,230.0 MiB | 59.0°C | 3.12 GB |
| **Run 2** | 5,881.46 ms | 108.60 tok/s | 1,691.0 MiB | 4,230.0 MiB | 60.0°C | 3.12 GB |
| **Run 3** | 5,935.04 ms | 107.72 tok/s | 1,691.0 MiB | 4,230.0 MiB | 61.0°C | 3.12 GB |
| **Run 4** | 6,577.92 ms | 110.86 tok/s | 1,691.0 MiB | 4,230.0 MiB | 61.0°C | 3.12 GB |
| **Run 5** | 7,128.11 ms | 98.97 tok/s | 1,691.0 MiB | 4,230.0 MiB | 61.0°C | 3.12 GB |

#### Warm Summary Statistics
- **Warm TTFT:** Min: **5,881.46 ms** | Median: **6,410.91 ms** | Max: **7,128.11 ms**
- **Decode Throughput:** Min: **98.97 tok/s** | Median: **107.72 tok/s** | Max: **110.86 tok/s**
- **VRAM Footprint:** **1,691.0 MiB** (Leaves **4,230.0 MiB safety headroom**, >4.2 GB free!)
- **Peak GPU Temperature:** **61.0°C**
- **Post-Unload Telemetry:** `0.0 MiB` allocated, `5,920.0 MiB` free (100% memory deallocation confirmed under `keep_alive=0`)
- **Verdict:** **PASS** (Ultra-lightweight fallback candidate operates at $>100\text{ tok/s}$ with minimal VRAM requirement).

---

### 3.5 Comparative Model Evaluation Table
| Candidate | Quantization | Parameter Count | Disk Size | Peak VRAM | Median TTFT | Median Throughput | Gate Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`qwen3.5:2b-q4_K_M`** | `Q4_K_M` | `1,881,825,088` (1.9B) | 1.81 GiB | **2,297.0 MiB** | 8,458.91 ms | **72.47 tok/s** | **PRIMARY INFERENCE (PASS)** |
| **`qwen3.5:0.8b`** | `Q8_0` | `752,393,024` (752.4M) | 1.23 GiB | **1,691.0 MiB** | 6,410.91 ms | **107.72 tok/s** | **FALLBACK INFERENCE (PASS)** |

**Architectural Inference Decision:** Both candidates fully pass Phase 0 inference acceptance gates. `qwen3.5:2b-q4_K_M` achieved **72.47 tok/s** with 3,624 MiB headroom; `qwen3.5:0.8b` achieved **107.72 tok/s** with 4,230 MiB headroom.

---

## 4. ML Training Environment Verification (Step 4)

- **Environment:** WSL2 Ubuntu 26.04 LTS (`~/nexus-ml-env`)
- **Python Version:** 3.11.17
- **PyTorch Version:** 2.14.1+cu130
- **CUDA Runtime:** 13.0 (Driver 592.82, direct GPU passthrough)
- **`torch.cuda.is_available()`:** True
- **Device Count / Name:** 1 / NVIDIA GeForce RTX 4050 Laptop GPU (AD107, Compute Capability 8.9)
- **BF16 Native Support:** `torch.cuda.is_bf16_supported() == True`
- **Initial Host VRAM:** Allocated: 0.0 MiB | Reserved: 0.0 MiB | Free: 5,920.0 MiB

---

## 5. Model Compatibility Probes (Step 5)

Probed via `scripts/probe_model.py`:
- **`Qwen/Qwen3.5-2B` (Revision `e01103ad`):**
  - Architecture: `Qwen2_5_VLForConditionalGeneration` / Hybrid Causal LM (24 layers, hidden size 2048, vocab 152064).
  - Base BF16 Weight Footprint: ~3,600 MiB.
- **`Qwen/Qwen3.5-0.8B` (Revision `2fc06364`):**
  - Architecture: Causal LM (24 layers, hidden size 1024, vocab 151936).
  - Base BF16 Weight Footprint: ~1,435.1 MiB (`model.safetensors`, 1.74 GB shard).
  - Tokenizer: ChatML format validated with tool delimiters.

---

## 6. Training Feasibility Empirical Gates (Step 6)

### 6.1 Reference Primary Candidate: `Qwen/Qwen3.5-2B`
- **Check A1 (Single-step Forward/Backward/Equality):** PASS. Forward loss: 6.7023. LoRA rank 8 injected across 192 parameter tensors. Adapter serialized and reloaded with exact float tensor equality.
- **Check A2 (`seq_len = 512`, micro_batch 1, grad_accum 4):** **FAIL (CUDA OOM)**.
  - Cause: Fallback to PyTorch reference `torch_chunk_gated_delta_rule` autograd kernel across 24 layers accumulated recurrent delta state autograd buffers. Combined with 3.6 GB base weights, peak allocation exceeded 6,141 MiB (`cuMemSetAccess` error).
- **Tier 1 Fallback Test (`seq_len = 384`, micro_batch 1, grad_accum 8):** **FAIL (CUDA OOM)**.
  - Diagnostic: Without specialized fused Triton/Unsloth kernels, the 2B recurrent state graph cannot fit in 6 GB VRAM during backward backpropagation.
  - Action: Invoked Tier 2 Fallback to `Qwen/Qwen3.5-0.8B`.

### 6.2 Tier 2 Fallback Candidate: `Qwen/Qwen3.5-0.8B`
- **Check A1 (Single-example Smoke):** **PASS**
  - Base weight load time: 8.53s.
  - Initial VRAM: Allocated: 1,435.10 MiB | Free: 4,705.44 MiB.
  - Forward loss: 6.5213 (finite).
  - Backward pass: Finite gradients across all 192 LoRA parameter tensors.
  - Checkpoint equality: Adapter serialized to `checkpoints/check_a1`, base model reloaded fresh, all 192 parameter tensors matched within absolute tolerance 0.0.
- **Check A2 (20-example Contract Specification Test, `seq_len = 256`):** **PASS**
  - 20 contract examples across 5 optimizer updates (micro 1, accum 4).
  - Loss progression: Step 1: 12.1529 -> Step 5: 11.0044.
  - Gradient norm: Step 1: 6.5047 -> Step 5: 3.0274 (strictly finite).
  - Peak Allocated VRAM: **1,707.24 MiB**.
  - Minimum Free VRAM: **4,433.26 MiB** (exceeds the 500 MiB abort boundary by **8.8x** / **3,933 MiB safety margin**).
  - Checkpoint reload: Adapter saved to `checkpoints/check_a2` and verified with exact equality.
- **Check B (30-step Pilot Training):** **PASS**
  - Execution duration: 57.99 seconds total.
  - Step 1 Loss: 0.7669 (Grad Norm: 8.3792) -> Step 30 Loss: **0.0001** (Grad Norm: **0.0089**).
  - Smooth monotonic convergence across all 30 steps.
  - Peak Allocated VRAM: **1,708.44 MiB**.
  - Minimum Free VRAM: **4,432.06 MiB**.
  - Checkpoint serialization: Verified in `checkpoints/check_b_pilot/` with full telemetry log (`pilot_step_log.json`).

---

## 7. Gate 1 Formal Sign-Off

| Metric | Required Criteria | Measured / Observed | Status |
| :--- | :--- | :--- | :--- |
| **Inference Throughput** | $\ge 25.0$ tok/s | 72.47 tok/s (2B) / 107.72 tok/s (0.8B) | **PASS** |
| **Inference VRAM Footprint** | $\le 3,500$ MiB | 2,297 MiB (2B) / 1,691 MiB (0.8B) | **PASS** |
| **Keep-Alive Unload** | 0 MiB allocated, $>5,000$ MiB free | 0.0 MiB allocated, 5,920 MiB free | **PASS** |
| **ML Environment Runtime** | PyTorch CUDA + BF16 | PyTorch 2.14.1+cu130, CC 8.9, BF16 True | **PASS** |
| **Check A Smoke & Spec** | Finite loss & grads, reload equality | Loss 6.5213, finite, reload match 192/192 | **PASS** |
| **Check B Pilot Convergence** | 30 steps finite, loss decreases | Loss 0.7669 -> 0.0001, grad norm 8.38 -> 0.0089 | **PASS** |
| **VRAM Safety Boundary** | Free VRAM $\ge 500$ MiB | Free VRAM: **4,432.06 MiB** (Margin: +3,932 MiB) | **PASS** |

**GATE 1 OUTCOME:** **100% PASS (VERIFIED)**.  
The Model Lab is formally authorized to proceed to Phase 2 (Local LoRA Fine-Tuning) using the validated `Qwen/Qwen3.5-0.8B` architecture.


