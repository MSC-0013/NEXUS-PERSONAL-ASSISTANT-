import json
import os
from safetensors import safe_open
from transformers import AutoConfig, Qwen3_5ForCausalLM

SNAPSHOT_DIR = os.path.expanduser("~/.cache/huggingface/hub/models--Qwen--Qwen3.5-0.8B/snapshots/2fc06364715b967f1860aea9cf38778875588b17")
SAFETENSORS_PATH = os.path.join(SNAPSHOT_DIR, "model.safetensors-00001-of-00001.safetensors")

def inspect_keys():
    with safe_open(SAFETENSORS_PATH, framework="pt") as f:
        safetensors_keys = set(f.keys())

    cfg = AutoConfig.from_pretrained(SNAPSHOT_DIR, local_files_only=True)
    text_cfg = cfg.text_config if hasattr(cfg, "text_config") else cfg

    # Instantiate on meta device (instantaneous, 0 RAM/VRAM)
    import torch
    with torch.device("meta"):
        model = Qwen3_5ForCausalLM(text_cfg)
    model_state_keys = set(model.state_dict().keys())

    # Check language_model vs visual keys
    lm_keys = {k for k in safetensors_keys if k.startswith("model.language_model.")}
    visual_keys = {k for k in safetensors_keys if k.startswith("model.visual.") or "visual" in k or "patch_embed" in k}
    other_keys = safetensors_keys - lm_keys - visual_keys

    # Load with Qwen3_5ForCausalLM.from_pretrained on meta device to get exact loading_info
    model_loaded, loading_info = Qwen3_5ForCausalLM.from_pretrained(
        SNAPSHOT_DIR,
        config=text_cfg,
        output_loading_info=True,
        local_files_only=True,
        device_map="meta"
    )

    result = {
        "total_safetensors_keys": len(safetensors_keys),
        "visual_keys_count": len(visual_keys),
        "lm_keys_count": len(lm_keys),
        "other_keys": list(other_keys),
        "other_keys_count": len(other_keys),
        "model_state_keys_count": len(model_state_keys),
        "loading_info_missing_keys": list(loading_info.get("missing_keys", [])),
        "loading_info_unexpected_keys_sample": list(loading_info.get("unexpected_keys", []))[:20],
        "loading_info_unexpected_keys_count": len(loading_info.get("unexpected_keys", [])),
    }

    # The 335 vs 320 question:
    # In earlier naive search: vision_keys = ['visual', 'vision', 'patch_embed'] found 153 keys -> 488 - 153 = 335.
    # But how many are actually visual/multimodal components?
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    inspect_keys()
