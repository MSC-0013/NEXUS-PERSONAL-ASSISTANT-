#!/usr/bin/env python3
"""
scripts/inspect_qwen_modules.py
PROJECT NEXUS V2.3 — Rev 2.3.8 Pre-Training Smoke Test (TEST-W15-17A)

Stage-by-stage inner verification:
1. VRAM headroom preflight: queries torch.cuda.mem_get_info(), aborts if free VRAM < 4,500 MiB
2. Configuration & commit verification: resolves commit and validates Qwen3_5TextConfig layer_types
3. Weight loading diagnostics: loads Qwen3_5ForCausalLM, checks missing/unexpected keys against multi-modal whitelist
4. Module introspection: validates DeltaNet vs Attention projections per layer
5. LoRA adapter attachment & FQN target set validation: asserts actual_adapted_fqns == expected_adapted_fqns
6. Forward/backward pass: verifies finite loss and backward execution
7. Gradient check: non-zero gradient for all lora_B parameters; finite gradient for lora_A (zero-init B accounting)
8. Optimizer update & immediate clone cleanup: verifies aggregate delta > 0, all lora_B updated, deletes param_before
9. Isolated per-run adapter serialization & eval-mode equivalence:
   - Uses unique timestamped temporary directory
   - Records artifact SHA-256 hashes
   - Deallocates model, optimizer, cache; measures post-teardown VRAM against pre-load baseline
   - Reloads base model + adapter into eval() mode, asserts logit diff < 1e-3
   - Cleans up temporary artifacts on success
10. Peak memory reporting: PyTorch peak allocated, peak reserved, and total device memory
11. Structured evidence output in try/finally block distinguishing PASS/FAIL/NOT_RUN across all stages
"""

import os
import sys
import gc
import json
import time
import shutil
import hashlib
import tempfile
import traceback
import torch

MODEL_ID = "Qwen/Qwen3.5-0.8B"
EXPECTED_COMMIT = "2fc06364715b967f1860aea9cf38778875588b17"
MIN_FREE_VRAM_HEADROOM_MIB = 4500.0
PROPOSED_PEAK_VRAM_TARGET_MIB = 3800.0
TEARDOWN_TOLERANCE_MIB = 50.0
LOG_OUTPUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs", "smoke_test_w15_17a.json")

def get_installed_package_version(pkg_name):
    try:
        import importlib.metadata
        return importlib.metadata.version(pkg_name)
    except Exception:
        try:
            mod = __import__(pkg_name)
            return getattr(mod, "__version__", "UNKNOWN")
        except Exception:
            return "NOT_INSTALLED"

def compute_dir_hashes(dir_path):
    hashes = {}
    if not os.path.exists(dir_path):
        return hashes
    for root, _, files in os.walk(dir_path):
        for f in sorted(files):
            full_p = os.path.join(root, f)
            rel_p = os.path.relpath(full_p, dir_path)
            h = hashlib.sha256()
            with open(full_p, "rb") as fp:
                while chunk := fp.read(65536):
                    h.update(chunk)
            hashes[rel_p] = h.hexdigest()
    return hashes

def run_smoke_test():
    run_uid = f"smoke_run_{int(time.time())}_{os.getpid()}"
    temp_artifact_dir = os.path.join(tempfile.gettempdir(), "nexus_smoke_artifacts", run_uid)
    cleanup_artifact_dir = False

    evidence = {
        "test_id": "TEST-W15-17A",
        "spec_revision": "Rev 2.3.8",
        "run_uid": run_uid,
        "timestamp_epoch": int(time.time()),
        "model_id": MODEL_ID,
        "pinned_commit": EXPECTED_COMMIT,
        "environment": {
            "python_version": sys.version,
            "torch_version": torch.__version__,
            "transformers_version": get_installed_package_version("transformers"),
            "peft_version": get_installed_package_version("peft"),
            "accelerate_version": get_installed_package_version("accelerate"),
            "cuda_available": torch.cuda.is_available(),
            "cuda_device_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "N/A"
        },
        "stages": {
            "vram_preflight": {"status": "NOT_RUN"},
            "config_verification": {"status": "NOT_RUN"},
            "weight_loading": {"status": "NOT_RUN"},
            "module_introspection": {"status": "NOT_RUN"},
            "adapter_attachment": {"status": "NOT_RUN"},
            "forward_backward": {"status": "NOT_RUN"},
            "gradient_verification": {"status": "NOT_RUN"},
            "optimizer_update": {"status": "NOT_RUN"},
            "save_reload_equivalence": {"status": "NOT_RUN"}
        },
        "overall_verdict": "FAIL"
    }

    current_stage = "initialization"

    try:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for TEST-W15-17A execution.")

        device = "cuda:0"
        torch.cuda.reset_peak_memory_stats(device)

        print("================================================================================")
        print("PROJECT NEXUS V2.3 — Rev 2.3.8 LoRA Smoke Test (TEST-W15-17A)")
        print(f"Target Model: {MODEL_ID} @ {EXPECTED_COMMIT[:12]} | Run UID: {run_uid}")
        print(f"PyTorch: {torch.__version__} | Transformers: {evidence['environment']['transformers_version']} | PEFT: {evidence['environment']['peft_version']}")
        print(f"Device: {torch.cuda.get_device_name(0)}")
        print("================================================================================")

        # ----------------------------------------------------------------------
        # Stage 1: VRAM Headroom Preflight
        # ----------------------------------------------------------------------
        current_stage = "vram_preflight"
        free_bytes, total_bytes = torch.cuda.mem_get_info(device)
        free_mib = free_bytes / (1024 * 1024)
        total_mib = total_bytes / (1024 * 1024)
        baseline_allocated_mib = torch.cuda.memory_allocated(device) / (1024 * 1024)
        
        evidence["stages"]["vram_preflight"] = {
            "status": "PASS" if free_mib >= MIN_FREE_VRAM_HEADROOM_MIB else "FAIL",
            "free_vram_mib": free_mib,
            "total_vram_mib": total_mib,
            "baseline_allocated_mib": baseline_allocated_mib,
            "required_headroom_mib": MIN_FREE_VRAM_HEADROOM_MIB
        }
        
        print(f"[1/9] VRAM Preflight: {free_mib:.2f} MiB free / {total_mib:.2f} MiB total (Baseline allocated: {baseline_allocated_mib:.2f} MiB)")
        if free_mib < MIN_FREE_VRAM_HEADROOM_MIB:
            raise RuntimeError(
                f"INSUFFICIENT_VRAM_HEADROOM: Free VRAM is {free_mib:.2f} MiB, below required threshold of {MIN_FREE_VRAM_HEADROOM_MIB} MiB. "
                "Active production model or concurrent workloads must be quiescent before launching training verification."
            )

        # ----------------------------------------------------------------------
        # Stage 2: Configuration & Commit Resolution
        # ----------------------------------------------------------------------
        current_stage = "config_verification"
        print("[2/9] Resolving and verifying model configuration...")
        from transformers import AutoConfig, Qwen3_5ForCausalLM
        from peft import LoraConfig, get_peft_model, PeftModel

        config = AutoConfig.from_pretrained(MODEL_ID, revision=EXPECTED_COMMIT)
        top_arch = getattr(config, "architectures", ["UNKNOWN"])[0]
        text_config = config.text_config if hasattr(config, "text_config") else config
        assert hasattr(text_config, "layer_types"), "text_config missing required 'layer_types' definition"
        num_layers = len(text_config.layer_types)

        linear_layers = [i for i, lt in enumerate(text_config.layer_types) if lt == "linear_attention"]
        full_layers = [i for i, lt in enumerate(text_config.layer_types) if lt == "full_attention"]
        assert len(linear_layers) + len(full_layers) == num_layers, "Unexpected layer type found in config"

        evidence["stages"]["config_verification"] = {
            "status": "PASS",
            "top_architecture": top_arch,
            "resolved_commit": EXPECTED_COMMIT,
            "total_layers": num_layers,
            "linear_attention_layers": len(linear_layers),
            "full_attention_layers": len(full_layers)
        }

        # ----------------------------------------------------------------------
        # Stage 3: Loading Weights with Diagnostic Inspection
        # ----------------------------------------------------------------------
        current_stage = "weight_loading"
        print("[3/9] Loading text causal model weights with diagnostic inspection...")
        model, loading_info = Qwen3_5ForCausalLM.from_pretrained(
            MODEL_ID,
            revision=EXPECTED_COMMIT,
            config=text_config,
            torch_dtype=torch.bfloat16,
            device_map=device,
            output_loading_info=True
        )

        missing_keys = loading_info.get("missing_keys", [])
        unexpected_keys = loading_info.get("unexpected_keys", [])
        allowed_non_text_prefixes = ("visual.", "vision.", "patch_embed.", "visual_projector.", "model.visual.")
        for k in missing_keys:
            assert any(k.startswith(p) for p in allowed_non_text_prefixes), f"CRITICAL non-vision missing key: {k}"
        for k in unexpected_keys:
            assert any(k.startswith(p) for p in allowed_non_text_prefixes), f"CRITICAL non-vision unexpected key: {k}"

        evidence["stages"]["weight_loading"] = {
            "status": "PASS",
            "missing_keys_count": len(missing_keys),
            "unexpected_keys_count": len(unexpected_keys)
        }

        # ----------------------------------------------------------------------
        # Stage 4: Module Introspection Against config.layer_types
        # ----------------------------------------------------------------------
        current_stage = "module_introspection"
        print("[4/9] Validating instantiated modules against layer_types...")
        for i, layer in enumerate(model.model.layers):
            expected_type = text_config.layer_types[i]
            if expected_type == "linear_attention":
                assert hasattr(layer, "linear_attn") and not hasattr(layer, "self_attn")
                for mod in ["in_proj_qkv", "in_proj_z", "in_proj_b", "in_proj_a", "out_proj"]:
                    assert hasattr(layer.linear_attn, mod), f"Layer {i} missing DeltaNet projection {mod}"
            elif expected_type == "full_attention":
                assert hasattr(layer, "self_attn") and not hasattr(layer, "linear_attn")
                for mod in ["q_proj", "k_proj", "v_proj", "o_proj"]:
                    assert hasattr(layer.self_attn, mod), f"Layer {i} missing attention projection {mod}"
            for mod in ["gate_proj", "up_proj", "down_proj"]:
                assert hasattr(layer.mlp, mod), f"Layer {i} missing MLP projection {mod}"

        evidence["stages"]["module_introspection"] = {"status": "PASS", "layers_validated": num_layers}

        # ----------------------------------------------------------------------
        # Stage 5: LoRA Attachment & Exact FQN Target Set Inventory Check
        # ----------------------------------------------------------------------
        current_stage = "adapter_attachment"
        print("[5/9] Attaching LoRA adapters and asserting exact FQN target set...")
        target_projections = [
            "q_proj", "k_proj", "v_proj", "o_proj",
            "in_proj_qkv", "in_proj_z", "in_proj_b", "in_proj_a", "out_proj",
            "gate_proj", "up_proj", "down_proj"
        ]
        peft_config = LoraConfig(
            r=16,
            lora_alpha=32,
            target_modules=target_projections,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM"
        )
        model = get_peft_model(model, peft_config)

        expected_adapted_fqns = set()
        for i, lt in enumerate(text_config.layer_types):
            if lt == "linear_attention":
                for p in ["in_proj_qkv", "in_proj_z", "in_proj_b", "in_proj_a", "out_proj"]:
                    expected_adapted_fqns.add(f"base_model.model.model.layers.{i}.linear_attn.{p}")
            elif lt == "full_attention":
                for p in ["q_proj", "k_proj", "v_proj", "o_proj"]:
                    expected_adapted_fqns.add(f"base_model.model.model.layers.{i}.self_attn.{p}")
            for p in ["gate_proj", "up_proj", "down_proj"]:
                expected_adapted_fqns.add(f"base_model.model.model.layers.{i}.mlp.{p}")

        actual_adapted_fqns = set()
        for name, module in model.named_modules():
            if hasattr(module, "lora_A") and hasattr(module, "lora_B"):
                if getattr(module.lora_A, "default", None) is not None and getattr(module.lora_B, "default", None) is not None:
                    actual_adapted_fqns.add(name)

        missing_targets = expected_adapted_fqns - actual_adapted_fqns
        unexpected_targets = actual_adapted_fqns - expected_adapted_fqns
        if missing_targets or unexpected_targets:
            raise AssertionError(f"FQN target mismatch! Missing: {sorted(list(missing_targets))} | Unexpected: {sorted(list(unexpected_targets))}")

        for name, param in model.named_parameters():
            if param.requires_grad:
                assert ("lora_A" in name or "lora_B" in name), f"Unexpected non-LoRA trainable parameter: {name}"
                assert not any(v in name for v in ["visual", "vision", "patch_embed"]), f"Vision adapter found: {name}"
                assert not any(v in name for v in ["embed_tokens", "lm_head", "norm"]), f"Frozen parameter made trainable: {name}"

        trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total_params = sum(p.numel() for p in model.parameters())
        ratio = trainable_params / total_params
        assert 0.005 <= ratio <= 0.020, f"Trainable ratio {ratio:.4f} outside bounds [0.005, 0.020]"

        evidence["stages"]["adapter_attachment"] = {
            "status": "PASS",
            "adapted_projections_count": len(actual_adapted_fqns),
            "trainable_parameters": trainable_params,
            "total_parameters": total_params,
            "trainable_ratio": ratio
        }

        # ----------------------------------------------------------------------
        # Stage 6: Forward and Backward Pass
        # ----------------------------------------------------------------------
        current_stage = "forward_backward"
        print("[6/9] Executing forward and backward pass...")
        input_ids = torch.randint(0, 1000, (1, 16), device=device)
        outputs = model(input_ids, labels=input_ids)
        loss = outputs.loss
        assert torch.isfinite(loss), f"Loss is non-finite: {loss.item()}"
        loss.backward()

        evidence["stages"]["forward_backward"] = {"status": "PASS", "loss_value": loss.item()}

        # ----------------------------------------------------------------------
        # Stage 7: Gradient Check (Accounting for Zero-Init LoRA B)
        # ----------------------------------------------------------------------
        current_stage = "gradient_verification"
        print("[7/9] Verifying gradients (accounting for standard zero-init LoRA B)...")
        lora_b_grad_present = 0
        lora_a_finite = 0
        for name, param in model.named_parameters():
            if param.requires_grad:
                assert param.grad is not None, f"Parameter {name} has None gradient"
                assert torch.isfinite(param.grad).all(), f"Parameter {name} has non-finite gradient"
                if "lora_B" in name:
                    assert param.grad.abs().sum().item() > 0, f"LoRA B parameter {name} has zero gradient"
                    lora_b_grad_present += 1
                elif "lora_A" in name:
                    lora_a_finite += 1

        evidence["stages"]["gradient_verification"] = {
            "status": "PASS",
            "lora_b_gradients_nonzero": lora_b_grad_present,
            "lora_a_gradients_finite": lora_a_finite
        }

        # ----------------------------------------------------------------------
        # Stage 8: Optimizer Step & Parameter Update (With Immediate Clone Cleanup)
        # ----------------------------------------------------------------------
        current_stage = "optimizer_update"
        print("[8/9] Executing optimizer step & validating parameter update delta...")
        param_before = {name: p.clone().detach() for name, p in model.named_parameters() if p.requires_grad}
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4)
        optimizer.step()

        total_delta = sum((p - param_before[name]).abs().sum().item() for name, p in model.named_parameters() if p.requires_grad)
        assert total_delta > 0, "CRITICAL: Aggregate adapter parameter update is zero!"

        lora_b_updates = 0
        for name, p in model.named_parameters():
            if p.requires_grad and "lora_B" in name:
                assert (p - param_before[name]).abs().sum().item() > 0, f"LoRA B parameter {name} failed to update"
                lora_b_updates += 1

        # Delete clones immediately to prevent VRAM retention during reload
        del param_before
        gc.collect()

        evidence["stages"]["optimizer_update"] = {
            "status": "PASS",
            "aggregate_delta": total_delta,
            "lora_b_parameters_updated": lora_b_updates
        }

        # ----------------------------------------------------------------------
        # Stage 9: Isolated Per-Run Artifact Save, Release, Reload & Equivalence
        # ----------------------------------------------------------------------
        current_stage = "save_reload_equivalence"
        print(f"[9/9] Testing adapter save to unique run dir {temp_artifact_dir}...")
        model.eval()
        with torch.no_grad():
            ref_logits = model(input_ids).logits.detach().cpu()

        os.makedirs(temp_artifact_dir, exist_ok=True)
        model.save_pretrained(temp_artifact_dir)
        saved_file_hashes = compute_dir_hashes(temp_artifact_dir)
        assert len(saved_file_hashes) > 0, "Failed to save adapter files: directory is empty"

        # Full memory teardown of initial model and optimizer
        del model, optimizer, outputs, loss
        gc.collect()
        torch.cuda.empty_cache()

        post_teardown_allocated_mib = torch.cuda.memory_allocated(device) / (1024 * 1024)
        print(f"  Memory after teardown: {post_teardown_allocated_mib:.2f} MiB (Baseline: {baseline_allocated_mib:.2f} MiB)")
        allocated_delta = abs(post_teardown_allocated_mib - baseline_allocated_mib)
        assert allocated_delta <= TEARDOWN_TOLERANCE_MIB, f"Teardown failed to release weights: delta {allocated_delta:.2f} MiB > {TEARDOWN_TOLERANCE_MIB} MiB tolerance"

        # Reload base model and adapter into evaluation mode
        base_model = Qwen3_5ForCausalLM.from_pretrained(
            MODEL_ID,
            revision=EXPECTED_COMMIT,
            config=text_config,
            torch_dtype=torch.bfloat16,
            device_map=device
        )
        reloaded_model = PeftModel.from_pretrained(base_model, temp_artifact_dir)
        reloaded_model.eval()

        with torch.no_grad():
            reloaded_logits = reloaded_model(input_ids).logits.detach().cpu()

        max_logit_diff = (ref_logits - reloaded_logits).abs().max().item()
        assert max_logit_diff < 1e-3, f"Logits diverged after reload: max diff {max_logit_diff}"

        del base_model, reloaded_model
        gc.collect()
        torch.cuda.empty_cache()

        peak_allocated_mib = torch.cuda.max_memory_allocated(device) / (1024 * 1024)
        peak_reserved_mib = torch.cuda.max_memory_reserved(device) / (1024 * 1024)

        evidence["stages"]["save_reload_equivalence"] = {
            "status": "PASS",
            "artifact_dir": temp_artifact_dir,
            "artifact_hashes": saved_file_hashes,
            "max_logit_deviation": max_logit_diff,
            "post_teardown_allocated_mib": post_teardown_allocated_mib,
            "baseline_allocated_mib": baseline_allocated_mib,
            "peak_allocated_vram_mib": peak_allocated_mib,
            "peak_reserved_vram_mib": peak_reserved_mib,
            "proposed_target_mib": PROPOSED_PEAK_VRAM_TARGET_MIB
        }

        cleanup_artifact_dir = True
        evidence["overall_verdict"] = "PASS"
        print("TEST-W15-17A SMOKE TEST COMPLETED SUCCESSFULLY (VERDICT: PASS)")

    except Exception as e:
        print(f"\nCRITICAL FAILURE at stage [{current_stage}]: {e}", file=sys.stderr)
        traceback.print_exc()
        evidence["overall_verdict"] = "FAIL"
        evidence["failed_stage"] = current_stage
        evidence["error_message"] = str(e)
        evidence["traceback"] = traceback.format_exc()
        if current_stage in evidence["stages"]:
            evidence["stages"][current_stage]["status"] = "FAIL"
            evidence["stages"][current_stage]["error"] = str(e)

    finally:
        if cleanup_artifact_dir and os.path.exists(temp_artifact_dir):
            try:
                shutil.rmtree(temp_artifact_dir)
            except Exception as clean_err:
                print(f"Warning: Failed to clean up temp artifact dir: {clean_err}", file=sys.stderr)
        elif not cleanup_artifact_dir and os.path.exists(temp_artifact_dir):
            print(f"Preserving failure artifacts for post-mortem analysis at: {temp_artifact_dir}", file=sys.stderr)

        try:
            os.makedirs(os.path.dirname(LOG_OUTPUT_PATH), exist_ok=True)
            with open(LOG_OUTPUT_PATH, "w", encoding="utf-8") as f:
                json.dump(evidence, f, indent=2)
            print(f"Evidence log recorded: {LOG_OUTPUT_PATH} (Verdict: {evidence['overall_verdict']})")
        except Exception as write_err:
            print(f"Failed to record evidence log: {write_err}", file=sys.stderr)

    if evidence["overall_verdict"] != "PASS":
        sys.exit(1)

if __name__ == "__main__":
    run_smoke_test()
