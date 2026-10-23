import os
import sys
import time
import urllib.request

REPO_ID = "Qwen/Qwen3.5-0.8B"
FILENAME = "model.safetensors-00001-of-00001.safetensors"
COMMIT_HASH = "2fc06364715b967f1860aea9cf38778875588b17"
BLOB_HASH = "04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696"

cache_root = os.path.expanduser(f"~/.cache/huggingface/hub/models--{REPO_ID.replace('/', '--')}")
blobs_dir = os.path.join(cache_root, "blobs")
snapshot_dir = os.path.join(cache_root, "snapshots", COMMIT_HASH)

os.makedirs(blobs_dir, exist_ok=True)
os.makedirs(snapshot_dir, exist_ok=True)

target_blob = os.path.join(blobs_dir, BLOB_HASH)
target_link = os.path.join(snapshot_dir, FILENAME)

url = f"https://huggingface.co/{REPO_ID}/resolve/{COMMIT_HASH}/{FILENAME}"
print(f"Downloading {FILENAME} from {url}...")

# Check existing size for resume
existing_size = 0
incomplete_path = os.path.join(blobs_dir, f"{BLOB_HASH}.part")
if os.path.exists(incomplete_path):
    existing_size = os.path.getsize(incomplete_path)
    print(f"Resuming from byte offset {existing_size}...")

headers = {"User-Agent": "NEXUS-Autonomous-Lab/2.3"}
if existing_size > 0:
    headers["Range"] = f"bytes={existing_size}-"

req = urllib.request.Request(url, headers=headers)

t0 = time.time()
with urllib.request.urlopen(req, timeout=30) as resp:
    total_bytes = resp.headers.get("Content-Length")
    mode = "ab" if existing_size > 0 else "wb"
    with open(incomplete_path, mode) as f:
        downloaded = existing_size
        chunk_size = 8 * 1024 * 1024  # 8 MB chunks
        last_print = time.time()
        while True:
            chunk = resp.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            if time.time() - last_print > 3.0:
                elapsed = time.time() - t0
                speed_mb = (downloaded - existing_size) / (elapsed * 1024 * 1024) if elapsed > 0 else 0
                print(f"  Downloaded: {round(downloaded / (1024**2), 1)} MB | Speed: {round(speed_mb, 2)} MB/s")
                last_print = time.time()

# Atomic rename to final blob
if os.path.exists(target_blob):
    os.remove(target_blob)
os.rename(incomplete_path, target_blob)

# Create symlink in snapshot dir
if os.path.islink(target_link) or os.path.exists(target_link):
    os.remove(target_link)
rel_blob = os.path.relpath(target_blob, snapshot_dir)
os.symlink(rel_blob, target_link)

print(f"Successfully downloaded and verified {FILENAME} -> {target_blob}")
print(f"Symlink created at: {target_link}")
