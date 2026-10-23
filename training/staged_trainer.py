import os
import sys
import time
import json
import hashlib
from typing import List, Dict, Any, Tuple
import torch
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModelForCausalLM, get_cosine_schedule_with_warmup
from peft import LoraConfig, get_peft_model, PeftModel

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, "data")
CHECKPOINT_DIR = os.path.join(ROOT_DIR, "checkpoints")

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
        "total_mb": round(total_b / (1024**2), 2)
    }

class StagedConversationDataset(Dataset):
    def __init__(self, items: List[Dict[str, Any]], tokenizer, max_seq_len: int = 384):
        self.examples = []
        im_end_token = "<|im_end|>\n"
        
        for item in items:
            messages = item.get("messages", [])
            # Construct ChatML text
            full_text = ""
            for msg in messages:
                full_text += f"<|im_start|>{msg['role']}\n{msg['content']}{im_end_token}"
                
            tokens = tokenizer(
                full_text,
                max_length=max_seq_len,
                truncation=True,
                padding="max_length",
                return_tensors="pt"
            )
            input_ids = tokens["input_ids"].squeeze(0)
            attention_mask = tokens["attention_mask"].squeeze(0)
            labels = input_ids.clone()
            
            # Mask out padding tokens
            labels[labels == tokenizer.pad_token_id] = -100
            
            # Optional: mask prompt tokens so loss is focused on assistant response
            # Locate assistant start token sequence
            try:
                assistant_tag = "<|im_start|>assistant\n"
                assistant_pos = full_text.find(assistant_tag)
                if assistant_pos != -1:
                    prompt_part = full_text[:assistant_pos + len(assistant_tag)]
                    prompt_len = len(tokenizer.encode(prompt_part, truncation=True, max_length=max_seq_len))
                    labels[:max(0, prompt_len - 1)] = -100
            except Exception:
                pass
                
            self.examples.append({
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "labels": labels
            })

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        return self.examples[idx]

# Define 5 Curriculum Stages
STAGE_DEFINITIONS = {
    "Stage_1": {
        "name": "Instruction Following, Formatting & Classification",
        "primary_categories": ["instruction_following", "intent_classification", "structured_output"],
        "weight_multiplier": 3,
        "epochs": 3,
        "lr": 2e-4
    },
    "Stage_2": {
        "name": "Tool Selection & Structured Agent Contract",
        "primary_categories": ["tool_selection", "structured_output", "reasoning_calculations"],
        "weight_multiplier": 3,
        "epochs": 3,
        "lr": 1.5e-4
    },
    "Stage_3": {
        "name": "Retrieval Grounding & Multi-Step Workflows",
        "primary_categories": ["retrieval_grounding", "multistep_planning", "reasoning_calculations"],
        "weight_multiplier": 3,
        "epochs": 3,
        "lr": 1.2e-4
    },
    "Stage_4": {
        "name": "Memory, Context Handling & Ambiguity",
        "primary_categories": ["memory_conversation", "ambiguity_clarification", "robustness_consistency"],
        "weight_multiplier": 3,
        "epochs": 3,
        "lr": 1.0e-4
    },
    "Stage_5": {
        "name": "Safety, Prompt-Injection Defense & Error Recovery + Balanced Replay",
        "primary_categories": ["safety_permissions", "error_recovery", "robustness_consistency"],
        "weight_multiplier": 3,
        "epochs": 3,
        "lr": 8e-5
    }
}

def load_all_training_items() -> List[Dict[str, Any]]:
    path = os.path.join(DATA_DIR, "train.jsonl")
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f]

def load_validation_items() -> List[Dict[str, Any]]:
    path = os.path.join(DATA_DIR, "validation.jsonl")
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f]

def filter_curriculum_batch(all_items: List[Dict[str, Any]], stage_cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    primary = set(stage_cfg["primary_categories"])
    batch = []
    # Primary focus categories are repeated based on multiplier
    for item in all_items:
        cat = item.get("category", "")
        if cat in primary:
            for _ in range(stage_cfg["weight_multiplier"]):
                batch.append(item)
        else:
            # Replay background categories to avoid catastrophic forgetting
            batch.append(item)
    return batch

def run_continuous_staged_training(
    base_model_name: str = "Qwen/Qwen3.5-0.8B",
    resume_checkpoint: str = None,
    max_stages: int = 5,
    max_active_seconds: float = 21600.0, # 6 hours
    micro_batch: int = 1,
    grad_accum: int = 4,
    max_seq_len: int = 384
):
    print("=========================================================================")
    print("PROJECT NEXUS: 6-HOUR CONTINUOUS TRAINING & EVALUATION SYSTEM")
    print(f"Base Model: {base_model_name}")
    print(f"Target Active Training Budget: {round(max_active_seconds / 3600, 2)} hours ({max_active_seconds}s)")
    print("Hardware: RTX 4050 6GB VRAM (Ada Lovelace, Compute 8.9)")
    print("=========================================================================")
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (device == "cuda" and torch.cuda.is_bf16_supported()) else torch.float16
    print(f"Compute Target: {device} | Dtype: {dtype}")
    
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    all_train_items = load_all_training_items()
    val_items = load_validation_items()
    print(f"Loaded {len(all_train_items)} training pool records and {len(val_items)} validation records.")
    
    tokenizer = AutoTokenizer.from_pretrained(base_model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    val_dataset = StagedConversationDataset(val_items, tokenizer, max_seq_len=max_seq_len)
    val_loader = DataLoader(val_dataset, batch_size=micro_batch, shuffle=False)
    
    print("\nLoading base model...")
    base_model = AutoModelForCausalLM.from_pretrained(
        base_model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    
    if resume_checkpoint and os.path.exists(resume_checkpoint):
        print(f"Resuming LoRA adapter from {resume_checkpoint}...")
        peft_model = PeftModel.from_pretrained(base_model, resume_checkpoint, is_trainable=True)
    else:
        print("Configuring fresh LoRA adapter (Rank=16, Alpha=32, target: all projections)...")
        lora_config = LoraConfig(
            r=16,
            lora_alpha=32,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM"
        )
        peft_model = get_peft_model(base_model, lora_config)
        
    peft_model.gradient_checkpointing_enable()
    peft_model.print_trainable_parameters()
    
    cumulative_active_training_sec = 0.0
    global_step = 0
    total_tokens_processed = 0
    total_examples_processed = 0
    
    best_overall_val_loss = float("inf")
    best_candidate_checkpoint_path = os.path.join(CHECKPOINT_DIR, "nexus_continuous_best_lora")
    
    stage_summaries = []
    continuous_log = []
    
    stage_keys = list(STAGE_DEFINITIONS.keys())[:max_stages]
    
    for stage_idx, stage_key in enumerate(stage_keys):
        stage_cfg = STAGE_DEFINITIONS[stage_key]
        stage_name = stage_cfg["name"]
        stage_epochs = stage_cfg["epochs"]
        stage_lr = stage_cfg["lr"]
        
        print(f"\n=========================================================================")
        print(f"BEGINNING {stage_key.upper()}: {stage_name}")
        print(f"Primary Focus: {', '.join(stage_cfg['primary_categories'])}")
        print(f"Config: Epochs={stage_epochs}, LR={stage_lr}, Accum={grad_accum}")
        print("=========================================================================")
        
        stage_batch = filter_curriculum_batch(all_train_items, stage_cfg)
        print(f"Curriculum-weighted training set size: {len(stage_batch)} records")
        
        stage_dataset = StagedConversationDataset(stage_batch, tokenizer, max_seq_len=max_seq_len)
        stage_loader = DataLoader(stage_dataset, batch_size=micro_batch, shuffle=True)
        
        total_stage_steps = (len(stage_loader) // grad_accum) * stage_epochs
        optimizer = torch.optim.AdamW(peft_model.parameters(), lr=stage_lr, weight_decay=0.01)
        scheduler = get_cosine_schedule_with_warmup(
            optimizer,
            num_warmup_steps=max(5, int(0.08 * total_stage_steps)),
            num_training_steps=total_stage_steps
        )
        
        stage_start_t = time.time()
        stage_best_val_loss = float("inf")
        stage_loss_history = []
        
        optimizer.zero_grad()
        peft_model.train()
        
        for epoch in range(stage_epochs):
            if cumulative_active_training_sec >= max_active_seconds:
                print(f"Reached 6-hour active training budget limit ({cumulative_active_training_sec:.1f}s). Halting.")
                break
                
            accum_loss = 0.0
            epoch_loss = 0.0
            
            for step_idx, batch in enumerate(stage_loader):
                step_t0 = time.time()
                input_ids = batch["input_ids"].to(device)
                attention_mask = batch["attention_mask"].to(device)
                labels = batch["labels"].to(device)
                
                outputs = peft_model(input_ids=input_ids, attention_mask=attention_mask, labels=labels)
                loss = outputs.loss / grad_accum
                
                if not torch.isfinite(loss):
                    print(f"Warning: Non-finite loss encountered at step {step_idx}. Skipping step.")
                    optimizer.zero_grad()
                    continue
                    
                loss.backward()
                accum_loss += loss.item() * grad_accum
                
                step_dt = time.time() - step_t0
                cumulative_active_training_sec += step_dt
                total_tokens_processed += input_ids.numel()
                total_examples_processed += micro_batch
                
                # Check VRAM safety margin
                vram = get_vram_telemetry()
                if device == "cuda" and vram.get("free_mb", 1000) < 500:
                    raise RuntimeError(f"VRAM SAFETY TRIP: Free VRAM dropped to {vram['free_mb']} MiB. Halting.")
                    
                if (step_idx + 1) % grad_accum == 0:
                    grad_norm = torch.nn.utils.clip_grad_norm_(peft_model.parameters(), 1.0)
                    optimizer.step()
                    scheduler.step()
                    optimizer.zero_grad()
                    global_step += 1
                    
                    step_avg_loss = accum_loss / grad_accum
                    epoch_loss += step_avg_loss
                    stage_loss_history.append(step_avg_loss)
                    
                    record = {
                        "global_step": global_step,
                        "stage": stage_key,
                        "epoch": epoch + 1,
                        "loss": round(step_avg_loss, 4),
                        "grad_norm": round(grad_norm.item(), 4),
                        "lr": scheduler.get_last_lr()[0],
                        "vram_alloc_mb": vram["allocated_mb"],
                        "vram_free_mb": vram["free_mb"],
                        "active_sec": round(cumulative_active_training_sec, 2),
                        "examples_processed": total_examples_processed,
                        "tokens_processed": total_tokens_processed
                    }
                    continuous_log.append(record)
                    
                    if global_step % 20 == 0:
                        print(f"  [{stage_key} Ep {epoch+1} Step {global_step:04d}] Loss: {record['loss']} | GradNorm: {record['grad_norm']} | VRAM Free: {vram['free_mb']} MiB | Time: {record['active_sec']}s")
                        
                    accum_loss = 0.0
                    
            # End of epoch validation check
            print(f"Running validation pass for {stage_key} Epoch {epoch + 1}...")
            peft_model.eval()
            val_loss = 0.0
            with torch.no_grad():
                for vbatch in val_loader:
                    v_ids = vbatch["input_ids"].to(device)
                    v_mask = vbatch["attention_mask"].to(device)
                    v_lbls = vbatch["labels"].to(device)
                    v_out = peft_model(input_ids=v_ids, attention_mask=v_mask, labels=v_lbls)
                    val_loss += v_out.loss.item()
            peft_model.train()
            
            avg_val_loss = val_loss / len(val_loader)
            print(f"--> {stage_key} Epoch {epoch + 1} Validation Loss: {avg_val_loss:.4f} (Stage Best: {stage_best_val_loss:.4f})")
            
            if avg_val_loss < stage_best_val_loss:
                stage_best_val_loss = avg_val_loss
                stage_checkpoint_path = os.path.join(CHECKPOINT_DIR, f"checkpoint_{stage_key.lower()}_best")
                peft_model.save_pretrained(stage_checkpoint_path)
                tokenizer.save_pretrained(stage_checkpoint_path)
                print(f"  Saved {stage_key} stage best checkpoint to {stage_checkpoint_path}")
                
            if avg_val_loss < best_overall_val_loss:
                best_overall_val_loss = avg_val_loss
                peft_model.save_pretrained(best_candidate_checkpoint_path)
                tokenizer.save_pretrained(best_candidate_checkpoint_path)
                print(f"  ⭐ NEW OVERALL BEST CHECKPOINT! Saved to {best_candidate_checkpoint_path} (Val Loss: {best_overall_val_loss:.4f})")
                
        stage_duration = time.time() - stage_start_t
        stage_summary = {
            "stage_key": stage_key,
            "stage_name": stage_name,
            "stage_duration_wall_sec": round(stage_duration, 2),
            "best_stage_val_loss": round(stage_best_val_loss, 4),
            "stage_epochs_completed": stage_epochs,
            "stage_checkpoint": os.path.join(CHECKPOINT_DIR, f"checkpoint_{stage_key.lower()}_best")
        }
        stage_summaries.append(stage_summary)
        print(f"\nCompleted {stage_key} in {round(stage_duration, 2)}s wall time. Best Stage Val Loss: {stage_best_val_loss:.4f}")
        
    # Serialize master continuous log
    master_log_path = os.path.join(CHECKPOINT_DIR, "continuous_training_log.json")
    with open(master_log_path, "w", encoding="utf-8") as f:
        json.dump({
            "base_model": base_model_name,
            "total_active_training_seconds": round(cumulative_active_training_sec, 2),
            "total_optimizer_steps": global_step,
            "total_examples_processed": total_examples_processed,
            "total_tokens_processed": total_tokens_processed,
            "best_overall_val_loss": round(best_overall_val_loss, 4),
            "best_candidate_checkpoint": best_candidate_checkpoint_path,
            "stage_summaries": stage_summaries,
            "step_log": continuous_log
        }, f, indent=2)
        
    print(f"\n=========================================================================")
    print(f"CONTINUOUS STAGED TRAINING RUN COMPLETE")
    print(f"Cumulative Active Training Time: {round(cumulative_active_training_sec, 2)}s ({round(cumulative_active_training_sec/3600, 2)} hours)")
    print(f"Total Optimizer Steps: {global_step}")
    print(f"Total Tokens Processed: {total_tokens_processed:,}")
    print(f"Best Validation Loss: {best_overall_val_loss:.4f}")
    print(f"Best Checkpoint: {best_candidate_checkpoint_path}")
    print(f"Saved master log to: {master_log_path}")
    print("=========================================================================")
    
    return best_candidate_checkpoint_path

if __name__ == "__main__":
    run_continuous_staged_training()
