import os
import sys
from huggingface_hub import hf_hub_download

model_name = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3.5-0.8B"
print(f"Downloading model.safetensors-00001-of-00001.safetensors for {model_name}...")
try:
    path = hf_hub_download(repo_id=model_name, filename="model.safetensors-00001-of-00001.safetensors")
    print(f"Success! Cached at: {path}")
except Exception as e:
    print(f"Download failed: {type(e).__name__}: {e}")
    sys.exit(1)
