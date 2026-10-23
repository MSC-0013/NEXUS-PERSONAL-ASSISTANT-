import os
import sys
import json
import math
from typing import Dict, Any, List

def compute_mcnemar_and_report(base_json_path: str, candidate_json_path: str, output_report_path: str):
    with open(base_json_path, "r", encoding="utf-8") as f:
        base_data = json.load(f)
    with open(candidate_json_path, "r", encoding="utf-8") as f:
        cand_data = json.load(f)
        
    base_cases = {c["id"]: c for c in base_data["case_results"]}
    cand_cases = {c["id"]: c for c in cand_data["case_results"]}
    
    common_ids = sorted(list(set(base_cases.keys()) & set(cand_cases.keys())))
    N = len(common_ids)
    print(f"Comparing N = {N} paired evaluation cases...")
    
    n00 = 0  # both failed
    n01 = 0  # base failed, candidate passed (improvement)
    n10 = 0  # base passed, candidate failed (regression)
    n11 = 0  # both passed
    
    for cid in common_ids:
        b_succ = base_cases[cid]["is_task_success"]
        c_succ = cand_cases[cid]["is_task_success"]
        if not b_succ and not c_succ:
            n00 += 1
        elif not b_succ and c_succ:
            n01 += 1
        elif b_succ and not c_succ:
            n10 += 1
        else:
            n11 += 1
            
    delta_p = (n01 - n10) / N
    discordant = n01 + n10
    
    if discordant > 0:
        chi2 = ((abs(n01 - n10) - 1.0) ** 2) / discordant
    else:
        chi2 = 0.0
        
    p_value = math.erfc(math.sqrt(chi2) / math.sqrt(2.0))
    se = math.sqrt((n01 + n10 - ((n01 - n10) ** 2) / N) / (N * (N - 1))) if N > 1 and discordant > 0 else 0.0
    ci_lower = delta_p - 1.96 * se
    ci_upper = delta_p + 1.96 * se
    
    route_a_passed = (delta_p >= 0.10) and (chi2 > 3.841) and (ci_lower > 0)
    
    # Route B Checks on candidate
    route_b_task_success = cand_data["task_success_rate"] >= 82.0
    route_b_schema_validity = cand_data["schema_validity_rate"] >= 96.0
    route_b_tool_accuracy = cand_data["tool_accuracy_rate"] >= 90.0
    route_b_grounded_acc = cand_data["grounded_accuracy_rate"] >= 95.0
    route_b_no_critical = cand_data["critical_hallucinations"] == 0
    route_b_passed = (
        route_b_task_success and
        route_b_schema_validity and
        route_b_tool_accuracy and
        route_b_grounded_acc and
        route_b_no_critical
    )
    
    selected_route = "Route A (Fine-Tuned Candidate Statistical Superiority)" if route_a_passed else (
        "Route B (Candidate Absolute Acceptance Promotion)" if route_b_passed else "REJECTED"
    )
    
    report = {
        "base_model": base_data["model_name"],
        "candidate_model": cand_data["model_name"],
        "sample_size": N,
        "base_task_success_rate": base_data["task_success_rate"],
        "candidate_task_success_rate": cand_data["task_success_rate"],
        "contingency_table": {
            "n00_both_failed": n00,
            "n01_candidate_improved": n01,
            "n10_candidate_regressed": n10,
            "n11_both_passed": n11
        },
        "statistical_metrics": {
            "delta_p_pct": round(delta_p * 100, 2),
            "mcnemar_chi2": round(chi2, 4),
            "p_value": round(p_value, 6),
            "agresti_min_95_ci": [round(ci_lower * 100, 2), round(ci_upper * 100, 2)],
            "route_a_passed": route_a_passed
        },
        "route_b_checks": {
            "task_success_rate_ge_82": route_b_task_success,
            "schema_validity_ge_96": route_b_schema_validity,
            "tool_accuracy_ge_90": route_b_tool_accuracy,
            "grounded_accuracy_ge_95": route_b_grounded_acc,
            "zero_critical_hallucinations": route_b_no_critical,
            "route_b_passed": route_b_passed
        },
        "promotion_decision": {
            "promoted": route_a_passed or route_b_passed,
            "selected_route": selected_route,
            "promoted_model": cand_data["model_name"]
        }
    }
    
    with open(output_report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        
    print(f"\n=======================================================")
    print(f"PROMOTION GATE 3 REPORT")
    print(f"=======================================================")
    print(f"Base Success Rate:       {base_data['task_success_rate']}%")
    print(f"Candidate Success Rate:  {cand_data['task_success_rate']}%")
    print(f"Improvement (Delta p):   +{round(delta_p * 100, 2)}% (Target >= +10.0%)")
    print(f"McNemar Chi^2:           {round(chi2, 4)} (Target > 3.841, p < 0.05)")
    print(f"p-value:                 {round(p_value, 6)}")
    print(f"Agresti-Min 95% CI:      [{round(ci_lower * 100, 2)}%, {round(ci_upper * 100, 2)}%]")
    print(f"Route A Passed:          {route_a_passed}")
    print(f"Route B Passed:          {route_b_passed}")
    print(f"FINAL PROMOTION VERDICT: {selected_route}")
    print(f"Saved promotion report to {output_report_path}")
    return report

if __name__ == "__main__":
    base_file = sys.argv[1] if len(sys.argv) > 1 else "evaluation_qwen3.5_0.8b.json"
    cand_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "evaluation_nexus_qwen3.5_0.8b_merged.json")
    out_file = os.path.join(os.path.dirname(__file__), "promotion_gate_report.json")
    compute_mcnemar_and_report(base_file, cand_file, out_file)
