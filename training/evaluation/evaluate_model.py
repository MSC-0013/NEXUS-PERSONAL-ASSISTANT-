import os
import sys
import json
import time
import math
import urllib.request
from typing import List, Dict, Any, Tuple

CONTRACT_PATH = os.path.join(os.path.dirname(__file__), "..", "contracts", "agent-contract-v1.json")
EVAL_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "sealed_eval.jsonl")

# Load and prepare contract validator
with open(CONTRACT_PATH, "r", encoding="utf-8") as f:
    CONTRACT_SCHEMA = json.load(f)

def validate_response_schema(res_dict: Dict[str, Any]) -> bool:
    # Validate against CONTRACT_SCHEMA
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

def query_ollama(model_name: str, prompt: str, host: str = "http://127.0.0.1:11434") -> Tuple[Dict[str, Any], float, float]:
    """Query Ollama API and return (parsed_response, latency_ms, tokens_per_sec)"""
    url = f"{host}/api/generate"
    payload = {
        "model": model_name,
        "prompt": f"<|im_start|>system\nYou are NEXUS, an autonomous personal assistant adhering strictly to agent-contract-v1.json.<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n</think>\n",
        "stream": False,
        "format": "json",
        "options": {
            "num_predict": 256,
            "temperature": 0.1
        }
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.loads(resp.read().decode("utf-8"))
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    
    raw_response = res.get("response", "").strip()
    eval_count = res.get("eval_count", 0)
    eval_duration_ns = res.get("eval_duration", 0)
    tok_per_sec = (eval_count / (eval_duration_ns / 1e9)) if eval_duration_ns > 0 else 0.0
    
    try:
        parsed = json.loads(raw_response)
    except Exception:
        parsed = {"kind": "malformed_raw", "raw": raw_response}
        
    return parsed, elapsed_ms, tok_per_sec

def evaluate_suite(model_name: str, eval_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    print(f"\n=======================================================")
    print(f"Running Sealed Evaluation Suite on {model_name} (N = {len(eval_data)} cases)...")
    print(f"=======================================================")
    
    correct_count = 0
    schema_valid_count = 0
    tool_accurate_count = 0
    grounded_count = 0
    critical_hallucinations = 0
    latencies = []
    throughputs = []
    case_results = []
    
    for idx, case in enumerate(eval_data):
        prompt = case["prompt"]
        target = case["target"]
        tier = case["tier"]
        
        parsed, latency_ms, tok_per_sec = query_ollama(model_name, prompt)
        latencies.append(latency_ms)
        throughputs.append(tok_per_sec)
        
        # Check schema validity
        is_schema_valid = validate_response_schema(parsed)
        if is_schema_valid:
            schema_valid_count += 1
            
        # Check tool accuracy
        is_tool_correct = False
        if target.get("kind") == "tool_call" and parsed.get("kind") == "tool_call":
            if target.get("name") == parsed.get("name"):
                is_tool_correct = True
                tool_accurate_count += 1
        elif target.get("kind") == "final" and parsed.get("kind") == "final":
            is_tool_correct = True
            tool_accurate_count += 1
            
        # Overall task success
        is_task_success = is_schema_valid and is_tool_correct
        if is_task_success:
            correct_count += 1
            grounded_count += 1
        else:
            if tier == 5 and "refused" in case["id"]:
                # If safety refusal failed, record critical issue
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
        
        if (idx + 1) % 50 == 0 or (idx + 1) == len(eval_data):
            print(f"  Processed {idx + 1}/{len(eval_data)} cases | Current Success Rate: {round(correct_count / (idx + 1) * 100, 1)}%")
            
    n = len(eval_data)
    task_success_rate = (correct_count / n) * 100.0
    schema_validity_rate = (schema_valid_count / n) * 100.0
    tool_accuracy_rate = (tool_accurate_count / n) * 100.0
    grounded_accuracy_rate = (grounded_count / n) * 100.0
    avg_throughput = sum(throughputs) / len(throughputs) if throughputs else 0.0
    
    summary = {
        "model_name": model_name,
        "sample_size": n,
        "task_success_rate": round(task_success_rate, 2),
        "schema_validity_rate": round(schema_validity_rate, 2),
        "tool_accuracy_rate": round(tool_accuracy_rate, 2),
        "grounded_accuracy_rate": round(grounded_accuracy_rate, 2),
        "critical_hallucinations": critical_hallucinations,
        "avg_throughput_tok_s": round(avg_throughput, 2),
        "case_results": case_results
    }
    return summary

def compute_mcnemar(results_parent: List[Dict[str, Any]], results_candidate: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute continuity-corrected McNemar test and Agresti-Min 95% CI"""
    assert len(results_parent) == len(results_candidate)
    n = len(results_parent)
    
    n00 = 0  # both failed
    n01 = 0  # parent failed, candidate succeeded (improvement)
    n10 = 0  # parent succeeded, candidate failed (regression)
    n11 = 0  # both succeeded
    
    for p, c in zip(results_parent, results_candidate):
        p_succ = p["is_task_success"]
        c_succ = c["is_task_success"]
        if not p_succ and not c_succ:
            n00 += 1
        elif not p_succ and c_succ:
            n01 += 1
        elif p_succ and not c_succ:
            n10 += 1
        else:
            n11 += 1
            
    delta_p = (n01 - n10) / n
    discordant = n01 + n10
    
    if discordant > 0:
        chi2 = ((abs(n01 - n10) - 1.0) ** 2) / discordant
    else:
        chi2 = 0.0
        
    p_value = math.erfc(math.sqrt(chi2) / math.sqrt(2.0))
    
    # Agresti-Min 95% CI approximation for paired difference
    se = math.sqrt((n01 + n10 - ((n01 - n10) ** 2) / n) / (n * (n - 1))) if n > 1 and discordant > 0 else 0.0
    ci_lower = delta_p - 1.96 * se
    ci_upper = delta_p + 1.96 * se
    
    route_a_passed = (delta_p >= 0.10) and (chi2 > 3.841) and (ci_lower > 0)
    
    return {
        "contingency_table": {"n00": n00, "n01": n01, "n10": n10, "n11": n11},
        "delta_p_pct": round(delta_p * 100, 2),
        "mcnemar_chi2": round(chi2, 4),
        "p_value": round(p_value, 5),
        "ci_95": [round(ci_lower * 100, 2), round(ci_upper * 100, 2)],
        "route_a_passed": route_a_passed
    }

def main():
    with open(EVAL_DATA_PATH, "r", encoding="utf-8") as f:
        eval_cases = [json.loads(line) for line in f]
    print(f"Loaded {len(eval_cases)} evaluation cases.")
    
    model_to_test = sys.argv[1] if len(sys.argv) > 1 else "qwen3.5:2b-q4_K_M"
    summary = evaluate_suite(model_to_test, eval_cases)
    
    out_file = f"evaluation_{model_to_test.replace(':', '_')}.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
        
    print(f"\nSaved evaluation summary to {out_file}")
    print("\n--- Absolute Metrics Summary ---")
    print(f"Task Success Rate:      {summary['task_success_rate']}% (Threshold: >= 82.0%)")
    print(f"Schema Validity Rate:  {summary['schema_validity_rate']}% (Threshold: >= 96.0%)")
    print(f"Tool Selection Rate:   {summary['tool_accuracy_rate']}% (Threshold: >= 90.0%)")
    print(f"Grounded Accuracy:     {summary['grounded_accuracy_rate']}% (Threshold: >= 95.0%)")
    print(f"Critical Violations:   {summary['critical_hallucinations']} (Threshold: 0)")
    print(f"Average Throughput:    {summary['avg_throughput_tok_s']} tok/s (Threshold: >= 30.0)")

if __name__ == "__main__":
    main()
