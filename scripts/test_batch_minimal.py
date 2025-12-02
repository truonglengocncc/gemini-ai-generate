#!/usr/bin/env python3
"""
Quick sanity-checker for Gemini Batch API (image).

Usage (env GEMINI_API_KEY required or pass --api-key):
  python scripts/test_batch_minimal.py --model gemini-2.5-flash-image --images ./image
  python scripts/test_batch_minimal.py --model gemini-3-pro-image-preview --file-uris files/abc,files/def
Options:
  --api-key        Gemini API key (fallback GEMINI_API_KEY)
  --model          Model name (default gemini-2.5-flash-image)
  --images         CSV of files or a directory (jpg/jpeg/png) to upload
  --file-uris      CSV of existing file URIs (files/xxx)
  --num-variations Number of variations per image (default 1)
  --prompt         Prompt text
  --resolution     Only for 3-pro-image-preview (default 1K)
  --aspect-ratio   Only for 3-pro-image-preview (default 1:1)
  --max-polls      Poll times (default 30, 10s interval)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import List

import requests
from google import genai
from google.genai import types


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--api-key", default=os.getenv("GEMINI_API_KEY"))
    p.add_argument("--model", default="gemini-2.5-flash-image")
    p.add_argument("--images", default=None, help="CSV files or a directory")
    p.add_argument("--file-uris", default=None, help="CSV of files/xxx")
    p.add_argument("--num-variations", type=int, default=1)
    p.add_argument("--prompt", default="Generate a single realistic variation of this input image.")
    p.add_argument("--resolution", default="1K")
    p.add_argument("--aspect-ratio", default="1:1")
    p.add_argument("--max-polls", type=int, default=30)
    return p.parse_args()


def collect_images(images_arg: str) -> List[Path]:
    paths: List[Path] = []
    p = Path(images_arg)
    if p.exists() and p.is_dir():
        for f in p.iterdir():
            if f.suffix.lower() in [".jpg", ".jpeg", ".png"]:
                paths.append(f)
    else:
        for part in images_arg.split(","):
            f = Path(part.strip())
            if f.exists():
                paths.append(f)
    if not paths:
        raise SystemExit("No images found for --images")
    return paths


def normalize_uri(uri: str) -> str:
    if uri.startswith("http"):
        if "/files/" in uri:
            uri = "files/" + uri.split("/files/")[1].split("?")[0]
    elif not uri.startswith("files/"):
        uri = f"files/{uri}"
    return uri


def upload_images(client, paths: List[Path]) -> List[str]:
    uris = []
    for p in paths:
        mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        print(f"[Upload] {p} ({mime})")
        uploaded = client.files.upload(
            file=str(p),
            config=types.UploadFileConfig(mime_type=mime, display_name=p.name),
        )
        uri = uploaded.uri or uploaded.name
        uris.append(normalize_uri(uri))
    return uris


def build_requests(file_uris: List[str], prompt: str, model: str, num_variations: int, aspect_ratio: str, resolution: str):
    reqs = []
    for uri in file_uris:
        for v in range(num_variations):
            r = {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"file_data": {"file_uri": uri}},
                            {"text": prompt},
                        ],
                    }
                ],
                "generation_config": {"response_modalities": ["IMAGE"]},
            }
            if model == "gemini-3-pro-image-preview":
                r["generation_config"]["image_config"] = {
                    "aspect_ratio": aspect_ratio,
                    "image_size": resolution.upper(),
                }
            reqs.append(r)
    return reqs


def main():
    args = parse_args()
    if not args.api_key:
        raise SystemExit("Missing --api-key or GEMINI_API_KEY")

    client = genai.Client(api_key=args.api_key)

    file_uris = []
    if args.file_uris:
        file_uris = [normalize_uri(u.strip()) for u in args.file_uris.split(",") if u.strip()]
    if args.images:
        imgs = collect_images(args.images)
        file_uris += upload_images(client, imgs)

    if not file_uris:
        raise SystemExit("Need at least one file via --images or --file-uris")

    inlined = build_requests(
        file_uris, args.prompt, args.model, args.num_variations, args.aspect_ratio, args.resolution
    )

    # Create JSONL, upload via Files API, then create batch with file src
    import tempfile
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl")
    for idx, req in enumerate(inlined):
        line = {"key": f"req_{idx}", "request": req}
        tmp.write((json.dumps(line) + "\n").encode("utf-8"))
    tmp_path = tmp.name
    tmp.close()

    uploaded_jsonl = client.files.upload(
        file=tmp_path,
        config=types.UploadFileConfig(
            display_name=f"batch-reqs-{int(time.time())}",
            mime_type="application/jsonl",
        ),
    )
    jsonl_name = uploaded_jsonl.name

    # Create batch via REST (avoids SDK src restrictions)
    create_payload = {
        "batch": {
            "display_name": f"debug-batch-{int(time.time())}",
            "input_config": {"file_name": jsonl_name},
        }
    }
    create_url = f"https://generativelanguage.googleapis.com/v1beta/models/{args.model}:batchGenerateContent?key={args.api_key}"
    print(f"[Batch] Creating via REST src={jsonl_name}")
    create_resp = requests.post(create_url, json=create_payload)
    create_resp.raise_for_status()
    batch_obj = create_resp.json()
    name = batch_obj.get("name") or batch_obj.get("batch", {}).get("name")
    state = batch_obj.get("state") or batch_obj.get("metadata", {}).get("state")
    print(f"[Batch] name={name} state={state}")

    done = {"JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"}
    polls = 0
    while state not in done and polls < args.max_polls:
        time.sleep(10)
        polls += 1
        status_url = f"https://generativelanguage.googleapis.com/v1beta/{name}?key={args.api_key}"
        status_resp = requests.get(status_url)
        status_resp.raise_for_status()
        batch_obj = status_resp.json()
        state = batch_obj.get("state") or batch_obj.get("metadata", {}).get("state")
        stats = batch_obj.get("batchStats") or batch_obj.get("metadata", {}).get("batchStats")
        print(f"[Batch] poll {polls}: state={state} stats={stats}")

    print(f"[Batch] Final state: {state}")
    if state != "JOB_STATE_SUCCEEDED":
        print(json.dumps(batch_obj, indent=2))
        return

    dest = batch_obj.get("dest") or batch_obj.get("response") or batch_obj
    file_name = (
        dest.get("fileName")
        or dest.get("responsesFile")
        or dest.get("responsesFileName")
    )
    if file_name:
        print(f"[Batch] Downloading results file {file_name} ...")
        url = f"https://generativelanguage.googleapis.com/download/v1beta/{file_name}:download?alt=media&key={args.api_key}"
        resp = requests.get(url)
        resp.raise_for_status()
        lines = [ln for ln in resp.text.splitlines() if ln.strip()]
        ok = err = 0
        for ln in lines:
            obj = json.loads(ln)
            if "error" in obj:
                err += 1
                print("Error item:", obj.get("key"), obj["error"])
            else:
                ok += 1
        print(f"[Batch] OK={ok} ERR={err}")
    else:
        inlined = dest.get("inlinedResponses") or dest.get("inlined_responses")
        if inlined:
            print(f"[Batch] Inline responses: {len(inlined)}")
        else:
            print("[Batch] No results found.")


if __name__ == "__main__":
    main()
