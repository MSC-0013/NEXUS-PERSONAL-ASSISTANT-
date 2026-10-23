import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import sys
import time
import json
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModelForCausalLM, get_cosine_schedule_with_warmup
from peft import LoraConfig, get_peft_model, PeftModel

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
CHECKPOINT_DIR = os.path.join(os.path.dirname(__file__), "checkpoints")

def get_vram_telemetry():
    if not torch.cuda.is_available():
        return {"allocated_mb": 0, "reserved_mb": 0, "free_mb": 0, "total_mb": 0}
    free_b, total_b = torch.cuda.mem_get_info()
    alloc_b = torch.cuda.memory_allocated()
    res_b = torch.cuda.memory_reserved()
    effective_free_b = max(0, total_b - alloc_b)
    return {
        "allocated_mb": round(alloc_b / (1024**2), 2),
        "reserved_mb": round(res_b / (1024**2), 2),
        "free_mb": round(effective_free_b / (1024**2), 2),
        "driver_free_mb": round(free_b / (1024**2), 2),
        "total_mb": round(total_b / (1024**2), 2)
    }

class NexusConversationDataset(Dataset):
    def __init__(self, jsonl_path: str, tokenizer, max_seq_len: int = 256):
        self.examples = []
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                item = json.loads(line)
                messages = item["messages"]
                # Build ChatML text
                text = ""
                for msg in messages:
                    text += f"<|im_start|>{msg['role']}\n{msg['content']}<|im_end|>\n"
                tokens = tokenizer(text, max_length=max_seq_len, truncation=True, padding="max_length", return_tensors="pt")
                input_ids = tokens["input_ids"].squeeze(0)
                attention_mask = tokens["attention_mask"].squeeze(0)
                labels = input_ids.clone()
                # Mask out padding tokens from loss
                labels[labels == tokenizer.pad_token_id] = -100
                self.examples.append({
                    "input_ids": input_ids,
                    "attention_mask": attention_mask,
                    "labels": labels
                })

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        return self.examples[idx]

def train_lora(
    model_name: str,
    epochs: int = 1,
    micro_batch: int = 1,
    grad_accum: int = 4,
    learning_rate: float = 2e-4,
    max_seq_len: int = 256,
    output_dir: str = CHECKPOINT_DIR
):
    print(f"\n=======================================================")
    print(f"NEXUS Phase 2: SFT / LoRA Training on {model_name}")
    print(f"Config: epochs={epochs}, batch={micro_batch}, accum={grad_accum}, lr={learning_rate}, seq_len={max_seq_len}")
    print(f"=======================================================")
    os.makedirs(output_dir, exist_ok=True)
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    print(f"Device: {device} | Precision: {dtype}")
    
    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    print("Loading base model...")
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    
    # Configure LoRA
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
    
    train_path = os.path.join(DATA_DIR, "train.jsonl")
    val_path = os.path.join(DATA_DIR, "val.jsonl")
    print("Loading datasets...")
    train_dataset = NexusConversationDataset(train_path, tokenizer, max_seq_len=max_seq_len)
    val_dataset = NexusConversationDataset(val_path, tokenizer, max_seq_len=max_seq_len)
    
    train_loader = DataLoader(train_dataset, batch_size=micro_batch, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=micro_batch, shuffle=False)
    
    total_steps = (len(train_loader) // grad_accum) * epochs
    optimizer = torch.optim.AdamW(peft_model.parameters(), lr=learning_rate, weight_decay=0.01)
    scheduler = get_cosine_schedule_with_warmup(optimizer, num_warmup_steps=max(5, int(0.1 * total_steps)), num_training_steps=total_steps)
    
    best_val_loss = float("inf")
    best_checkpoint_path = os.path.join(output_dir, "best_lora_checkpoint")
    training_log = []
    
    global_step = 0
    t_start = time.time()
    optimizer.zero_grad()
    
    for epoch in range(epochs):
        print(f"\n--- Epoch {epoch + 1}/{epochs} ---")
        peft_model.train()
        epoch_loss = 0.0
        accum_loss = 0.0
        
        for step_idx, batch in enumerate(train_loader):
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)
            
            outputs = peft_model(input_ids=input_ids, attention_mask=attention_mask, labels=labels)
            loss = outputs.loss / grad_accum
            
            if not torch.isfinite(loss):
                raise RuntimeError(f"Training Failed: Non-finite loss at step {step_idx} ({loss.item()})")
                
            loss.backward()
            accum_loss += loss.item() * grad_accum
            
            # VRAM safety boundary monitor
            vram = get_vram_telemetry()
            if device == "cuda" and vram.get("free_mb", 1000) < 500:
                raise RuntimeError(f"Training Aborted: Free VRAM dropped below 500 MiB safety boundary ({vram['free_mb']} MiB).")
                
            if (step_idx + 1) % grad_accum == 0:
                grad_norm = torch.nn.utils.clip_grad_norm_(peft_model.parameters(), 1.0)
                if not torch.isfinite(grad_norm):
                    raise RuntimeError(f"Training Failed: Non-finite gradient norm at global step {global_step + 1}")
                    
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                global_step += 1
                
                step_avg_loss = accum_loss / grad_accum
                epoch_loss += step_avg_loss
                
                record = {
                    "global_step": global_step,
                    "epoch": epoch + 1,
                    "loss": round(step_avg_loss, 4),
                    "grad_norm": round(grad_norm.item(), 4),
                    "lr": scheduler.get_last_lr()[0],
                    "vram_allocated_mb": vram["allocated_mb"],
                    "vram_free_mb": vram["free_mb"],
                    "elapsed_sec": round(time.time() - t_start, 2)
                }
                training_log.append(record)
                
                if global_step % 10 == 0 or global_step == total_steps:
                    print(f"  Step {global_step:03d}/{total_steps:03d}: Loss={record['loss']} | GradNorm={record['grad_norm']} | VRAM Free={vram['free_mb']} MiB")
                    
                accum_loss = 0.0
                
        # Validation pass
        print("\nEvaluating on validation set...")
        peft_model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for val_batch in val_loader:
                v_ids = val_batch["input_ids"].to(device)
                v_mask = val_batch["attention_mask"].to(device)
                v_labels = val_batch["labels"].to(device)
                v_out = peft_model(input_ids=v_ids, attention_mask=v_mask, labels=v_labels)
                val_loss += v_out.loss.item()
                
        avg_val_loss = val_loss / len(val_loader)
        print(f"Epoch {epoch + 1} Validation Loss: {avg_val_loss:.4f} (Best: {best_val_loss:.4f})")
        
        if avg_val_loss < best_val_loss:
            best_val_loss = avg_val_loss
            print(f"--> New best validation loss! Saving checkpoint to {best_checkpoint_path}...")
            peft_model.save_pretrained(best_checkpoint_path)
            tokenizer.save_pretrained(best_checkpoint_path)
            
    # Save training log
    log_path = os.path.join(output_dir, "training_log.json")
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump({
            "model_name": model_name,
            "total_steps": global_step,
            "best_val_loss": round(best_val_loss, 4),
            "total_duration_sec": round(time.time() - t_start, 2),
            "step_log": training_log
        }, f, indent=2)
        
    print(f"\nTraining Complete in {round(time.time() - t_start, 2)}s. Best Val Loss: {best_val_loss:.4f}")
    
    # Reload verification
    print("\nVerifying checkpoint reload fidelity...")
    in_memory_state = {k: v.cpu().clone() for k, v in peft_model.named_parameters() if "lora_" in k}
    del peft_model, model, optimizer, scheduler, train_loader, val_loader
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        
    reload_base = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    reloaded_peft = PeftModel.from_pretrained(reload_base, best_checkpoint_path)
    reloaded_state = {k: v.cpu() for k, v in reloaded_peft.named_parameters() if "lora_" in k}
    
    mismatch_count = 0
    for k in in_memory_state:
        if k not in reloaded_state:
            mismatch_count += 1
            print(f"Missing parameter in reloaded adapter: {k}")
        else:
            diff = (in_memory_state[k] - reloaded_state[k]).abs().max().item()
            if diff > 1e-5:
                mismatch_count += 1
                print(f"Parameter mismatch in {k}: max diff {diff}")
                
    if mismatch_count == 0:
        print(f"Checkpoint Reload Verification: 100% PASS ({len(in_memory_state)} tensors identical).")
    else:
        raise RuntimeError(f"Checkpoint reload failed with {mismatch_count} tensor mismatches.")
        
    del reloaded_peft, reload_base
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        
    return best_checkpoint_path

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.5-0.8B"
    train_lora(target, epochs=1, micro_batch=1, grad_accum=4, max_seq_len=256)
