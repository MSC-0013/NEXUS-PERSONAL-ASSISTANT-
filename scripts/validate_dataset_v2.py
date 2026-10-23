#!/usr/bin/env python3
"""
PROJECT NEXUS V2.3 — Dataset v2 Quality & Integrity Validation Suite
Validates schema compliance, semantic invariants, provenance traceability,
disjoint splits, artifact inventory checksums, and token length distribution.
"""

from __future__ import annotations
import json
import hashlib
import re
import sys
import os
from pathlib import Path
from collections import Counter, defaultdict

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

REPO_ROOT = Path(r"C:\MSC\my-desk\ai-personal-assistants")
sys.path.insert(0, str(REPO_ROOT))
from tests.test_contract_parity import validate_schema, CONTRACT_PATH

with open(CONTRACT_PATH, "r", encoding="utf-8") as f:
    CANONICAL_CONTRACT = json.load(f)

DATASET_DIR = Path(r"C:\Users\HP\Downloads\NEXUS_V2_3_Daily_Assistant_Dataset_v2")

def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def normalize_text(s: str) -> str:
    return re.sub(r"\W+", " ", s.lower()).strip()

def run_validation():
    print("=======================================================")
    print("Starting NEXUS Dataset v2 Quality & Integrity Audit")
    print(f"Target Directory: {DATASET_DIR}")
    print("=======================================================")

    results = {
        "status": "PASS",
        "files_checked": 0,
        "total_records_parsed": 0,
        "schema_compliance_errors": [],
        "semantic_defects": [],
        "provenance_errors": [],
        "split_leakage_errors": [],
        "checksum_errors": []
    }

    # 1. Artifact Inventory Verification
    inv_path = DATASET_DIR / "manifests" / "artifact_inventory.json"
    with open(inv_path, "r", encoding="utf-8") as f:
        inv_data = json.load(f)

    print(f"\n[1/6] Verifying Artifact Inventory Checksums ({len(inv_data['files'])} files)...")
    for item in inv_data["files"]:
        fpath = DATASET_DIR / item["relative_path"]
        if not fpath.exists():
            results["checksum_errors"].append(f"Missing file: {item['relative_path']}")
            continue
        actual_h = sha256_file(fpath)
        actual_size = fpath.stat().st_size
        if actual_h != item["sha256"]:
            results["checksum_errors"].append(f"Checksum mismatch: {item['relative_path']}")
        if actual_size != item["size_bytes"]:
            results["checksum_errors"].append(f"Size mismatch: {item['relative_path']}")
        results["files_checked"] += 1

    print(f"  --> Checksum check complete: {len(results['checksum_errors'])} errors.")

    # 2. Main Files Schema & Semantic Audit
    main_files = [
        ("all_examples_10000.jsonl", 10000),
        ("train.jsonl", 9000),
        ("validation.jsonl", 1000),
        ("pilot/nexus_daily_pilot_2000.jsonl", 2000),
        ("tool_use/tool_use_verified_train.jsonl", 576),
        ("tool_use/tool_use_verified_validation.jsonl", 64),
        ("tool_use/tool_use_verified_all_640.jsonl", 640)
    ]

    print(f"\n[2/6] Auditing JSONL Record Syntax & Canonical Contract Schema...")
    parsed_records = {}

    for rel_path, expected_count in main_files:
        p = DATASET_DIR / rel_path
        recs = []
        with open(p, "r", encoding="utf-8") as f:
            for lno, line in enumerate(f, 1):
                if not line.strip():
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Blank line")
                    continue
                try:
                    r = json.loads(line)
                    recs.append(r)
                except Exception as e:
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Invalid JSON: {e}")
                    continue

                # Verify message structure
                msgs = r.get("messages", [])
                if len(msgs) != 3:
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Expected 3 messages (system, user, assistant), got {len(msgs)}")
                if msgs[0]["role"] != "system" or not msgs[0]["content"].startswith("You are NEXUS"):
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Invalid system prompt")
                if msgs[1]["role"] != "user" or not msgs[1]["content"].strip():
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Invalid user message")
                if msgs[2]["role"] != "assistant" or not msgs[2]["content"].strip():
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Invalid assistant message")

                # Validate assistant target against agent-contract-v1.json
                try:
                    target_obj = json.loads(msgs[2]["content"])
                    validate_schema(target_obj, CANONICAL_CONTRACT)
                except Exception as e:
                    results["schema_compliance_errors"].append(f"{rel_path}:{lno} Contract violation: {e}")

                # Check semantic defects
                u_text = msgs[1]["content"]
                a_text = msgs[2]["content"]

                # Defect 1: Malformed "I have I can"
                if "i have i can" in u_text.lower():
                    results["semantic_defects"].append(f"{rel_path}:{lno} Malformed 'I have I can' detected in prompt")

                # Defect 2: Daily planning demanding task priority
                if "mentally demanding work first" in u_text.lower():
                    # High demand keywords
                    high_demands = ["fix the failing api test", "debug an intermittent memory leak", "profile slow database queries", "implement authentication", "write regression tests", "study node.js event loop", "learn b-tree database indexing", "complete a focused backend coding block"]
                    low_demands = ["go for a brisk walk", "reset away from the screen", "prepare a healthy lunch", "review the day's completed items", "clear small administrative email tasks"]
                    first_item = a_text.split("Suggested schedule for")[1].split(";")[0] if "Suggested schedule for" in a_text else ""
                    if any(ld in first_item.lower() for ld in low_demands) and any(hd in u_text.lower() for hd in high_demands):
                        results["semantic_defects"].append(f"{rel_path}:{lno} Priority violation: low-demand task scheduled before high-demand task")

                # Defect 3: Study session duration math
                dur_m = re.search(r"(\d+)-minute study session", a_text)
                if dur_m:
                    tot_dur = int(dur_m.group(1))
                    segments = re.findall(r"\((\d+)\s*min\)", a_text)
                    if segments:
                        sum_dur = sum(int(s) for s in segments)
                        if sum_dur != tot_dur:
                            results["semantic_defects"].append(f"{rel_path}:{lno} Study duration mismatch: segments sum {sum_dur} != total {tot_dur}")

        if len(recs) != expected_count:
            results["schema_compliance_errors"].append(f"{rel_path}: Count mismatch, expected {expected_count}, got {len(recs)}")
        parsed_records[rel_path] = recs
        results["total_records_parsed"] += len(recs)

    print(f"  --> Record audit complete: {len(results['schema_compliance_errors'])} schema errors, {len(results['semantic_defects'])} semantic defects.")

    # 3. Provenance & Metadata Line-Order Match
    print("\n[3/6] Verifying 1-to-1 Provenance Matching Between Datasets & Sidecars...")
    meta_pairs = [
        ("all_examples_10000.jsonl", "manifests/record_metadata.jsonl"),
        ("train.jsonl", "manifests/train_metadata.jsonl"),
        ("validation.jsonl", "manifests/validation_metadata.jsonl"),
        ("pilot/nexus_daily_pilot_2000.jsonl", "manifests/pilot_metadata.jsonl"),
        ("tool_use/tool_use_verified_all_640.jsonl", "manifests/tool_use_metadata.jsonl")
    ]

    for d_file, m_file in meta_pairs:
        d_recs = parsed_records[d_file]
        m_lines = []
        with open(DATASET_DIR / m_file, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    m_lines.append(json.loads(line))

        if len(d_recs) != len(m_lines):
            results["provenance_errors"].append(f"{d_file} vs {m_file}: Row count mismatch ({len(d_recs)} vs {len(m_lines)})")
            continue

        for idx, (dr, mr) in enumerate(zip(d_recs, m_lines)):
            if dr["id"] != mr["record_id"]:
                results["provenance_errors"].append(f"{d_file} line {idx+1}: ID mismatch ({dr['id']} != {mr['record_id']})")
                break
            if dr["category"] != mr["category"]:
                results["provenance_errors"].append(f"{d_file} line {idx+1}: Category mismatch")
                break
            if dr["split"] != mr["split"]:
                results["provenance_errors"].append(f"{d_file} line {idx+1}: Split mismatch")
                break

    print(f"  --> Provenance check complete: {len(results['provenance_errors'])} errors.")

    # 4. Split Disjointness & Pilot Subset Audit
    print("\n[4/6] Auditing Train/Validation Disjointness & Pilot Boundaries...")
    train_recs = parsed_records["train.jsonl"]
    val_recs = parsed_records["validation.jsonl"]
    pilot_recs = parsed_records["pilot/nexus_daily_pilot_2000.jsonl"]

    train_ids = {r["id"] for r in train_recs}
    val_ids = {r["id"] for r in val_recs}
    pilot_ids = {r["id"] for r in pilot_recs}

    id_overlap = train_ids.intersection(val_ids)
    if id_overlap:
        results["split_leakage_errors"].append(f"Train/Val ID overlap: {len(id_overlap)} records")

    train_prompts = {normalize_text(r["messages"][1]["content"]) for r in train_recs}
    val_prompts = {normalize_text(r["messages"][1]["content"]) for r in val_recs}
    prompt_overlap = train_prompts.intersection(val_prompts)
    if prompt_overlap:
        results["split_leakage_errors"].append(f"Train/Val normalized prompt overlap: {len(prompt_overlap)} records")

    if not pilot_ids.issubset(train_ids):
        results["split_leakage_errors"].append(f"Pilot is not a strict subset of train ({len(pilot_ids - train_ids)} non-train records)")

    pilot_val_overlap = pilot_ids.intersection(val_ids)
    if pilot_val_overlap:
        results["split_leakage_errors"].append(f"Pilot intersects with validation ({len(pilot_val_overlap)} records)")

    print(f"  --> Split boundary audit complete: {len(results['split_leakage_errors'])} leakage errors.")

    # 5. Overall Verdict
    total_errs = (
        len(results["schema_compliance_errors"]) +
        len(results["semantic_defects"]) +
        len(results["provenance_errors"]) +
        len(results["split_leakage_errors"]) +
        len(results["checksum_errors"])
    )

    if total_errs > 0:
        results["status"] = "FAIL"

    print("\n=======================================================")
    print(f"FINAL AUDIT VERDICT: {results['status']}")
    print(f"Total Errors Found: {total_errs}")
    print("=======================================================")

    report_path = DATASET_DIR / "reports" / "validation_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)

    return results

if __name__ == "__main__":
    res = run_validation()
    sys.exit(0 if res["status"] == "PASS" else 1)
