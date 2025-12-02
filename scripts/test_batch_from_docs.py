#!/usr/bin/env python3
"""
Batch test derived from the official Batch_mode cookbook.

Default path: use file-based batch (JSONL) like docs recommend.
Supports inline mode if requested.

Example (file-based, images -> inlineData to avoid file_uri issues):
  python scripts/test_batch_from_docs.py \
    --api-key "$GEMINI_API_KEY" \
    --model gemini-2.5-flash-image \
    --images ./image \
    --num-variations 1

Example (text batch, inline):
  python scripts/test_batch_from_docs.py \
    --api-key "$GEMINI_API_KEY" \
    --model gemini-2.5-flash \
    --prompts "Tell me a joke","Why is sky blue?" \
    --mode inline
"""
import argparse
import base64
import json
import os
import pathlib
import time
from typing import List, Dict, Any

import requests
from google import genai
from google.genai import types


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--api-key", default=os.getenv("GEMINI_API_KEY"))
    p.add_argument("--model", default="gemini-2.5-flash-image")
    p.add_argument("--images", help="Directory or CSV of image files (.jpg/.png)")
    p.add_argument("--prompts", help="CSV of text prompts (for text batch)")
    p.add_argument("--num-variations", type=int, default=1)
    p.add_argument("--mode", choices=["file", "inline"], default="file")
    p.add_argument("--max-polls", type=int, default=30)
    return p.parse_args()


def collect_images(arg: str) -> List[pathlib.Path]:
    out: List[pathlib.Path] = []
    p = pathlib.Path(arg)
    if p.exists() and p.is_dir():
        out = [f for f in p.iterdir() if f.suffix.lower() in [".jpg", ".jpeg", ".png"]]
    else:
        for part in arg.split(","):
            f = pathlib.Path(part.strip())
            if f.exists():
                out.append(f)
    if not out:
        raise SystemExit("No images found")
    return out


def encode_inline(path: pathlib.Path) -> Dict[str, Any]:
    data = path.read_bytes()
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}


def build_image_requests(images: List[pathlib.Path], prompt: str, num_variations: int) -> List[Dict[str, Any]]:
    reqs = []
    idx = 0
    for img in images:
        inline_part = encode_inline(img)
        for _ in range(num_variations):
            reqs.append(
                {
                    "key": f"req_{idx}",
                    "request": {
                        "contents": [
                            {
                                "role": "user",
                                "parts": [
                                    inline_part,
                                    {"text": prompt},
                                ],
                            }
                        ],
                        "generation_config": {"response_modalities": ["IMAGE"]},
                    },
                }
            )
            idx += 1
    return reqs


def build_text_requests(prompts: List[str]) -> List[Dict[str, Any]]:
    reqs = []
    for i, p in enumerate(prompts):
        reqs.append(
            {
                "key": f"req_{i}",
                "request": {
                    "contents": [{"parts": [{"text": p}]}],
                },
            }
        )
    return reqs


def upload_jsonl(client: genai.Client, reqs: List[Dict[str, Any]]) -> str:
    tmp = pathlib.Path(f"/tmp/batch_{int(time.time())}.jsonl")
    tmp.write_text("\n".join(json.dumps(r) for r in reqs))
    uploaded = client.files.upload(
        file=str(tmp),
        config=types.UploadFileConfig(display_name=tmp.name, mime_type="application/jsonl"),
    )
    return uploaded.name


def create_batch_rest(api_key: str, model: str, file_name: str, display_name: str) -> str:
    payload = {
        "batch": {
            "display_name": display_name,
            "input_config": {"file_name": file_name},
        }
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchGenerateContent?key={api_key}"
    res = requests.post(url, json=payload)
    res.raise_for_status()
    body = res.json()
    return body.get("name") or body.get("batch", {}).get("name")


def poll(api_key: str, name: str, max_polls: int = 30):
    done = {"JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"}
    state = "UNKNOWN"
    for i in range(max_polls):
        url = f"https://generativelanguage.googleapis.com/v1beta/{name}?key={api_key}"
        res = requests.get(url)
        res.raise_for_status()
        body = res.json()
        state = body.get("state") or body.get("metadata", {}).get("state")
        stats = body.get("batchStats") or body.get("metadata", {}).get("batchStats")
        print(f"[Poll {i+1}] state={state} stats={stats}")
        if state in done:
            return body
        time.sleep(10)
    return body


def download_results(api_key: str, body: Dict[str, Any]):
    dest = body.get("dest") or body.get("response") or body
    file_name = (
        dest.get("fileName")
        or dest.get("responsesFile")
        or dest.get("responsesFileName")
    )
    if not file_name:
        print("No responses file found.")
        return
    url = f"https://generativelanguage.googleapis.com/download/v1beta/{file_name}:download?alt=media&key={api_key}"
    res = requests.get(url)
    res.raise_for_status()
    lines = [ln for ln in res.text.splitlines() if ln.strip()]
    ok = err = 0
    for ln in lines:
        obj = json.loads(ln)
        if "error" in obj:
            err += 1
            print("ERR", obj.get("key"), obj["error"])
        else:
            ok += 1
            print("OK", obj.get("key"))
    print(f"Summary OK={ok} ERR={err}")


def main():
    args = parse_args()
    if not args.api_key:
        raise SystemExit("Missing --api-key or GEMINI_API_KEY")

    client = genai.Client(api_key=args.api_key)

    # Build requests
    if args.images:
        imgs = collect_images(args.images)
        reqs = build_image_requests(imgs, prompt="Generate a realistic variation of this image.", num_variations=args.num_variations)
    else:
        prompts = [p.strip() for p in (args.prompts or "").split(",") if p.strip()]
        if not prompts:
            prompts = ["Tell me a one-sentence joke.", "Why is the sky blue?"]
        reqs = build_text_requests(prompts)

    if args.mode == "inline":
        # use SDK inline mode (supported for small batches)
        print(f"[Create inline] model={args.model} requests={len(reqs)}")
        batch = client.batches.create(
            model=args.model,
            src={"inlined_requests": [r["request"] for r in reqs]},
            config={"display_name": f"inline-{int(time.time())}"},
        )
        print(f"Batch name: {batch.name} state={batch.state}")
    else:
        # file-based as per docs
        file_name = upload_jsonl(client, reqs)
        print(f"[Upload JSONL] {file_name}")
        batch_name = create_batch_rest(args.api_key, args.model, file_name, f"file-{int(time.time())}")
        print(f"[Create] batch={batch_name}")
        body = poll(args.api_key, batch_name, max_polls=args.max_polls)
        state = body.get("state") or body.get("metadata", {}).get("state")
        print(f"[Done] state={state}")
        if state == "JOB_STATE_SUCCEEDED":
            download_results(args.api_key, body)
        else:
            print(json.dumps(body, indent=2))


if __name__ == "__main__":
    main()
