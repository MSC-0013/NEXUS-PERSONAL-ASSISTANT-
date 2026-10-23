#!/usr/bin/env python3
"""
scripts/run_smoke_test.py
PROJECT NEXUS V2.3 — Rev 2.3.8 Outer Smoke Test Bootstrap Launcher

Provides independent, best-effort fallback evidence recording if the inner
process terminates abnormally or PyTorch fails to import.
Uses STRICTLY Python standard library modules (zero external dependencies).
"""

import os
import sys
import json
import time
import hashlib
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__)) if "__file__" in locals() else os.getcwd()
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
INNER_SCRIPT_PATH = os.path.join(SCRIPT_DIR, "inspect_qwen_modules.py")
EVIDENCE_PATH = os.path.join(ROOT_DIR, "logs", "smoke_test_w15_17a.json")
BOOTSTRAP_LOG_PATH = os.path.join(ROOT_DIR, "logs", "smoke_test_w15_17a_bootstrap.json")

def compute_file_sha256(path):
    if not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def main():
    start_epoch = int(time.time())
    print("================================================================================")
    print("PROJECT NEXUS V2.3 — Rev 2.3.8 Smoke Test Bootstrap Launcher")
    print(f"Target Script: {INNER_SCRIPT_PATH}")
    print(f"Python Executable: {sys.executable}")
    print("================================================================================")

    script_hash = compute_file_sha256(INNER_SCRIPT_PATH)
    if not script_hash:
        print(f"ERROR: Inner smoke test script not found at {INNER_SCRIPT_PATH}", file=sys.stderr)
        bootstrap_record = {
            "test_id": "TEST-W15-17A",
            "spec_revision": "Rev 2.3.8",
            "timestamp_epoch": start_epoch,
            "overall_verdict": "FAIL",
            "failed_stage": "bootstrap_file_check",
            "error_message": f"Script not found at {INNER_SCRIPT_PATH}",
            "inner_exit_code": -1,
            "environment": {"python_version": sys.version}
        }
        os.makedirs(os.path.dirname(EVIDENCE_PATH), exist_ok=True)
        with open(EVIDENCE_PATH, "w", encoding="utf-8") as f:
            json.dump(bootstrap_record, f, indent=2)
        sys.exit(1)

    print(f"Verified Inner Script SHA-256: {script_hash}")

    # Remove existing evidence file if present to detect fresh generation
    if os.path.exists(EVIDENCE_PATH):
        try:
            os.remove(EVIDENCE_PATH)
        except Exception:
            pass

    cmd = [sys.executable, INNER_SCRIPT_PATH]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=ROOT_DIR
    )

    stdout_out, stderr_out = proc.communicate()
    exit_code = proc.returncode

    print(stdout_out)
    if stderr_out:
        print(stderr_out, file=sys.stderr)

    # Check whether inner script successfully wrote the evidence artifact
    evidence_generated = False
    evidence_data = None
    if os.path.exists(EVIDENCE_PATH):
        try:
            with open(EVIDENCE_PATH, "r", encoding="utf-8") as f:
                evidence_data = json.load(f)
            evidence_generated = True
        except Exception as read_err:
            print(f"Warning: Failed to read inner evidence artifact: {read_err}", file=sys.stderr)

    # If the inner script crashed before writing evidence (e.g. PyTorch import failure)
    if not evidence_generated:
        print("\n[BOOTSTRAP] Inner process terminated without writing evidence log. Generating bootstrap fallback artifact...", file=sys.stderr)
        fallback_record = {
            "test_id": "TEST-W15-17A",
            "spec_revision": "Rev 2.3.8",
            "timestamp_epoch": start_epoch,
            "script_sha256": script_hash,
            "overall_verdict": "FAIL",
            "failed_stage": "early_process_or_import_abort",
            "inner_exit_code": exit_code,
            "error_message": f"Inner process terminated abnormally with exit code {exit_code}",
            "stderr_snippet": stderr_out[-2000:] if stderr_out else "None",
            "environment": {
                "python_version": sys.version,
                "torch_import_status": "FAILED_OR_ABORTED_BEFORE_LOGGING"
            },
            "stages": {
                "bootstrap": {"status": "PASS"},
                "process_execution": {"status": "FAIL", "exit_code": exit_code}
            }
        }
        os.makedirs(os.path.dirname(EVIDENCE_PATH), exist_ok=True)
        with open(EVIDENCE_PATH, "w", encoding="utf-8") as f:
            json.dump(fallback_record, f, indent=2)
        print(f"[BOOTSTRAP] Wrote fallback evidence log to: {EVIDENCE_PATH}")

    # Write bootstrap execution record
    bootstrap_summary = {
        "timestamp_epoch": start_epoch,
        "script_sha256": script_hash,
        "inner_exit_code": exit_code,
        "inner_evidence_generated": evidence_generated,
        "final_verdict": evidence_data.get("overall_verdict", "FAIL") if evidence_data else "FAIL"
    }
    with open(BOOTSTRAP_LOG_PATH, "w", encoding="utf-8") as f:
        json.dump(bootstrap_summary, f, indent=2)

    if exit_code != 0 or (evidence_data and evidence_data.get("overall_verdict") != "PASS"):
        print(f"\n[BOOTSTRAP] TEST-W15-17A FAILED with exit code {exit_code}")
        sys.exit(1)

    print("\n[BOOTSTRAP] TEST-W15-17A PASSED (inner and bootstrap verification complete).")
    sys.exit(0)

if __name__ == "__main__":
    main()
