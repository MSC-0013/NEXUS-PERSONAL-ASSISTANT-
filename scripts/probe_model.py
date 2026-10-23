import os
import sys
import json
import time
import glob
from typing import Dict, Any

def get_vram_telemetry():
    import torch
    if not torch.cuda.is_available():
        return {
            "available": False,
            "total_mb": 0.0,
            "allocated_mb": 0.0,
            "reserved_mb": 0.0,
            "free_mb": 0.0,
            "used_mb": 0.0
        }
    free_b, total_b = torch.cuda.mem_get_info()
    allocated_b = torch.cuda.memory_allocated()
    reserved_b = torch.cuda.memory_reserved()
    used_b = total_b - free_b
    return {
        "available": True,
        "total_mb": round(total_b / (1024 ** 2), 2),
        "allocated_mb": round(allocated_b / (1024 ** 2), 2),
        "reserved_mb": round(reserved_b / (1024 ** 2), 2),
        "free_mb": round(free_b / (1024 ** 2), 2),
        "used_mb": round(used_b / (1024 ** 2), 2)
    }

def probe_runtime() -> Dict[str, Any]:
    res = {
        "python_version": sys.version.split()[0],
        "torch_version": "N/A",
        "cuda_runtime": "N/A",
        "cuda_available": False,
        "device_name": "N/A",
        "compute_capability": "N/A",
        "bf16_supported": False,
        "vram_initial": {},
        "status": "PASS",
        "errors": []
    }
    try:
        import torch
        res["torch_version"] = torch.__version__
        res["cuda_runtime"] = torch.version.cuda or "CPU-only"
        res["cuda_available"] = torch.cuda.is_available()
        
        if res["cuda_available"]:
            res["device_name"] = torch.cuda.get_device_name(0)
            cap = torch.cuda.get_device_capability(0)
            res["compute_capability"] = f"{cap[0]}.{cap[1]}"
            res["bf16_supported"] = torch.cuda.is_bf16_supported()
            res["vram_initial"] = get_vram_telemetry()
            if not res["bf16_supported"]:
                res["errors"].append("BF16 not supported on this CUDA device.")
                res["status"] = "FAIL"
        else:
            res["errors"].append("CUDA is not available in PyTorch runtime.")
            res["status"] = "FAIL"
    except Exception as e:
        res["status"] = "FAIL"
        res["errors"].append(f"Runtime probe exception: {e}")
    return res

def probe_model_compatibility(model_id: str) -> Dict[str, Any]:
    res = {
        "model_id": model_id,
        "revision": "unknown",
        "config_loaded": False,
        "model_type": "unknown",
        "architectures": [],
        "num_layers": "unknown",
        "hidden_size": "unknown",
        "vocab_size": "unknown",
        "param_size_metadata": "unknown",
        "transformers_supported": False,
        "tokenizer_loaded": False,
        "tokenizer_vocab_size": 0,
        "has_chat_template": False,
        "missing_files": [],
        "status": "PASS",
        "errors": []
    }
    
    # 1. Check local HF cache for snapshot revision
    cache_base = os.path.expanduser(f"~/.cache/huggingface/hub/models--{model_id.replace('/', '--')}")
    snapshots_dir = os.path.join(cache_base, "snapshots")
    if os.path.exists(snapshots_dir):
        snapshots = os.listdir(snapshots_dir)
        if snapshots:
            res["revision"] = snapshots[0]
            
    # 2. Check configuration
    try:
        from transformers import AutoConfig
        cfg = AutoConfig.from_pretrained(model_id, trust_remote_code=True)
        res["config_loaded"] = True
        res["model_type"] = getattr(cfg, "model_type", "unknown")
        res["architectures"] = getattr(cfg, "architectures", [])
        
        # Handle nested text_config if VLM/hybrid
        text_cfg = getattr(cfg, "text_config", None)
        if text_cfg is not None:
            res["num_layers"] = getattr(text_cfg, "num_hidden_layers", "unknown")
            res["hidden_size"] = getattr(text_cfg, "hidden_size", "unknown")
            res["vocab_size"] = getattr(text_cfg, "vocab_size", "unknown")
        else:
            res["num_layers"] = getattr(cfg, "num_hidden_layers", getattr(cfg, "n_layer", "unknown"))
            res["hidden_size"] = getattr(cfg, "hidden_size", getattr(cfg, "n_embd", "unknown"))
            res["vocab_size"] = getattr(cfg, "vocab_size", "unknown")
            
        # Check architecture support in transformers
        import transformers
        arch_found = False
        for arch in res["architectures"]:
            if hasattr(transformers, arch):
                arch_found = True
                break
        # Also check AutoModel mappings
        if not arch_found:
            from transformers.models.auto.modeling_auto import MODEL_FOR_CAUSAL_LM_MAPPING, MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING
            if type(cfg) in MODEL_FOR_CAUSAL_LM_MAPPING or type(cfg) in MODEL_FOR_IMAGE_TEXT_TO_TEXT_MAPPING:
                arch_found = True
        res["transformers_supported"] = arch_found
        if not arch_found:
            res["errors"].append(f"Architectures {res['architectures']} not directly registered in transformers {transformers.__version__} (remote code may be required).")
    except Exception as e:
        res["config_loaded"] = False
        res["status"] = "FAIL"
        res["errors"].append(f"Failed to load AutoConfig: {e}")

    # 3. Check Tokenizer
    try:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        res["tokenizer_loaded"] = True
        res["tokenizer_vocab_size"] = len(tok)
        res["has_chat_template"] = (tok.chat_template is not None)
        # Smoke test tokenization
        sample_encoding = tok("Project NEXUS model compatibility probe.", return_tensors="pt")
        if sample_encoding["input_ids"].shape[-1] == 0:
            res["status"] = "FAIL"
            res["errors"].append("Tokenizer produced empty tokens for probe text.")
    except Exception as e:
        res["tokenizer_loaded"] = False
        res["status"] = "FAIL"
        res["errors"].append(f"Failed to load AutoTokenizer: {e}")

    # 4. Check cached weight files
    if os.path.exists(cache_base):
        blobs_dir = os.path.join(cache_base, "blobs")
        incomplete_files = glob.glob(os.path.join(blobs_dir, "*.incomplete"))
        if incomplete_files:
            res["missing_files"].append(f"Incomplete download shards detected: {len(incomplete_files)} file(s) still streaming.")
            res["status"] = "BLOCKED"
    return res

def assess_memory_feasibility(vram_info: Dict[str, Any]) -> Dict[str, Any]:
    # Hardware bounds: RTX 4050 Laptop GPU (6,141 MiB dedicated VRAM)
    # 2B model in BF16: ~3.8 - 4.5 GB raw parameters
    # LoRA r=8, alpha=16: ~15-30 MB adapter weights
    # AdamW 8-bit or 32-bit: ~30-60 MB optimizer state on adapter
    # Activations at seq_len 512, micro_batch 1, with gradient checkpointing: ~400-700 MB
    # Estimated peak VRAM: ~4,600 - 5,100 MiB
    # Remaining headroom on 6,141 MiB: ~1,000 - 1,500 MiB (exceeds mandatory 500 MiB boundary)
    
    total = vram_info.get("total_mb", 0.0)
    free = vram_info.get("free_mb", 0.0)
    
    feasible = (free >= 5200.0)
    status = "PASS" if feasible else ("BLOCKED" if free < 3000.0 else "WARNING")
    
    return {
        "status": status,
        "physical_total_mb": total,
        "physical_free_mb": free,
        "vram_threshold_mb": 500.0,
        "estimated_model_weights_mb": 4500.0,
        "requires_gradient_checkpointing": True,
        "requires_micro_batch_1": True,
        "pre_authorized_fallback": "seq_len 384 if free VRAM < 500 MiB; qwen3.5:0.8b if OOM"
    }

def print_terminal_report(runtime: Dict[str, Any], model_comp: Dict[str, Any], mem: Dict[str, Any]):
    print("\n" + "=" * 70)
    print(" PROJECT NEXUS V2.3 — MODEL COMPATIBILITY PROBE REPORT")
    print("=" * 70)
    
    print("\n[A. RUNTIME VERIFICATION]")
    print(f"  Status:             {runtime['status']}")
    print(f"  Python Version:     {runtime['python_version']}")
    print(f"  PyTorch Version:    {runtime['torch_version']}")
    print(f"  CUDA Runtime:       {runtime['cuda_runtime']}")
    print(f"  CUDA Available:     {runtime['cuda_available']}")
    print(f"  GPU Device:         {runtime['device_name']}")
    print(f"  Compute Capability: {runtime['compute_capability']}")
    print(f"  BF16 Supported:     {runtime['bf16_supported']}")
    if runtime['vram_initial'].get('available'):
        v = runtime['vram_initial']
        print(f"  VRAM Telemetry:     Allocated={v['allocated_mb']} MiB | Reserved={v['reserved_mb']} MiB | Free={v['free_mb']} MiB | Total={v['total_mb']} MiB")
        
    print("\n[B. MODEL COMPATIBILITY]")
    print(f"  Status:             {model_comp['status']}")
    print(f"  Target Model:       {model_comp['model_id']}")
    print(f"  Model Revision:     {model_comp['revision']}")
    print(f"  Model Type:         {model_comp['model_type']}")
    print(f"  Architectures:      {model_comp['architectures']}")
    print(f"  Num Layers:         {model_comp['num_layers']}")
    print(f"  Hidden Size:        {model_comp['hidden_size']}")
    print(f"  Vocab Size:         {model_comp['vocab_size']}")
    print(f"  Transformers Supp:  {model_comp['transformers_supported']}")
    print(f"  Tokenizer Loaded:   {model_comp['tokenizer_loaded']} (Vocab: {model_comp['tokenizer_vocab_size']})")
    print(f"  Chat Template:      {model_comp['has_chat_template']}")
    if model_comp['missing_files']:
        for mf in model_comp['missing_files']:
            print(f"  Missing Artifacts:  {mf}")

    print("\n[C. MEMORY FEASIBILITY ASSESSMENT]")
    print(f"  Status:             {mem['status']}")
    print(f"  Physical Total:     {mem['physical_total_mb']} MiB")
    print(f"  Physical Free:      {mem['physical_free_mb']} MiB")
    print(f"  Est. Base Weights:  ~{mem['estimated_model_weights_mb']} MiB (BF16)")
    print(f"  Safety Threshold:   >= {mem['vram_threshold_mb']} MiB free VRAM throughout training")
    print(f"  Required Controls:  Gradient Checkpointing=ON, Micro-batch=1, Accumulation=4")
    print(f"  Fallback Rule:      {mem['pre_authorized_fallback']}")

    overall_status = "PASS"
    if runtime["status"] == "FAIL" or model_comp["status"] == "FAIL" or mem["status"] == "FAIL":
        overall_status = "FAIL"
    elif runtime["status"] == "BLOCKED" or model_comp["status"] == "BLOCKED" or mem["status"] == "BLOCKED":
        overall_status = "BLOCKED"

    print("\n[D. OVERALL PROBE VERDICT]")
    print(f"  VERDICT:            {overall_status}")
    all_errors = runtime["errors"] + model_comp["errors"]
    if all_errors:
        print("  Errors / Warnings:")
        for err in all_errors:
            print(f"    - {err}")
    print("=" * 70 + "\n")
    return overall_status

def main():
    target_model = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.5-2B"
    runtime = probe_runtime()
    model_comp = probe_model_compatibility(target_model)
    mem = assess_memory_feasibility(runtime.get("vram_initial", {}))
    verdict = print_terminal_report(runtime, model_comp, mem)
    
    if verdict == "FAIL":
        sys.exit(1)
    elif verdict == "BLOCKED":
        sys.exit(2)
    else:
        sys.exit(0)

if __name__ == "__main__":
    main()
