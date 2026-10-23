import os
import sys
import time
import json
import torch

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

def run_check_a1(model_name: str, output_dir: str = "checkpoints/check_a1"):
    print(f"\n=======================================================")
    print(f"CHECK A1: Initial Smoke Probe for {model_name}")
    print(f"=======================================================")
    os.makedirs(output_dir, exist_ok=True)
    
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import LoraConfig, get_peft_model, PeftModel
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    print(f"Target Device: {device} | Precision: {dtype}")
    
    t0 = time.time()
    print("1. Loading base model and tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    print(f"Base model loaded in {round(time.time() - t0, 2)}s. Telemetry: {get_vram_telemetry()}")
    
    print("2. Initializing LoRA adapter...")
    target_modules = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        target_modules=target_modules,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM"
    )
    peft_model = get_peft_model(model, lora_config)
    peft_model.print_trainable_parameters()
    
    print("3. Executing single forward pass...")
    prompt = "Project NEXUS AI Assistant contract test."
    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    labels = inputs["input_ids"].clone()
    outputs = peft_model(**inputs, labels=labels)
    loss = outputs.loss
    
    if not torch.isfinite(loss):
        raise RuntimeError(f"Check A1 Failed: Non-finite loss encountered ({loss.item()})")
    print(f"Forward pass completed. Finite loss: {loss.item():.4f}")
    
    print("4. Executing single backward pass...")
    loss.backward()
    
    trainable_grads = []
    for name, param in peft_model.named_parameters():
        if param.requires_grad:
            if param.grad is None:
                raise RuntimeError(f"Check A1 Failed: Gradient is None for {name}")
            if not torch.isfinite(param.grad).all():
                raise RuntimeError(f"Check A1 Failed: Non-finite gradient for {name}")
            trainable_grads.append(name)
            
    print(f"Backward pass verified: {len(trainable_grads)} trainable parameters have finite gradients.")
    
    print("5. Serializing checkpoint...")
    peft_model.save_pretrained(output_dir)
    print(f"Saved adapter to {output_dir}")
    
    print("6. Reloading and verifying adapter equality...")
    orig_params = {name: param.detach().cpu().clone() for name, param in peft_model.named_parameters() if name in trainable_grads}
    
    # Free VRAM before reloading to prevent double model allocation
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
    
    for name in trainable_grads:
        orig = orig_params[name]
        reloaded = reloaded_params[name].detach().cpu()
        if not torch.equal(orig, reloaded):
            raise RuntimeError(f"Check A1 Failed: Weight mismatch in reloaded adapter for {name}")
            
    print(f"Check A1 Passed: All {len(trainable_grads)} LoRA parameters match reloaded state exactly.")
    
    # Cleanup memory before next test
    del reloaded_model
    del reloaded_base
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return True

def run_check_a2(model_name: str, output_dir: str = "checkpoints/check_a2", seq_len: int = 512):
    print(f"\n=======================================================")
    print(f"CHECK A2: Full Feasibility Specification (20 examples, seq {seq_len}, micro 1, accum 4)")
    print(f"=======================================================")
    os.makedirs(output_dir, exist_ok=True)
    
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import LoraConfig, get_peft_model, PeftModel
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    
    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM"
    )
    peft_model = get_peft_model(model, lora_config)
    
    # Enable gradient checkpointing for memory safety
    peft_model.gradient_checkpointing_enable()
    
    optimizer = torch.optim.AdamW(peft_model.parameters(), lr=2e-4)
    
    num_examples = 20
    accum_steps = 4
    
    print(f"Generating {num_examples} synthetic examples (seq_len={seq_len}, micro=1, accum={accum_steps})...")
    torch.manual_seed(42)
    synthetic_inputs = [
        torch.randint(0, min(10000, tokenizer.vocab_size), (1, seq_len), device=device)
        for _ in range(num_examples)
    ]
    
    optimizer_updates = 0
    step_losses = []
    
    print("\nStarting Check A2 training loop...")
    optimizer.zero_grad()
    
    for i, input_ids in enumerate(synthetic_inputs):
        labels = input_ids.clone()
        outputs = peft_model(input_ids=input_ids, labels=labels)
        loss = outputs.loss / accum_steps
        
        if not torch.isfinite(loss):
            raise RuntimeError(f"Check A2 Failed: Non-finite loss at example {i+1} ({loss.item()})")
            
        loss.backward()
        step_losses.append(loss.item() * accum_steps)
        
        # Check VRAM boundary
        vram = get_vram_telemetry()
        if device == "cuda" and vram.get("free_mb", 1000) < 500:
            raise RuntimeError(f"Check A2 Failed: VRAM safety boundary violated! Free VRAM: {vram['free_mb']} MiB < 500 MiB threshold.")
            
        if (i + 1) % accum_steps == 0:
            grad_norm = torch.nn.utils.clip_grad_norm_(peft_model.parameters(), 1.0)
            if not torch.isfinite(grad_norm):
                raise RuntimeError(f"Check A2 Failed: Non-finite gradient norm at step {optimizer_updates + 1}")
            optimizer.step()
            optimizer.zero_grad()
            optimizer_updates += 1
            avg_loss = sum(step_losses[-accum_steps:]) / accum_steps
            print(f"  Step {optimizer_updates}/{num_examples // accum_steps} (Examples {i-accum_steps+2}..{i+1}): Avg Loss={avg_loss:.4f} | Grad Norm={grad_norm.item():.4f} | VRAM: {vram}")
            
    if optimizer_updates != (num_examples // accum_steps):
        raise RuntimeError(f"Check A2 Failed: Expected {num_examples // accum_steps} optimizer updates, got {optimizer_updates}")
        
    print(f"\n7. Serializing Check A2 checkpoint to {output_dir}...")
    peft_model.save_pretrained(output_dir)
    
    print("8. Verifying Check A2 checkpoint reload...")
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
    
    for name, orig in orig_params.items():
        rel = reloaded_params[name].detach().cpu()
        if not torch.equal(orig, rel):
            raise RuntimeError(f"Check A2 Failed: Reloaded parameter mismatch for {name}")
            
    print(f"Check A2 Passed: 20 examples completed, {optimizer_updates} optimizer steps verified, checkpoint reloaded successfully.")
    
    del reloaded_model
    del reloaded_base
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return True

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.5-0.8B"
    seq_len = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    print(f"Executing Phase 0 Check A on {target} (seq_len={seq_len})...")
    run_check_a1(target)
    run_check_a2(target, seq_len=seq_len)
    print("\n=======================================================")
    print("ALL CHECK A TESTS PASSED!")
    print("=======================================================")
