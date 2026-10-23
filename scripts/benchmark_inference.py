import json
import time
import urllib.request
import urllib.error
import subprocess
import statistics
import sys
import os
import datetime
import re

OLLAMA_BASE_URL = "http://127.0.0.1:11434"
OLLAMA_GENERATE_URL = f"{OLLAMA_BASE_URL}/api/generate"

def sanitize_model_tag(tag: str) -> str:
    """Sanitize model tag for Windows-safe and portable filenames."""
    sanitized = re.sub(r'[^a-zA-Z0-9._-]', '_', tag)
    sanitized = re.sub(r'_+', '_', sanitized).strip('_')
    return sanitized or "model"

def normalize_and_validate_digest(raw_digest: str) -> str:
    """
    Normalize and validate SHA-256 manifest digest.
    Accepts 64 hexadecimal characters, with or without an explicit 'sha256:' prefix.
    """
    if not isinstance(raw_digest, str) or not raw_digest.strip():
        raise ValueError("Model manifest digest is missing or empty")
    digest = raw_digest.strip()
    if digest.lower().startswith("sha256:"):
        digest = digest[7:]
    if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValueError(f"Invalid model manifest digest format (expected 64 hex characters): {raw_digest}")
    return digest.lower()

def fetch_model_metadata(model_name: str, host: str = OLLAMA_BASE_URL) -> dict:
    """
    Fetch exact local model metadata from Ollama without triggering downloads or inference.
    Strictly validates:
      - Requested/resolved model name
      - 64-hex SHA-256 manifest digest from GET /api/tags
      - Positive artifact size in bytes
      - Quantization level from GET /api/tags
    Records optional parameter-size label and exact parameter count from POST /api/show (verbose=True).
    Captures /api/show errors explicitly without failing required identity fields.
    """
    tags_url = f"{host}/api/tags"
    try:
        req = urllib.request.Request(tags_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            tags_data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Failed to query Ollama /api/tags at {tags_url}: {e}")

    models = tags_data.get("models", [])
    matching_model = None
    for m in models:
        m_name = m.get("name", "")
        if m_name == model_name:
            matching_model = m
            break
        if ":" not in model_name and m_name == f"{model_name}:latest":
            matching_model = m
            break
        if model_name.endswith(":latest") and m_name == model_name[:-7]:
            matching_model = m
            break

    if not matching_model:
        avail = [m.get("name", "") for m in models]
        raise RuntimeError(
            f"Requested model tag '{model_name}' not found in local Ollama registry (/api/tags). "
            f"Available models: {avail}"
        )

    resolved_name = matching_model.get("name")
    if not resolved_name or not isinstance(resolved_name, str):
        raise RuntimeError(f"Model '{model_name}' has missing or invalid name in /api/tags")

    # 1. Strict validation of required manifest digest
    raw_digest = matching_model.get("digest")
    try:
        manifest_digest = normalize_and_validate_digest(raw_digest)
    except ValueError as e:
        raise RuntimeError(f"Model '{model_name}' has invalid manifest digest: {e}")

    # 2. Strict validation of required artifact size
    size_bytes = matching_model.get("size")
    if not isinstance(size_bytes, (int, float)) or size_bytes <= 0:
        raise RuntimeError(f"Model '{model_name}' has missing or non-positive artifact size: {size_bytes}")
    size_bytes = int(size_bytes)
    if size_bytes >= 1024**3:
        size_human = f"{round(size_bytes / (1024**3), 2)} GB"
    else:
        size_human = f"{round(size_bytes / (1024**2), 2)} MB"

    # 3. Strict validation of required quantization level
    details = matching_model.get("details", {})
    raw_quant = details.get("quantization_level")
    if not raw_quant or not isinstance(raw_quant, str) or not raw_quant.strip():
        raise RuntimeError(f"Model '{model_name}' is missing required quantization_level in /api/tags details")
    quant_level = raw_quant.strip()

    # Optional parameter size label from details
    param_size_label = details.get("parameter_size")
    if not param_size_label or not isinstance(param_size_label, str) or not param_size_label.strip():
        param_size_label = "unavailable"
    else:
        param_size_label = param_size_label.strip()

    # 4. Query /api/show (verbose=True) with explicit error tracking
    show_url = f"{host}/api/show"
    param_count_exact = "unavailable"
    show_api_status = "ok"
    try:
        show_payload = json.dumps({"model": model_name, "verbose": True}).encode("utf-8")
        show_req = urllib.request.Request(show_url, data=show_payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(show_req, timeout=10) as resp:
            show_data = json.loads(resp.read().decode("utf-8"))
            model_info = show_data.get("model_info", {})
            if "general.parameter_count" in model_info and isinstance(model_info["general.parameter_count"], (int, float)):
                param_count_exact = int(model_info["general.parameter_count"])
            show_details = show_data.get("details", {})
            if "quantization_level" in show_details and show_details["quantization_level"]:
                show_quant = str(show_details["quantization_level"]).strip()
                if show_quant and quant_level != show_quant:
                    quant_level = f"{quant_level} (show: {show_quant})"
            if param_size_label == "unavailable" and "parameter_size" in show_details:
                param_size_label = str(show_details["parameter_size"]).strip()
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", str(e))
        show_api_status = f"unavailable (URLError: {reason})"
    except json.JSONDecodeError as e:
        show_api_status = f"unavailable (Malformed JSON: {e})"
    except Exception as e:
        show_api_status = f"unavailable ({type(e).__name__})"

    return {
        "requested_model_tag": model_name,
        "resolved_model_name": resolved_name,
        "manifest_digest": manifest_digest,
        "size_bytes": size_bytes,
        "size_human": size_human,
        "quantization_level": quant_level,
        "parameter_size_label": param_size_label,
        "parameter_count_exact": param_count_exact,
        "show_api_status": show_api_status
    }

def get_gpu_telemetry():
    try:
        cmd = [
            "nvidia-smi",
            "--query-gpu=memory.used,memory.free,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits"
        ]
        out = subprocess.check_output(cmd, encoding="utf-8").strip()
        parts = [p.strip() for p in out.split(",")]
        return {
            "vram_used_mb": float(parts[0]),
            "vram_free_mb": float(parts[1]),
            "vram_total_mb": float(parts[2]),
            "temp_c": float(parts[3]),
            "power_w": float(parts[4])
        }
    except Exception as e:
        return {"error": str(e), "vram_used_mb": 0, "vram_free_mb": 0, "temp_c": 0}

def get_sys_ram():
    try:
        import ctypes
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
        return {
            "total_gb": round(stat.ullTotalPhys / (1024**3), 2),
            "avail_gb": round(stat.ullAvailPhys / (1024**3), 2)
        }
    except Exception:
        return {"total_gb": 16.0, "avail_gb": 0.0}

def run_single_inference(model_name: str, prompt: str, is_cold: bool = False):
    payload = {
        "model": model_name,
        "prompt": prompt,
        "stream": True,
        "options": {
            "num_ctx": 4096,
            "num_predict": 128,
            "temperature": 0.2
        }
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(OLLAMA_GENERATE_URL, data=data, headers={"Content-Type": "application/json"})

    initial_telemetry = get_gpu_telemetry()
    start_time = time.perf_counter()
    first_token_time = None
    accumulated_text = ""
    last_response = {}
    peak_vram = initial_telemetry["vram_used_mb"]
    peak_temp = initial_telemetry["temp_c"]

    with urllib.request.urlopen(req) as resp:
        for line in resp:
            line_str = line.decode("utf-8").strip()
            if not line_str:
                continue
            chunk = json.loads(line_str)
            token = chunk.get("response", "")
            if token and first_token_time is None:
                first_token_time = time.perf_counter()
            accumulated_text += token

            # Sample GPU telemetry dynamically
            sample = get_gpu_telemetry()
            if sample.get("vram_used_mb", 0) > peak_vram:
                peak_vram = sample["vram_used_mb"]
            if sample.get("temp_c", 0) > peak_temp:
                peak_temp = sample["temp_c"]

            if chunk.get("done", False):
                last_response = chunk
                break

    end_time = time.perf_counter()
    if first_token_time is None:
        first_token_time = end_time

    total_latency_ms = (end_time - start_time) * 1000.0
    ttft_ms = (first_token_time - start_time) * 1000.0
    gen_time_s = end_time - first_token_time

    eval_count = last_response.get("eval_count", 0)
    eval_duration_ns = last_response.get("eval_duration", 0)
    prompt_eval_count = last_response.get("prompt_eval_count", 0)
    prompt_eval_duration_ns = last_response.get("prompt_eval_duration", 0)
    load_duration_ns = last_response.get("load_duration", 0)

    # Server-calculated throughput if available, else client-side
    if eval_duration_ns > 0 and eval_count > 0:
        server_tok_per_sec = eval_count / (eval_duration_ns / 1e9)
    else:
        server_tok_per_sec = eval_count / gen_time_s if gen_time_s > 0 else 0.0

    client_tok_per_sec = (eval_count - 1) / gen_time_s if (gen_time_s > 0 and eval_count > 1) else 0.0

    final_telemetry = get_gpu_telemetry()
    ram_info = get_sys_ram()

    return {
        "is_cold": is_cold,
        "total_latency_ms": round(total_latency_ms, 2),
        "ttft_ms": round(ttft_ms, 2),
        "eval_count": eval_count,
        "eval_duration_ms": round(eval_duration_ns / 1e6, 2),
        "server_tokens_per_sec": round(server_tok_per_sec, 2),
        "client_tokens_per_sec": round(client_tok_per_sec, 2),
        "prompt_eval_count": prompt_eval_count,
        "prompt_eval_duration_ms": round(prompt_eval_duration_ns / 1e6, 2),
        "load_duration_ms": round(load_duration_ns / 1e6, 2),
        "peak_vram_mb": peak_vram,
        "min_free_vram_mb": final_telemetry.get("vram_free_mb", 0),
        "peak_temp_c": peak_temp,
        "avail_sys_ram_gb": ram_info.get("avail_gb", 0),
        "response_sample": accumulated_text[:120].replace("\n", " ")
    }

def benchmark_model(model_name: str, num_warm_runs: int = 5):
    prompt = "Explain the difference between synchronous and asynchronous execution in computer programming in 100 words."
    print(f"\n=======================================================")
    print(f"BENCHMARKING MODEL: {model_name}")
    print(f"Standard Configuration: num_ctx=4096, num_predict=128, temp=0.2")
    print(f"=======================================================")

    print("\nVerifying model identity and metadata via Ollama API...")
    model_identity = fetch_model_metadata(model_name)
    print(f"  Requested Tag:     {model_identity['requested_model_tag']}")
    print(f"  Resolved Name:     {model_identity['resolved_model_name']}")
    print(f"  Manifest Digest:   {model_identity['manifest_digest']}")
    print(f"  Quantization:      {model_identity['quantization_level']}")
    print(f"  Parameter Size:    {model_identity['parameter_size_label']}")
    print(f"  Parameter Count:   {model_identity['parameter_count_exact']}")
    print(f"  Artifact Size:     {model_identity['size_human']} ({model_identity['size_bytes']} bytes)")
    print(f"  Show API Status:   {model_identity['show_api_status']}")

    print("\nExecuting Cold Run (Model Loading & Initial Request)...")
    cold_result = run_single_inference(model_name, prompt, is_cold=True)
    print(f"Cold Total Latency: {cold_result['total_latency_ms']} ms")
    print(f"Cold TTFT: {cold_result['ttft_ms']} ms (Load Duration: {cold_result['load_duration_ms']} ms)")
    print(f"Cold Decode Throughput: {cold_result['server_tokens_per_sec']} tok/s")
    print(f"Peak VRAM: {cold_result['peak_vram_mb']} MiB | Peak Temp: {cold_result['peak_temp_c']} °C")

    warm_results = []
    print(f"\nExecuting {num_warm_runs} Warm Runs under desktop load...")
    for i in range(1, num_warm_runs + 1):
        time.sleep(1.0) # brief settle
        res = run_single_inference(model_name, prompt, is_cold=False)
        warm_results.append(res)
        print(f"  Warm Run #{i}: TTFT={res['ttft_ms']} ms | Speed={res['server_tokens_per_sec']} tok/s | Peak VRAM={res['peak_vram_mb']} MiB | Temp={res['peak_temp_c']} °C")

    # Statistics
    ttfts = [r["ttft_ms"] for r in warm_results]
    speeds = [r["server_tokens_per_sec"] for r in warm_results]
    vrams = [r["peak_vram_mb"] for r in warm_results]
    temps = [r["peak_temp_c"] for r in warm_results]
    min_frees = [r["min_free_vram_mb"] for r in warm_results]

    summary = {
        "model": model_name,
        "model_identity": model_identity,
        "benchmark_timestamp_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cold": cold_result,
        "warm_runs": warm_results,
        "warm_summary": {
            "ttft_ms": {
                "min": min(ttfts),
                "median": statistics.median(ttfts),
                "max": max(ttfts)
            },
            "throughput_tok_s": {
                "min": min(speeds),
                "median": statistics.median(speeds),
                "max": max(speeds)
            },
            "peak_vram_mb": max(vrams),
            "min_free_vram_mb": min(min_frees),
            "peak_temp_c": max(temps),
            "avail_sys_ram_gb": warm_results[-1]["avail_sys_ram_gb"]
        }
    }

    print("\n--- Summary of Warm Runs ---")
    print(f"Warm TTFT (ms): min={summary['warm_summary']['ttft_ms']['min']}, median={summary['warm_summary']['ttft_ms']['median']}, max={summary['warm_summary']['ttft_ms']['max']}")
    print(f"Throughput (tok/s): min={summary['warm_summary']['throughput_tok_s']['min']}, median={summary['warm_summary']['throughput_tok_s']['median']}, max={summary['warm_summary']['throughput_tok_s']['max']}")
    print(f"Peak VRAM: {summary['warm_summary']['peak_vram_mb']} MiB | Min Free: {summary['warm_summary']['min_free_vram_mb']} MiB | Peak Temp: {summary['warm_summary']['peak_temp_c']} °C")

    print(f"\nGracefully unloading model '{model_name}' from VRAM (keep_alive=0)...")
    post_telemetry = unload_model(model_name)
    summary["post_unload_telemetry"] = post_telemetry
    print(f"Post-Unload VRAM Used: {post_telemetry.get('vram_used_mb', 0)} MiB (Free: {post_telemetry.get('vram_free_mb', 0)} MiB)")

    return summary

def unload_model(model_name: str, host: str = OLLAMA_BASE_URL) -> dict:
    """
    Gracefully unload the model from VRAM by setting keep_alive: 0
    and sample post-unload GPU telemetry to verify memory reclamation.
    """
    req = urllib.request.Request(
        f"{host}/api/generate",
        data=json.dumps({"model": model_name, "keep_alive": 0}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            pass
    except Exception as e:
        print(f"Warning: Exception during model unload: {e}")

    time.sleep(1.0)
    return get_gpu_telemetry()

def save_benchmark_results(res: dict, target_model: str, output_dir: str = ".") -> str:
    """
    Save benchmark results using exclusive file creation (mode 'x') to atomically prevent
    any concurrent-writer race condition or accidental overwrite.
    """
    utc_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    sanitized_tag = sanitize_model_tag(target_model)
    base_filename = f"benchmark_{sanitized_tag}_{utc_str}"

    counter = 0
    while True:
        suffix = f"_{counter}" if counter > 0 else ""
        candidate_filename = os.path.join(output_dir, f"{base_filename}{suffix}.json")
        try:
            # Atomic exclusive file creation
            with open(candidate_filename, "x", encoding="utf-8") as f:
                json.dump(res, f, indent=2)
            return candidate_filename
        except FileExistsError:
            counter += 1
            if counter > 10000:
                raise RuntimeError(f"Exceeded maximum collision retry attempts for base filename: {base_filename}")

if __name__ == "__main__":
    target_model = sys.argv[1] if len(sys.argv) > 1 else "qwen3.5:2b-q4_K_M"
    res = benchmark_model(target_model, num_warm_runs=5)
    saved_path = save_benchmark_results(res, target_model)
    print(f"\nSaved raw benchmark data to {saved_path}")
