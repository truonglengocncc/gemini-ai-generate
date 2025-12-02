#!/usr/bin/env python3
"""
Create a small inline BatchGenerateContent job via REST and print results.
Uses base64 inlineData (no Files API) to avoid file_uri issues.

Usage:
  python scripts/test_batch_inline_rest.py \
    --api-key YOUR_KEY \
    --model gemini-2.5-flash-image \
    --images ./image \
    --num-variations 1
"""
import argparse, base64, json, os, time, pathlib, requests


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--api-key", required=False, default=os.getenv("GEMINI_API_KEY"))
    p.add_argument("--model", default="gemini-2.5-flash-image")
    p.add_argument("--images", required=True, help="CSV of files or a directory")
    p.add_argument("--num-variations", type=int, default=1)
    p.add_argument("--prompt", default="Generate a realistic variation of this image.")
    p.add_argument("--max-polls", type=int, default=30)
    return p.parse_args()


def collect_images(arg):
    paths = []
    p = pathlib.Path(arg)
    if p.exists() and p.is_dir():
        paths = [f for f in p.iterdir() if f.suffix.lower() in [".jpg", ".jpeg", ".png"]]
    else:
        for part in arg.split(","):
            f = pathlib.Path(part.strip())
            if f.exists():
                paths.append(f)
    if not paths:
        raise SystemExit("No images found")
    return paths


def encode_image(path: pathlib.Path) -> dict:
    data = path.read_bytes()
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"mime_type": mime, "data": base64.b64encode(data).decode("utf-8")}


def main():
    args = parse_args()
    if not args.api_key:
        raise SystemExit("Missing --api-key or GEMINI_API_KEY")

    imgs = collect_images(args.images)
    requests_list = []
    key_idx = 0
    for img in imgs:
        inline_data = encode_image(img)
        for v in range(args.num_variations):
            key = f"img{key_idx}"
            key_idx += 1
            req = {
                "request": {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [
                                {"inline_data": inline_data},
                                {"text": args.prompt},
                            ],
                        }
                    ],
                    "generation_config": {"response_modalities": ["IMAGE"]},
                },
                "metadata": {"key": key},
            }
            requests_list.append(req)

    body = {
        "batch": {
            "display_name": f"inline-rest-{int(time.time())}",
            "input_config": {"requests": {"requests": requests_list}},
        }
    }

    create_url = f"https://generativelanguage.googleapis.com/v1beta/models/{args.model}:batchGenerateContent?key={args.api_key}"
    print(f"[Create] sending {len(requests_list)} inline requests via REST ...")
    create_resp = requests.post(create_url, json=body)
    create_resp.raise_for_status()
    batch = create_resp.json()
    name = batch["name"]
    print(f"[Create] batch={name}")

    done_states = {
        "JOB_STATE_SUCCEEDED",
        "JOB_STATE_FAILED",
        "JOB_STATE_CANCELLED",
        "JOB_STATE_EXPIRED",
    }

    state = "UNKNOWN"
    for i in range(args.max_polls):
        status_url = f"https://generativelanguage.googleapis.com/v1beta/{name}?key={args.api_key}"
        status = requests.get(status_url).json()
        state = status.get("state") or status.get("metadata", {}).get("state")
        stats = status.get("batchStats") or status.get("metadata", {}).get("batchStats")
        print(f"[Poll {i+1}] state={state} stats={stats}")
        if state in done_states:
            break
        time.sleep(10)

    if state != "JOB_STATE_SUCCEEDED":
        print(json.dumps(status, indent=2))
        return

    dest = status.get("dest") or status.get("response") or status
    resp_file = dest.get("responsesFile") or dest.get("responsesFileName") or dest.get(
        "fileName"
    )
    if not resp_file:
        inline = dest.get("inlinedResponses")
        if inline:
            print(f"Inline responses count={len(inline)}")
        else:
            print("No responses found.")
        return

    print(f"[Download] {resp_file}")
    dl_url = f"https://generativelanguage.googleapis.com/download/v1beta/{resp_file}:download?alt=media&key={args.api_key}"
    dl_resp = requests.get(dl_url)
    dl_resp.raise_for_status()
    lines = [l for l in dl_resp.text.splitlines() if l.strip()]
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


if __name__ == "__main__":
    main()
