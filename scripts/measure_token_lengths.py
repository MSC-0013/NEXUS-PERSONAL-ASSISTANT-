#!/usr/bin/env python3
"""
PROJECT NEXUS V2.3 — Token Length Measurement Suite
Measures exact ChatML token lengths using the pinned Qwen3.5-0.8B tokenizer in WSL2.
"""

import json
import statistics
import os
import sys
from pathlib import Path
from transformers import AutoTokenizer

SNAPSHOT_DIR = os.path.expanduser("~/.cache/huggingface/hub/models--Qwen--Qwen3.5-0.8B/snapshots/2fc06364715b967f1860aea9cf38778875588b17")
DATASET_DIR = Path("/mnt/c/Users/HP/Downloads/NEXUS_V2_3_Daily_Assistant_Dataset_v2")

def main():
    print("Loading pinned Qwen3.5-0.8B tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(SNAPSHOT_DIR, trust_remote_code=True)
    print(f"Tokenizer loaded. Vocab size: {len(tokenizer)}")

    files_to_measure = [
        ("train", DATASET_DIR / "train.jsonl"),
        ("validation", DATASET_DIR / "validation.jsonl"),
        ("pilot", DATASET_DIR / "pilot" / "nexus_daily_pilot_2000.jsonl"),
        ("tool_use", DATASET_DIR / "tool_use" / "tool_use_verified_all_640.jsonl")
    ]

    report = {
        "tokenizer_model": "Qwen/Qwen3.5-0.8B",
        "snapshot_commit": "2fc06364715b967f1860aea9cf38778875588b17",
        "vocab_size": len(tokenizer),
        "files": {}
    }

    for label, filepath in files_to_measure:
        print(f"\nMeasuring tokens for {label} ({filepath.name})...")
        lengths = []
        prompt_lens = []
        assistant_lens = []
        cat_lengths = {}

        with open(filepath, "r", encoding="utf-8") as f:
            for lno, line in enumerate(f):
                r = json.loads(line)
                msgs = r["messages"]
                cat = r.get("category", "tool_use")
                if cat not in cat_lengths:
                    cat_lengths[cat] = []

                # Format as ChatML
                chatml_text = ""
                for m in msgs:
                    chatml_text += f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n"

                tokens = tokenizer(chatml_text)["input_ids"]
                tok_len = len(tokens)
                lengths.append(tok_len)
                cat_lengths[cat].append(tok_len)

                # Measure prompt vs assistant
                p_text = f"<|im_start|>system\n{msgs[0]['content']}<|im_end|>\n<|im_start|>user\n{msgs[1]['content']}<|im_end|>\n"
                p_len = len(tokenizer(p_text)["input_ids"])
                prompt_lens.append(p_len)
                assistant_lens.append(tok_len - p_len)

        sorted_lens = sorted(lengths)
        n = len(sorted_lens)
        
        file_stats = {
            "record_count": n,
            "min_tokens": sorted_lens[0],
            "p10_tokens": sorted_lens[int(0.10 * n)],
            "p25_tokens": sorted_lens[int(0.25 * n)],
            "median_tokens": sorted_lens[int(0.50 * n)],
            "p75_tokens": sorted_lens[int(0.75 * n)],
            "p90_tokens": sorted_lens[int(0.90 * n)],
            "p95_tokens": sorted_lens[int(0.95 * n)],
            "p99_tokens": sorted_lens[int(0.99 * n)],
            "max_tokens": sorted_lens[-1],
            "mean_tokens": round(statistics.mean(sorted_lens), 2),
            "stdev_tokens": round(statistics.stdev(sorted_lens), 2),
            "truncation_risk": {
                "exceeds_256": sum(1 for x in sorted_lens if x > 256),
                "exceeds_384": sum(1 for x in sorted_lens if x > 384),
                "exceeds_512": sum(1 for x in sorted_lens if x > 512),
                "exceeds_1024": sum(1 for x in sorted_lens if x > 1024)
            },
            "category_medians": {c: int(statistics.median(l)) for c, l in cat_lengths.items()}
        }
        report["files"][label] = file_stats

        print(f"  Count: {n}")
        print(f"  Min: {file_stats['min_tokens']}, Median: {file_stats['median_tokens']}, p95: {file_stats['p95_tokens']}, Max: {file_stats['max_tokens']}")
        print(f"  Exceeds 256: {file_stats['truncation_risk']['exceeds_256']}, Exceeds 384: {file_stats['truncation_risk']['exceeds_384']}, Exceeds 512: {file_stats['truncation_risk']['exceeds_512']}")

    out_file = DATASET_DIR / "reports" / "token_length_report.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"\nToken length report written to: {out_file}")

if __name__ == "__main__":
    main()
