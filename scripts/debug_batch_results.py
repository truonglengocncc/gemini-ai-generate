#!/usr/bin/env python3
"""
Download & inspect Gemini Batch results JSONL.

Usage:
  python scripts/debug_batch_results.py --api-key YOUR_KEY --file-id files/abc123

Options:
  --api-key   Gemini API key (or set env GEMINI_API_KEY)
  --file-id   File ID from Batch (e.g., files/batch-...)
  --out       Optional path to save JSONL (default: /tmp/batch_results.jsonl)
"""

import argparse
import json
import os
import pathlib
import sys
import textwrap
import urllib.request


def download(api_key: str, file_id: str, out: pathlib.Path) -> pathlib.Path:
  url = f"https://generativelanguage.googleapis.com/download/v1beta/{file_id}:download?alt=media&key={api_key}"
  with urllib.request.urlopen(url) as resp:
    data = resp.read()
  out.write_bytes(data)
  print(f"Downloaded {out} ({len(data)} bytes)")
  return out


def analyze(path: pathlib.Path):
  errors, oks = [], []
  lines = path.read_text().splitlines()
  for i, line in enumerate(lines, 1):
    if not line.strip():
      continue
    obj = json.loads(line)
    key = obj.get("key") or obj.get("metadata", {}).get("key") or f"line_{i}"
    if "error" in obj:
      err = obj["error"]
      msg = err.get("message", err)
      errors.append((i, key, msg, err))
    else:
      oks.append(key)

  print("\n=== Summary ===")
  print(f"Total lines: {len(errors) + len(oks)}")
  print(f"OK responses: {len(oks)}")
  print(f"Errors: {len(errors)}")
  if errors:
    print("\nTop errors:")
    for i, key, msg, err in errors[:10]:
      print(f"- line {i} key={key}: {msg}")
      # Show full error object for debugging
      print(f"  full error: {json.dumps(err, ensure_ascii=False)}")
  return errors, oks


def main():
  parser = argparse.ArgumentParser(
    description="Download & inspect Gemini Batch results JSONL",
    formatter_class=argparse.RawDescriptionHelpFormatter,
    epilog=textwrap.dedent(
      """
      Examples:
        python scripts/debug_batch_results.py --api-key $GEMINI_API_KEY --file-id files/batch-53... --out /tmp/batch.jsonl
      """
    ),
  )
  parser.add_argument("--api-key", default=None, help="Gemini API key (fallback GEMINI_API_KEY env)")
  parser.add_argument("--file-id", required=True, help="File ID like files/batch-xxxxx")
  parser.add_argument("--out", default="/tmp/batch_results.jsonl", help="Output path for downloaded JSONL")
  args = parser.parse_args()

  api_key = args.api_key or os.environ.get("GEMINI_API_KEY")
  if not api_key:
    sys.exit("Missing --api-key or GEMINI_API_KEY env")

  out_path = pathlib.Path(args.out)
  download(api_key, args.file_id, out_path)
  analyze(out_path)


if __name__ == "__main__":
  main()
