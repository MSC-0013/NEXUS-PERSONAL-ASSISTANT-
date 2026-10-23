import sys
import json

def verify_env():
    results = {}
    results["python_version"] = sys.version.split()[0]
    
    # 1. PyTorch verification
    try:
        import torch
        results["torch_version"] = torch.__version__
        results["cuda_available"] = torch.cuda.is_available()
        if results["cuda_available"]:
            results["cuda_version"] = torch.version.cuda
            results["device_name"] = torch.cuda.get_device_name(0)
            cc_major, cc_minor = torch.cuda.get_device_capability(0)
            results["compute_capability"] = f"{cc_major}.{cc_minor}"
            results["bf16_supported"] = torch.cuda.is_bf16_supported()
            free_b, total_b = torch.cuda.mem_get_info(0)
            results["vram_free_mb"] = round(free_b / (1024**2), 2)
            results["vram_total_mb"] = round(total_b / (1024**2), 2)
            results["vram_allocated_mb"] = round(torch.cuda.memory_allocated(0) / (1024**2), 2)
            results["vram_reserved_mb"] = round(torch.cuda.memory_reserved(0) / (1024**2), 2)
            
            # Simple tensor operation
            x = torch.randn(1024, 1024, device="cuda", dtype=torch.bfloat16 if results["bf16_supported"] else torch.float16)
            y = torch.matmul(x, x)
            results["tensor_test_passed"] = bool(y.shape == (1024, 1024) and torch.isfinite(y).all().item())
        else:
            results["tensor_test_passed"] = False
    except Exception as e:
        results["torch_error"] = str(e)
        results["cuda_available"] = False
        results["tensor_test_passed"] = False

    # 2. Key library imports
    libs = ["transformers", "peft", "accelerate", "datasets", "bitsandbytes"]
    for lib in libs:
        try:
            mod = __import__(lib)
            results[f"{lib}_version"] = getattr(mod, "__version__", "installed")
        except Exception as e:
            results[f"{lib}_error"] = str(e)

    print(json.dumps(results, indent=2))
    return results

if __name__ == "__main__":
    verify_env()
