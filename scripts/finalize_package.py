#!/usr/bin/env python3
"""
Finalize package inventory and ZIP archive after all reports are generated.
"""
import hashlib
import json
import zipfile
from pathlib import Path

OUT_DIR = Path(r"C:\Users\HP\Downloads\NEXUS_V2_3_Daily_Assistant_Dataset_v2")
ZIP_OUT = Path(r"C:\Users\HP\Downloads\NEXUS_V2_3_Daily_Assistant_Dataset_v2.zip")

def main():
    # Update inventory
    inventory = []
    for p in sorted(OUT_DIR.rglob("*")):
        if p.is_file() and p.name != "artifact_inventory.json":
            h = hashlib.sha256(p.read_bytes()).hexdigest()
            inventory.append({
                "relative_path": str(p.relative_to(OUT_DIR)).replace("\\", "/"),
                "size_bytes": p.stat().st_size,
                "sha256": h
            })

    inv_path = OUT_DIR / "manifests" / "artifact_inventory.json"
    with open(inv_path, "w", encoding="utf-8") as f:
        json.dump({"total_files": len(inventory) + 1, "files": inventory}, f, indent=2)

    # Re-hash artifact_inventory itself and add to inventory
    inv_h = hashlib.sha256(inv_path.read_bytes()).hexdigest()
    # Now write ZIP
    with zipfile.ZipFile(ZIP_OUT, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for item in inventory:
            fp = OUT_DIR / item["relative_path"]
            z.write(fp, arcname=f"NEXUS_V2_3_Daily_Assistant_Dataset_v2/{item['relative_path']}")
        z.write(inv_path, arcname="NEXUS_V2_3_Daily_Assistant_Dataset_v2/manifests/artifact_inventory.json")

    print(f"Finalized inventory: {len(inventory) + 1} files.")
    print(f"Finalized ZIP archive: {ZIP_OUT.stat().st_size} bytes.")

if __name__ == "__main__":
    main()
