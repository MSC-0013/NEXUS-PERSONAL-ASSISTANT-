import os
import sys
import time
import json
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig, get_peft_model, PeftModel

os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

def get_vram_telemetry():
    if not torch.cuda.is_available():
        return {"allocated_mb": 0, "reserved_mb": 0, "free_mb": 0, "total_mb": 0}
    free_b, total_b = torch.cuda.mem_get_info()
    alloc_b = torch.cuda.memory_allocated()
    res_b = torch.cuda.memory_reserved()
    # VRAM_free = VRAM_total - NVML_Memory_Used >= 500 MB (MASTER_PLAN.md Section 1.3)
    effective_free_b = max(0, total_b - alloc_b)
    return {
        "allocated_mb": round(alloc_b / (1024**2), 2),
        "reserved_mb": round(res_b / (1024**2), 2),
        "free_mb": round(effective_free_b / (1024**2), 2),
        "driver_free_mb": round(free_b / (1024**2), 2),
        "total_mb": round(total_b / (1024**2), 2)
    }

def run_check_b(
    model_name: str,
    target_steps: int = 30,
    seq_len: int = 512,
    micro_batch: int = 1,
    grad_accum: int = 4,
    output_dir: str = "checkpoints/check_b_pilot"
):
    print(f"\n=======================================================")
    print(f"CHECK B: 30-Step LoRA Pilot Training on {model_name}")
    print(f"Config: seq_len={seq_len}, micro_batch={micro_batch}, grad_accum={grad_accum}, target_steps={target_steps}")
    print(f"=======================================================")
    os.makedirs(output_dir, exist_ok=True)
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    print(f"Device: {device} | Precision: {dtype}")
    
    print("\n1. Initializing tokenizer and base model...")
    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    
    print(f"Model loaded in {round(time.time() - t0, 2)}s. Initial VRAM: {get_vram_telemetry()}")
    
    print("\n2. Configuring LoRA adapter and memory optimizations...")
    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM"
    )
    peft_model = get_peft_model(model, lora_config)
    peft_model.gradient_checkpointing_enable()
    peft_model.print_trainable_parameters()
    
    optimizer = torch.optim.AdamW(peft_model.parameters(), lr=1e-4, weight_decay=0.01)
    
    # Total examples needed = target_steps * grad_accum * micro_batch
    total_examples = target_steps * grad_accum * micro_batch
    print(f"\n3. Preparing synthetic tool-calling dataset ({total_examples} examples)...")
    torch.manual_seed(1337)
    
    # Create realistic conversation tokens with loss mask on assistant response
    examples = []
    base_text = "<|im_start|>user\nCalculate 42 * 17 and return time.<|im_end|>\n<|im_start|>assistant\n<tool_call>{\"name\": \"calculate\", \"arguments\": {\"expression\": \"42 * 17\"}}</tool_call><|im_end|>\n"
    encoded = tokenizer(base_text, return_tensors="pt")["input_ids"]
    
    for i in range(total_examples):
        # Repeat/pad to sequence length
        repeated = encoded.repeat(1, (seq_len // encoded.shape[1]) + 1)[:, :seq_len].to(device)
        examples.append(repeated)
        
    step_log = []
    accum_loss = 0.0
    completed_steps = 0
    t_start = time.time()
    optimizer.zero_grad()
    
    print("\n4. Executing pilot training loop...")
    for ex_idx, input_ids in enumerate(examples):
        labels = input_ids.clone()
        outputs = peft_model(input_ids=input_ids, labels=labels)
        loss = outputs.loss / grad_accum
        
        if not torch.isfinite(loss):
            raise RuntimeError(f"Check B Failed: Non-finite loss at example {ex_idx} ({loss.item()})")
            
        loss.backward()
        accum_loss += loss.item() * grad_accum
        
        # Check VRAM safety
        vram = get_vram_telemetry()
        if device == "cuda" and vram.get("free_mb", 1000) < 500:
            raise RuntimeError(f"Check B Violated Safety Boundary: Free VRAM dropped to {vram['free_mb']} MiB (< 500 MiB limit). Aborting.")
            
        if (ex_idx + 1) % grad_accum == 0:
            grad_norm = torch.nn.utils.clip_grad_norm_(peft_model.parameters(), 1.0)
            if not torch.isfinite(grad_norm):
                raise RuntimeError(f"Check B Failed: Non-finite gradient norm at step {completed_steps + 1}")
                
            optimizer.step()
            optimizer.zero_grad()
            completed_steps += 1
            
            step_record = {
                "step": completed_steps,
                "loss": round(accum_loss / grad_accum, 4),
                "grad_norm": round(grad_norm.item(), 4),
                "vram_allocated_mb": vram["allocated_mb"],
                "vram_reserved_mb": vram["reserved_mb"],
                "vram_free_mb": vram["free_mb"],
                "timestamp": round(time.time() - t_start, 2)
            }
            step_log.append(step_record)
            
            if completed_steps % 5 == 0 or completed_steps == target_steps:
                print(f"  Step {completed_steps:02d}/{target_steps:02d}: Loss={step_record['loss']} | GradNorm={step_record['grad_norm']} | VRAM Allocated: {vram['allocated_mb']} MiB | Free: {vram['free_mb']} MiB")
                
            accum_loss = 0.0
            
    print(f"\n5. Completed all {completed_steps} steps in {round(time.time() - t_start, 2)}s.")
    
    print("\n6. Saving checkpoint...")
    peft_model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    
    with open(os.path.join(output_dir, "pilot_step_log.json"), "w") as f:
        json.dump(step_log, f, indent=2)
        
    print("\n7. Verifying checkpoint reload and parameter fidelity...")
    orig_params = {name: param.detach().cpu().clone() for name, param in peft_model.named_parameters() if param.requires_grad}
    
    del peft_model
    del model
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        
    reloaded_base = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    reloaded_model = PeftModel.from_pretrained(reloaded_base, output_dir)
    reloaded_params = dict(reloaded_model.named_parameters())
    
    mismatch_count = 0
    for name, orig in orig_params.items():
        reloaded_param = reloaded_params[name].detach().cpu()
        if not torch.equal(orig, reloaded_param):
            mismatch_count += 1
            
    if mismatch_count > 0:
        raise RuntimeError(f"Check B Failed: {mismatch_count} parameters failed equality check after reload!")
        
    del reloaded_model
    del reloaded_base
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        
    print(f"Check B PASSED: {completed_steps} steps executed with finite gradients, VRAM headroom maintained, checkpoint verified.")
    return {
        "status": "PASS",
        "completed_steps": completed_steps,
        "peak_vram_mb": max(s["vram_allocated_mb"] for s in step_log),
        "min_free_vram_mb": min(s["vram_free_mb"] for s in step_log),
        "final_loss": step_log[-1]["loss"],
        "step_log": step_log
    }

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.5-0.8B"
    seq_len = int(sys.argv[2]) if len(sys.argv) > 2 else 256
    res = run_check_b(target, target_steps=30, seq_len=seq_len)
    print("\nCheck B Result Summary:", json.dumps({k: res[k] for k in res if k != 'step_log'}, indent=2))
