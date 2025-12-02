#!/usr/bin/env python3
"""
Download and inspect a Gemini Batch results file (JSONL).

Usage:
  python scripts/debug_batch_file.py --api-key YOUR_KEY --file-id files/batch-...

It prints each line status; errors are shown with their messages.
"""
import argparse, json, os, pathlib, sys, requests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", default=os.getenv("GEMINI_API_KEY"), required=False)
    parser.add_argument("--file-id", required=True, help="files/batch-xxxx")
    parser.add_argument("--out", default="/tmp/batch_results.jsonl")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("Missing --api-key or GEMINI_API_KEY")

    url = f"https://generativelanguage.googleapis.com/download/v1beta/{args.file_id}:download?alt=media&key={args.api_key}"
    resp = requests.get(url)
    resp.raise_for_status()
    path = pathlib.Path(args.out)
    path.write_bytes(resp.content)
    print(f"Downloaded {path} ({len(resp.content)} bytes)")

    ok = err = 0
    for i, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        obj = json.loads(line)
        if "error" in obj:
            err += 1
            print(f"line {i} key={obj.get('key')}: {json.dumps(obj['error'], ensure_ascii=False)}")
        else:
            ok += 1
            print(f"line {i} key={obj.get('key')} OK")
    print(f"Summary: OK={ok} ERR={err}")


if __name__ == "__main__":
    main()
