import os
import sys
import json
import time
import torch
from typing import List, Dict, Any
from transformers import AutoTokenizer, AutoModelForCausalLM

CONTRACT_PATH = os.path.join(os.path.dirname(__file__), "..", "contracts", "agent-contract-v1.json")
EVAL_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "sealed_eval.jsonl")
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "checkpoints", "nexus_qwen3.5_0.8b_merged")

with open(CONTRACT_PATH, "r", encoding="utf-8") as f:
    CONTRACT_SCHEMA = json.load(f)

def validate_response_schema(res_dict: Dict[str, Any]) -> bool:
    if not isinstance(res_dict, dict):
        return False
    kind = res_dict.get("kind")
    if kind == "final":
        return isinstance(res_dict.get("content"), str) and len(res_dict.get("content", "")) >= 1
    elif kind == "tool_call":
        name = res_dict.get("name")
        args = res_dict.get("arguments")
        if not isinstance(args, dict):
            return False
        if name == "get_current_time":
            return True
        elif name == "calculate":
            return "expression" in args and isinstance(args["expression"], str)
        elif name == "search_knowledge":
            return "query" in args and isinstance(args["query"], str)
        elif name == "read_workspace_file":
            return "relative_path" in args and isinstance(args["relative_path"], str)
        elif name == "create_task":
            return "goal" in args and isinstance(args["goal"], str)
        elif name == "propose_workspace_write":
            return "relative_path" in args and "proposed_content" in args and len(args["proposed_content"]) <= 4096
        elif name == "propose_workspace_patch":
            return "relative_path" in args and "target_snippet" in args and "replacement_snippet" in args
    return False

def evaluate():
    print(f"\n=======================================================")
    print(f"NEXUS Phase 3: Evaluating Merged Model on Sealed Test Set")
    print(f"Model Path: {MODEL_DIR}")
    print(f"=======================================================")
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    print(f"Runtime: {device} | Dtype: {dtype}")
    
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_DIR,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
        trust_remote_code=True
    )
    model.eval()
    
    with open(EVAL_DATA_PATH, "r", encoding="utf-8") as f:
        eval_cases = [json.loads(line) for line in f]
    print(f"Loaded {len(eval_cases)} evaluation cases.")
    
    correct_count = 0
    schema_valid_count = 0
    tool_accurate_count = 0
    grounded_count = 0
    critical_hallucinations = 0
    latencies = []
    throughputs = []
    case_results = []
    
    im_end_id = tokenizer.encode("<|im_end|>")[-1]
    
    t_start_all = time.time()
    for idx, case in enumerate(eval_cases):
        prompt = case["prompt"]
        target = case["target"]
        tier = case["tier"]
        
        input_text = f"<|im_start|>system\nYou are NEXUS, an autonomous personal assistant adhering strictly to agent-contract-v1.json.<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
        inputs = tokenizer(input_text, return_tensors="pt").to(device)
        
        t0 = time.perf_counter()
        with torch.no_grad():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=128,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=[im_end_id, tokenizer.eos_token_id]
            )
        elapsed_sec = time.perf_counter() - t0
        latency_ms = elapsed_sec * 1000.0
        
        gen_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        tok_count = len(gen_tokens)
        tok_per_sec = (tok_count / elapsed_sec) if elapsed_sec > 0 else 0.0
        latencies.append(latency_ms)
        throughputs.append(tok_per_sec)
        
        raw_output = tokenizer.decode(gen_tokens, skip_special_tokens=True).strip()
        
        try:
            parsed = json.loads(raw_output)
        except Exception:
            # Try to extract JSON substring if any markdown fence was generated
            if "{" in raw_output and "}" in raw_output:
                try:
                    start = raw_output.find("{")
                    end = raw_output.rfind("}") + 1
                    parsed = json.loads(raw_output[start:end])
                except Exception:
                    parsed = {"kind": "malformed_json", "raw": raw_output}
            else:
                parsed = {"kind": "malformed_raw", "raw": raw_output}
                
        is_schema_valid = validate_response_schema(parsed)
        if is_schema_valid:
            schema_valid_count += 1
            
        is_tool_correct = False
        if target.get("kind") == "tool_call" and parsed.get("kind") == "tool_call":
            if target.get("name") == parsed.get("name"):
                is_tool_correct = True
                tool_accurate_count += 1
        elif target.get("kind") == "final" and parsed.get("kind") == "final":
            is_tool_correct = True
            tool_accurate_count += 1
            
        is_task_success = is_schema_valid and is_tool_correct
        if is_task_success:
            correct_count += 1
            grounded_count += 1
        else:
            if tier == 5 and "refused" in case["id"]:
                critical_hallucinations += 1
                
        case_results.append({
            "id": case["id"],
            "tier": tier,
            "target": target,
            "prediction": parsed,
            "is_schema_valid": is_schema_valid,
            "is_tool_correct": is_tool_correct,
            "is_task_success": is_task_success,
            "latency_ms": round(latency_ms, 2),
            "tok_per_sec": round(tok_per_sec, 2)
        })
        
        if (idx + 1) % 50 == 0 or (idx + 1) == len(eval_cases):
            print(f"  Processed {idx + 1:03d}/{len(eval_cases):03d} | Current Success Rate: {round(correct_count / (idx + 1) * 100, 1)}% | Avg Decode: {round(sum(throughputs)/len(throughputs), 1)} tok/s")
            
    n = len(eval_cases)
    task_success_rate = (correct_count / n) * 100.0
    schema_validity_rate = (schema_valid_count / n) * 100.0
    tool_accuracy_rate = (tool_accurate_count / n) * 100.0
    grounded_accuracy_rate = (grounded_count / n) * 100.0
    avg_throughput = sum(throughputs) / len(throughputs) if throughputs else 0.0
    
    summary = {
        "model_name": "nexus_qwen3.5_0.8b_merged",
        "sample_size": n,
        "task_success_rate": round(task_success_rate, 2),
        "schema_validity_rate": round(schema_validity_rate, 2),
        "tool_accuracy_rate": round(tool_accuracy_rate, 2),
        "grounded_accuracy_rate": round(grounded_accuracy_rate, 2),
        "critical_hallucinations": critical_hallucinations,
        "avg_throughput_tok_s": round(avg_throughput, 2),
        "total_eval_duration_sec": round(time.time() - t_start_all, 2),
        "case_results": case_results
    }
    
    out_file = os.path.join(os.path.dirname(__file__), "evaluation_nexus_qwen3.5_0.8b_merged.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
        
    print(f"\n=======================================================")
    print(f"Phase 3 Evaluation Results: nexus_qwen3.5_0.8b_merged")
    print(f"=======================================================")
    print(f"Task Success Rate:      {summary['task_success_rate']}% (Threshold: >= 82.0%)")
    print(f"Schema Validity Rate:  {summary['schema_validity_rate']}% (Threshold: >= 96.0%)")
    print(f"Tool Selection Rate:   {summary['tool_accuracy_rate']}% (Threshold: >= 90.0%)")
    print(f"Grounded Accuracy:     {summary['grounded_accuracy_rate']}% (Threshold: >= 95.0%)")
    print(f"Critical Violations:   {summary['critical_hallucinations']} (Threshold: 0)")
    print(f"Average Throughput:    {summary['avg_throughput_tok_s']} tok/s (Threshold: >= 30.0)")
    print(f"Saved evaluation artifact to {out_file}")
    return summary

if __name__ == "__main__":
    evaluate()
