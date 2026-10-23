import os
import sys
import time
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

BASE_MODEL = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.5-0.8B"
ADAPTER_DIR = os.path.join(os.path.dirname(__file__), "..", "training", "checkpoints", "best_lora_checkpoint")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "training", "checkpoints", "nexus_qwen3.5_0.8b_merged")

def merge():
    print(f"\n=======================================================")
    print(f"NEXUS Phase 3: LoRA Merge & Export")
    print(f"Base: {BASE_MODEL}")
    print(f"Adapter: {ADAPTER_DIR}")
    print(f"Output: {OUTPUT_DIR}")
    print(f"=======================================================")
    t0 = time.time()
    
    print("1. Loading tokenizer and base model onto CPU...")
    tokenizer = AutoTokenizer.from_pretrained(ADAPTER_DIR, trust_remote_code=True)
    base_model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.bfloat16,
        device_map="cpu",
        trust_remote_code=True
    )
    
    print("2. Attaching fine-tuned adapter...")
    peft_model = PeftModel.from_pretrained(base_model, ADAPTER_DIR)
    
    print("3. Merging adapter weights into base architecture...")
    merged_model = peft_model.merge_and_unload()
    
    print(f"4. Serializing merged model to {OUTPUT_DIR}...")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    merged_model.save_pretrained(OUTPUT_DIR, safe_serialization=True)
    tokenizer.save_pretrained(OUTPUT_DIR)
    
    print(f"Merge and serialization completed successfully in {round(time.time() - t0, 2)}s.")
    return OUTPUT_DIR

if __name__ == "__main__":
    merge()
