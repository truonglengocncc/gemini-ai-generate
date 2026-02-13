"""
RunPod Serverless Handler for Image Generation
Supports both Automatic and Semi-Automatic modes with concurrent processing
"""

import base64
import os
import json
import asyncio
import httpx
import time
import io
import tempfile
from typing import Dict, Any, List
from google import genai
from google.genai import types
from google.cloud import storage
from google.oauth2 import service_account
import runpod

def ensure_tmp_dir() -> str:
    tmp_dir = os.getenv("TMPDIR") or "/tmp"
    os.makedirs(tmp_dir, exist_ok=True)
    return tmp_dir

# ---------------------------------------------------------------------------- #
#                               Handler Logic                                  #
# ---------------------------------------------------------------------------- #

def _sanitize_for_log(obj, _depth=0):
    """Pass-through for logging payload (no redaction)."""
    if _depth > 10:
        return "[max depth]"
    if isinstance(obj, dict):
        return {k: _sanitize_for_log(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_for_log(x, _depth + 1) for x in obj]
    return obj


async def handler(job):
    print(f"Worker Start")
    input_data = job['input']
    try:
        import json
        print("[worker payload] received input:", json.dumps(_sanitize_for_log(input_data), indent=2, default=str))
    except Exception:
        print("[worker payload] received input (log serialization failed)")
    mode = input_data.get('mode')
    
    if mode == 'automatic':
        return await handle_automatic_mode(input_data)
    elif mode == 'semi-automatic':
        return await handle_semi_automatic_mode(input_data)
    elif mode == 'automatic_batch':
        return await handle_automatic_batch_mode(input_data)
    elif mode == 'docs_automatic':
        return await handle_automatic_batch_mode(input_data)
    elif mode == 'docs_semi_automatic':
        return await handle_docs_semi_automatic_mode(input_data)
    elif mode == 'fetch_results':
        return await handle_fetch_results_mode(input_data)
    elif mode == 'cleanup_group':
        return await handle_cleanup_group(input_data)
    elif mode == 'text-image':
        return await handle_text_image_mode(input_data)
    else:
        return {
            "error": f"Invalid mode: {mode}",
            "refresh_worker": True,
        }

# ---------------------------------------------------------------------------- #
#                           Automatic Batch (Gemini)                           #
# ---------------------------------------------------------------------------- #

async def handle_automatic_batch_mode(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Submit Gemini Batch API job(s) from worker.
    - Builds JSONL requests (with chunking) from prompts x images x ratios x variations.
    - Uploads JSONL via Files API and creates batch jobs.
    - Returns immediately with batch_job_names; no polling to save cost.
    """
    job_id = input_data.get("job_id") or input_data.get("jobId") or f"job_{int(time.time())}"
    config = input_data.get("config", {}) or {}
    prompts = input_data.get("prompts") or []
    prompt_template = input_data.get("prompt_template")
    model_name = input_data.get("model") or config.get("model") or "gemini-2.5-flash-image"
    num_variations = config.get("num_variations", 1)
    resolution = config.get("resolution")  # e.g., 1K/2K/4K for gemini-3-pro-image-preview
    aspect_ratios = config.get("aspect_ratios") or [config.get("aspect_ratio") or "1:1"]
    gcs_files = input_data.get("gcs_files") or []
    image_urls = input_data.get("image_urls") or []
    inline_data = input_data.get("inline_data") or []
    gcs_config = input_data.get("gcs_config")
    preuploaded_jsonl_files = input_data.get("preuploaded_jsonl_files") or []
    folder = input_data.get("folder")
    save_jsonl_to_gcs = input_data.get("save_jsonl_to_gcs", True)

    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "refresh_worker": True}

    # Fast path: reuse already-uploaded JSONL files (retry without needing folder/images)
    if preuploaded_jsonl_files:
        client = genai.Client(api_key=api_key)
        batch_names: List[str] = []
        for idx, file_uri in enumerate(preuploaded_jsonl_files):
            src_uri = normalize_file_uri(file_uri)
            batch = client.batches.create(
                model=model_name,
                src=src_uri,
                config={"display_name": f"batch-job-{job_id}-retry-{idx}"},
            )
            bname = getattr(batch, "name", None) or getattr(batch, "batch", {}).get("name")
            if bname:
                batch_names.append(bname)
        return {
            "status": "batch_submitted",
            "batch_job_names": batch_names,
            "batch_src_files": preuploaded_jsonl_files,
            "request_keys": [],
            "resource_jsonl_gcs_urls": [],
            "refresh_worker": True,
        }

    # Expand prompt variables if template provided
    expanded_prompts = expand_prompt_template(prompt_template) if prompt_template else (prompts if isinstance(prompts, list) else [prompts])
    if not expanded_prompts:
        return {"status": "failed", "error": "Prompt is required", "refresh_worker": True}

    # Load inline images (prefer inline_data passed from client; else download from GCS using gcs_files)
    inline_images = sorted(inline_data, key=lambda x: x.get("index", 0))
    if not inline_images:
        if image_urls:
            inline_images = await load_inline_images_from_urls(image_urls)
        elif gcs_files:
            inline_images = await load_inline_images_from_gcs(gcs_files, gcs_config)
        elif folder and gcs_config:
            # Retry-from-start path: list files from a GCS folder and load via public URLs
            try:
                gcs_client = initialize_gcs_client(gcs_config)
                bucket_name = gcs_config.get("bucket_name")
                urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder, gcs_config)
                inline_images = await load_inline_images_from_urls(urls)
                print(f"[automatic_batch] loaded {len(inline_images)} images from folder={folder}")
            except Exception as e:
                return {"status": "failed", "error": f"Failed to load images from folder: {e}", "refresh_worker": True}
        else:
            return {"status": "failed", "error": "No images provided", "refresh_worker": True}
    if not inline_images:
        return {"status": "failed", "error": "No images found to batch", "refresh_worker": True}

    client = genai.Client(api_key=api_key)

    # JSONL upload sizing (Batch API file mode):
    # - Input file size limit can be up to 2GB, but you may still hit timeouts / memory / storage limits
    #   if you create very large files. We use a higher default to reduce chunk count.
    # - Count bytes precisely (utf-8 + newline) and NEVER cut base64.
    #
    # Override via env:
    # - BATCH_JSONL_MAX_BYTES (bytes)
    # - BATCH_JSONL_MAX_REQUESTS (lines per file)
    # Default to 1536 MiB (1.5 GiB), a power-of-two multiple for nicer binary sizing.
    # Override via env if needed.
    MAX_JSONL_BYTES = int(os.getenv("BATCH_JSONL_MAX_BYTES", str(1536 * 1024 * 1024)))
    MAX_REQUESTS = int(os.getenv("BATCH_JSONL_MAX_REQUESTS", "1000"))

    batch_names: List[str] = []
    src_files: List[str] = []
    request_keys: List[str] = []
    current_lines: List[str] = []
    current_size = 0
    chunk_summaries: List[Dict[str, Any]] = []
    resource_jsonl_gcs_urls: List[str] = []
    gcs_client_for_resources = None
    if gcs_config and save_jsonl_to_gcs:
        try:
            gcs_client_for_resources = initialize_gcs_client(gcs_config)
        except Exception as e:
            print(f"[automatic_batch] failed init gcs for resource jsonl: {e}")
            gcs_client_for_resources = None

    def flush_chunk(chunk_idx: int):
        nonlocal current_lines, current_size, batch_names, resource_jsonl_gcs_urls
        if not current_lines:
            return
        tmp_dir = ensure_tmp_dir()
        fd, tmp_path = tempfile.mkstemp(dir=tmp_dir, suffix=".jsonl")
        bytes_written = 0
        try:
            with os.fdopen(fd, "wb") as f:
                for ln in current_lines:
                    b = ln.encode("utf-8")
                    f.write(b)
                    f.write(b"\n")
                    bytes_written += len(b) + 1
        except Exception:
            try:
                os.close(fd)
            except Exception:
                pass
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            raise

        chunk_summaries.append({
            "chunk_idx": chunk_idx,
            "lines": len(current_lines),
            "bytes": bytes_written,
        })
        try:
            if gcs_client_for_resources and gcs_config and save_jsonl_to_gcs:
                try:
                    gcs_url = upload_file_to_gcs_sync(
                        gcs_client_for_resources,
                        gcs_config.get("bucket_name"),
                        tmp_path,
                        f"{job_id}/resources/requests_chunk_{chunk_idx}.jsonl",
                        gcs_config,
                        content_type="application/jsonl",
                    )
                    resource_jsonl_gcs_urls.append(gcs_url)
                except Exception as e:
                    print(f"[automatic_batch] failed upload request jsonl to gcs chunk={chunk_idx}: {e}")
            uploaded = client.files.upload(
                file=tmp_path,
                config=types.UploadFileConfig(mime_type="application/jsonl", display_name=f"batch_requests_{job_id}_{chunk_idx}"),
            )
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        file_uri = normalize_file_uri(getattr(uploaded, "uri", None) or getattr(uploaded, "name", None))
        batch = client.batches.create(
            model=model_name,
            src=file_uri,
            config={"display_name": f"batch-job-{job_id}-{chunk_idx}"},
        )
        src_files.append(file_uri)
        batch_name = getattr(batch, "name", None) or getattr(batch, "batch", {}).get("name")
        if batch_name:
            batch_names.append(batch_name)
        # reset
        current_lines = []
        current_size = 0

    request_count = 0
    prompt_len = len(expanded_prompts)
    total_slots = max(len(inline_images), prompt_len)
    global_req_idx = 0
    for slot in range(total_slots):
        img = inline_images[slot % len(inline_images)]
        prompt_idx = slot % prompt_len
        prompt = expanded_prompts[prompt_idx]
        for ratio in aspect_ratios:
            ratio_slug = str(ratio).replace(":", "x")
            for variation in range(num_variations):
                request_obj = {
                    "contents": [{
                        "role": "user",
                        "parts": [
                            {"inlineData": img.get("inlineData") or img.get("inline_data")},
                            {"text": prompt},
                        ],
                    }],
                    "generationConfig": {
                        "responseModalities": ["IMAGE"],
                    },
                }
                if model_name == "gemini-3-pro-image-preview":
                    request_obj["generationConfig"]["imageConfig"] = {
                        "aspectRatio": ratio,
                        "imageSize": (resolution or "1K").upper(),
                    }
                key = f"r{ratio_slug}_p{prompt_idx}_img{img.get('index',0)}_var{variation}"
                line = json.dumps({
                    "key": key,
                    "request": request_obj,
                })
                request_keys.append(key)
                line_size = len(line.encode("utf-8")) + 1  # + newline separator
                if line_size > MAX_JSONL_BYTES:
                    return {
                        "status": "failed",
                        "error": f"Single request too large for JSONL chunking (line_bytes={line_size} max_bytes={MAX_JSONL_BYTES}). "
                                 f"Image index={img.get('index', 0)}. Please compress/resize or switch to file references.",
                        "refresh_worker": True,
                    }
                if (current_size + line_size > MAX_JSONL_BYTES) or (request_count >= MAX_REQUESTS):
                    flush_chunk(len(batch_names))
                    request_count = 0
                current_lines.append(line)
                current_size += line_size
                request_count += 1
                global_req_idx += 1

    # flush remaining
    flush_chunk(len(batch_names))

    print(f"[automatic_batch] job_id={job_id} requests={len(request_keys)} chunks={len(batch_names)} "
          f"max_bytes={MAX_JSONL_BYTES} max_requests={MAX_REQUESTS}")
    if chunk_summaries:
        print(f"[automatic_batch] chunk_summaries={json.dumps(chunk_summaries[:10])}"
              f"{' ...' if len(chunk_summaries) > 10 else ''}")

    return {
        "status": "batch_submitted",
        "batch_job_names": batch_names,
        "batch_src_files": src_files,
        "request_keys": request_keys,
        "resource_jsonl_gcs_urls": resource_jsonl_gcs_urls,
        "refresh_worker": True,
    }

async def handle_automatic_mode(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle automatic mode: batch process large image sets
    Automatic mode: Uses ONE prompt for ALL images
    Input can be: 'prompt' (string) OR 'prompts' (list with single prompt)
    """
    folder_path = input_data.get("folder")
    
    # Automatic mode: Chỉ cần 1 prompt cho tất cả ảnh
    # Next.js có thể gửi 'prompt' (string) hoặc 'prompts' (list với 1 phần tử)
    prompt = input_data.get("prompt")  # Ưu tiên tìm 'prompt' string trước
    
    # Nếu không có 'prompt', thử lấy từ 'prompts' list (tương thích với Next.js)
    if not prompt or (isinstance(prompt, str) and not prompt.strip()):
        prompts_list = input_data.get("prompts")
        if prompts_list:
            if isinstance(prompts_list, list) and len(prompts_list) > 0:
                # Lấy prompt đầu tiên từ list (automatic mode chỉ dùng 1 prompt)
                prompt = prompts_list[0] if isinstance(prompts_list[0], str) else str(prompts_list[0])
                print(f"[Automatic] Using first prompt from 'prompts' list: {prompt[:80]}...")
            elif isinstance(prompts_list, str):
                # Trường hợp prompts là string (backward compatibility)
                prompt = prompts_list
                print(f"[Automatic] Using 'prompts' as string: {prompt[:80]}...")
    
    # Validate prompt cuối cùng
    if not prompt or (isinstance(prompt, str) and not prompt.strip()):
        return {
            "status": "failed",
            "error": "Missing or empty 'prompt'/'prompts' in input for automatic mode. Please provide a valid prompt.",
            "results": [],
            "total": 0,
            "refresh_worker": True,
        }
    
    # Đảm bảo prompt là string và hợp lệ
    prompt = str(prompt).strip()
    if len(prompt) < 3:
        return {
            "status": "failed",
            "error": f"Prompt too short (minimum 3 characters). Got: '{prompt}'",
            "results": [],
            "total": 0,
            "refresh_worker": True,
        }

    config = input_data.get("config", {})
    num_variations = config.get("num_variations", 1)
    resolution = config.get("resolution")  # Get resolution from config (for gemini-3-pro-image-preview)
    aspect_ratio = config.get("aspect_ratio")  # Get aspect ratio from config (for gemini-3-pro-image-preview)
    gcs_config = input_data.get("gcs_config")
    job_id = input_data.get("job_id", "")
    
    if not folder_path or not gcs_config:
        return {"status": "failed", "error": "Missing folder or GCS config", "results": [], "total": 0, "refresh_worker": True}
    
    gcs_client = initialize_gcs_client(gcs_config)
    bucket_name = gcs_config.get("bucket_name")
    
    print(f"[Automatic] Listing files from: {folder_path}")
    image_urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config)
    print(f"[Automatic] Found {len(image_urls)} files, using single prompt: {prompt[:80]}...")
    
    if not image_urls:
        return {"status": "failed", "error": "No images found", "results": [], "total": 0, "refresh_worker": True}
    
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "results": [], "total": 0, "refresh_worker": True}
    
    # Get model from input_data first, then from config, then default
    model_name = input_data.get("model") or config.get("model") or "gemini-3-pro-image-preview"
    print(f"[Automatic] Using model: {model_name}")
    
    async def process_image(idx: int, image_url: str):
        try:
            image_bytes = await download_image(image_url)
            image_results = []
            for variation in range(num_variations):
                # Generate Image
                generated_image = await generate_image_async(image_bytes, prompt, api_key, model_name, resolution, aspect_ratio)
                
                if gcs_client and gcs_config:
                    timestamp = int(time.time() * 1000)
                    unique_id = f"{timestamp}_{idx}_{variation}"
                    # Same folder as uploads: job_id/xxx_gemini.jpg
                    rel_path = f"{job_id}/{unique_id}_gemini.jpg" if job_id else f"processed/{unique_id}_gemini.jpg"
                    gcs_url = await upload_to_gcs_async(
                        gcs_client,
                        generated_image,
                        gcs_config,
                        rel_path,
                    )
                    image_results.append({
                        "original_index": idx,
                        "variation": variation,
                        "gcs_url": gcs_url
                    })
                else:
                    image_results.append({
                        "original_index": idx,
                        "variation": variation,
                        "image": base64.b64encode(generated_image).decode("utf-8")
                    })
            return image_results
        except Exception as e:
            print(f"Error processing image {idx}: {e}")
            return [{"original_index": idx, "error": str(e)}]
    
    tasks = [process_image(idx, url) for idx, url in enumerate(image_urls)]
    results_list = await asyncio.gather(*tasks)
    results = [item for sublist in results_list for item in sublist]
    
    return {
        "status": "completed",
        "results": results,
        "total_generated": len(results),
        "refresh_worker": True,
    }

async def handle_semi_automatic_mode(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle semi-automatic mode
    Semi-automatic mode: Uses MULTIPLE prompts (array)
    Input: 'prompts' (list) - each image can have multiple prompts
    """
    folder_path = input_data.get("folder")
    
    # Semi-automatic mode: Cần mảng prompts (nhiều prompts)
    # Next.js gửi 'prompts' là một mảng các prompts
    prompts = input_data.get("prompts", [])
    
    # Validate prompts
    if not prompts or not isinstance(prompts, list) or len(prompts) == 0:
        return {
            "status": "failed",
            "error": "Missing or empty 'prompts' (list) in input for semi-automatic mode. Please provide prompts array.",
            "results": [],
            "total": 0,
            "refresh_worker": True,
        }
    
    config = input_data.get("config", {})
    images_per_prompt = config.get("images_per_prompt", {})
    resolution = config.get("resolution")  # Get resolution from config (for gemini-3-pro-image-preview)
    aspect_ratio = config.get("aspect_ratio")  # Get aspect ratio from config (for gemini-3-pro-image-preview)
    gcs_config = input_data.get("gcs_config")
    job_id = input_data.get("job_id", "")
    
    if not folder_path or not gcs_config:
        return {"status": "failed", "error": "Missing folder or GCS config", "results": [], "total": 0, "refresh_worker": True}
    
    gcs_client = initialize_gcs_client(gcs_config)
    bucket_name = gcs_config.get("bucket_name")
    
    print(f"[Semi-Auto] Listing files from: {folder_path}")
    image_urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config)
    print(f"[Semi-Auto] Found {len(image_urls)} files, using {len(prompts)} prompts")
    
    if not image_urls:
        return {"status": "failed", "error": "No images found", "results": [], "total": 0, "refresh_worker": True}
    
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "results": [], "total": 0, "refresh_worker": True}
    
    # Get model from input_data first, then from config, then default
    model_name = input_data.get("model") or config.get("model") or "gemini-3-pro-image-preview"
    print(f"[Semi-Auto] Using model: {model_name}")
    
    async def process_image_prompt(img_idx: int, image_url: str):
        try:
            image_bytes = await download_image(image_url)
            
            image_prompts = prompts if isinstance(prompts, list) else prompts.get(str(img_idx), [])
            if isinstance(image_prompts, str):
                image_prompts = [image_prompts]
            
            image_results = []
            
            for prompt_idx, prompt in enumerate(image_prompts):
                num_images = images_per_prompt.get(f"{img_idx}_{prompt_idx}", 1)
                
                async def generate_for_prompt(gen_idx: int):
                    try:
                        generated_image = await generate_image_async(image_bytes, prompt, api_key, model_name, resolution, aspect_ratio)
                        
                        if gcs_client and gcs_config:
                            timestamp = int(time.time() * 1000)
                            unique_id = f"{timestamp}_{img_idx}_{prompt_idx}_{gen_idx}"
                            output_gcs_prefix = config.get("output_gcs_prefix")
                            if output_gcs_prefix:
                                # Docs Semi Automatic: save to .../gemini/ folder (same level as input)
                                full_path = f"{output_gcs_prefix.rstrip('/')}/{img_idx}/prompt_{prompt_idx}/gen_{gen_idx}_{unique_id}_gemini.jpg"
                                bucket = gcs_client.bucket(gcs_config.get("bucket_name"))
                                blob = bucket.blob(full_path)
                                blob.upload_from_string(generated_image, content_type="image/jpeg")
                                cdn = gcs_config.get("cdn_url")
                                gcs_url = f"{cdn.rstrip('/')}/{full_path}" if cdn else f"https://storage.googleapis.com/{gcs_config.get('bucket_name')}/{full_path}"
                            else:
                                # Same folder as uploads: job_id/xxx_gemini.jpg
                                rel_path = f"{job_id}/semi_{unique_id}_gemini.jpg" if job_id else f"processed/semi_{unique_id}_gemini.jpg"
                                gcs_url = await upload_to_gcs_async(
                                    gcs_client,
                                    generated_image,
                                    gcs_config,
                                    rel_path,
                                )
                            return {
                                "image_index": img_idx,
                                "prompt_index": prompt_idx,
                                "generation_index": gen_idx,
                                "prompt": prompt,
                                "gcs_url": gcs_url
                            }
                        else:
                            return {
                                "image_index": img_idx,
                                "prompt": prompt,
                                "image": base64.b64encode(generated_image).decode("utf-8")
                            }
                    except Exception as e:
                        return {"image_index": img_idx, "error": str(e)}
                
                gen_tasks = [generate_for_prompt(gen_idx) for gen_idx in range(num_images)]
                prompt_results = await asyncio.gather(*gen_tasks)
                image_results.extend(prompt_results)
            
            return image_results
        except Exception as e:
            return [{"image_index": img_idx, "error": str(e)}]
    
    tasks = [process_image_prompt(img_idx, url) for img_idx, url in enumerate(image_urls)]
    results_list = await asyncio.gather(*tasks)
    results = [item for sublist in results_list for item in sublist]
    
    return {
        "status": "completed",
        "results": results,
        "total_generated": len([r for r in results if "gcs_url" in r or "image" in r]),
        "refresh_worker": True,
    }

async def handle_docs_semi_automatic_mode(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Same generation as semi-automatic, but images are saved only under output_gcs_prefix
    with flat filenames: .../gemini/gemini-gen_{img_idx}_{ts}_{prompt_idx}_{gen_idx}_gemini.jpg
    No job_id/processed/semi-auto subfolders.
    """
    folder_path = input_data.get("folder")
    prompts = input_data.get("prompts", [])
    config = input_data.get("config", {}) or {}
    output_gcs_prefix = config.get("output_gcs_prefix")
    if not output_gcs_prefix:
        return {
            "status": "failed",
            "error": "Docs Semi Automatic requires config.output_gcs_prefix (e.g. gemini-generate/test_docs_generate/gemini)",
            "results": [],
            "total": 0,
            "refresh_worker": True,
        }
    images_per_prompt = config.get("images_per_prompt", {})
    resolution = config.get("resolution")
    aspect_ratio = config.get("aspect_ratio")
    gcs_config = input_data.get("gcs_config")
    if not folder_path or not gcs_config:
        return {"status": "failed", "error": "Missing folder or GCS config", "results": [], "total": 0, "refresh_worker": True}

    gcs_client = initialize_gcs_client(gcs_config)
    bucket_name = gcs_config.get("bucket_name")
    print(f"[Docs-Semi] Listing files from: {folder_path}, output prefix: {output_gcs_prefix}")
    image_urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config)
    print(f"[Docs-Semi] Found {len(image_urls)} files, {len(prompts)} prompts")
    if not image_urls:
        return {"status": "failed", "error": "No images found", "results": [], "total": 0, "refresh_worker": True}

    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "results": [], "total": 0, "refresh_worker": True}
    model_name = input_data.get("model") or config.get("model") or "gemini-3-pro-image-preview"

    bucket = gcs_client.bucket(bucket_name)
    prefix_flat = output_gcs_prefix.rstrip("/")

    async def process_image_prompt(img_idx: int, image_url: str):
        try:
            image_bytes = await download_image(image_url)
            image_prompts = prompts if isinstance(prompts, list) else prompts.get(str(img_idx), [])
            if isinstance(image_prompts, str):
                image_prompts = [image_prompts]
            image_results = []
            for prompt_idx, prompt in enumerate(image_prompts):
                num_images = images_per_prompt.get(f"{img_idx}_{prompt_idx}", 1)

                async def generate_for_prompt(gen_idx: int):
                    try:
                        generated_image = await generate_image_async(
                            image_bytes, prompt, api_key, model_name, resolution, aspect_ratio
                        )
                        timestamp = int(time.time() * 1000)
                        fname = f"gemini-gen_{img_idx}_{timestamp}_{prompt_idx}_{gen_idx}_gemini.jpg"
                        full_path = f"{prefix_flat}/{fname}"
                        blob = bucket.blob(full_path)
                        blob.upload_from_string(generated_image, content_type="image/jpeg")
                        cdn = gcs_config.get("cdn_url")
                        gcs_url = (
                            f"{cdn.rstrip('/')}/{full_path}"
                            if cdn
                            else f"https://storage.googleapis.com/{bucket_name}/{full_path}"
                        )
                        return {
                            "image_index": img_idx,
                            "prompt_index": prompt_idx,
                            "generation_index": gen_idx,
                            "prompt": prompt,
                            "gcs_url": gcs_url,
                        }
                    except Exception as e:
                        return {"image_index": img_idx, "error": str(e)}

                gen_tasks = [generate_for_prompt(gen_idx) for gen_idx in range(num_images)]
                prompt_results = await asyncio.gather(*gen_tasks)
                image_results.extend(prompt_results)
            return image_results
        except Exception as e:
            return [{"image_index": img_idx, "error": str(e)}]

    tasks = [process_image_prompt(img_idx, url) for img_idx, url in enumerate(image_urls)]
    results_list = await asyncio.gather(*tasks)
    results = [item for sublist in results_list for item in sublist]
    return {
        "status": "completed",
        "results": results,
        "total_generated": len([r for r in results if "gcs_url" in r or "image" in r]),
        "refresh_worker": True,
    }

# ---------------------------------------------------------------------------- #
#                        Text-to-Image (Prompt only)                           #
# ---------------------------------------------------------------------------- #

async def handle_text_image_mode(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Generate images directly from prompts (no reference image) using Gemini text-to-image.
    Uploads results to GCS and returns metadata similar to automatic modes.
    """
    prompts = input_data.get("prompts")
    prompt_template = input_data.get("prompt_template")
    config = input_data.get("config", {}) or {}
    model_name = input_data.get("model") or config.get("model") or "gemini-3-pro-image-preview"
    num_variations = max(1, int(config.get("num_variations") or 1))
    aspect_ratio = config.get("aspect_ratio") or "1:1"
    ratio_slug = str(aspect_ratio).replace(":", "x")
    resolution = config.get("resolution")
    if model_name == "gemini-3-pro-image-preview":
        if resolution:
            resolution = str(resolution).upper()
            if resolution not in {"1K", "2K", "4K"}:
                print(f"[text-image] invalid resolution '{resolution}' for {model_name}, fallback 1K")
                resolution = "1K"
        else:
            resolution = "1K"
    gcs_config = input_data.get("gcs_config")
    job_id = input_data.get("job_id") or input_data.get("jobId") or f"text_job_{int(time.time())}"
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")

    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "refresh_worker": True}
    if not gcs_config:
        return {"status": "failed", "error": "Missing GCS config for upload", "refresh_worker": True}

    prompt_list: List[str] = []
    if isinstance(prompts, list):
        prompt_list = [str(p).strip() for p in prompts if str(p).strip()]
    elif isinstance(prompts, str) and prompts.strip():
        prompt_list = [prompts.strip()]
    if not prompt_list and prompt_template:
        prompt_list = [p for p in expand_prompt_template(str(prompt_template)) if p.strip()]

    if not prompt_list:
        return {"status": "failed", "error": "No prompts provided for text-image mode", "refresh_worker": True}

    try:
        gcs_client = initialize_gcs_client(gcs_config)
    except Exception as e:
        return {"status": "failed", "error": f"Failed to init GCS client: {e}", "refresh_worker": True}

    total_generated = 0
    results: List[Dict[str, Any]] = []

    for prompt_index, prompt_text in enumerate(prompt_list):
        for variation in range(num_variations):
            try:
                images = await generate_images_from_prompt_http(
                    prompt_text,
                    api_key=api_key,
                    model_name=model_name,
                    aspect_ratio=aspect_ratio,
                    resolution=resolution,
                )
                for img_idx, img in enumerate(images):
                    filename = build_text_image_path(job_id, ratio_slug, prompt_index, variation, img_idx)
                    gcs_url = await upload_to_gcs_async(
                        gcs_client,
                        img["bytes"],
                        gcs_config,
                        filename,
                        content_type=img.get("mime_type") or "image/png",
                    )
                    results.append({
                        "original_index": prompt_index,
                        "variation": variation,
                        "ratio": aspect_ratio,
                        "gcs_url": gcs_url,
                        "prompt": prompt_text,
                    })
                    total_generated += 1
            except Exception as e:
                err_msg = str(e)
                print(f"[text-image] prompt_idx={prompt_index} variation={variation} error={err_msg}")
                results.append({
                    "original_index": prompt_index,
                    "variation": variation,
                    "ratio": aspect_ratio,
                    "error": err_msg,
                    "prompt": prompt_text,
                })

    return {
        "status": "completed",
        "results": results,
        "total_generated": total_generated,
        "refresh_worker": True,
    }

# ---------------------------------------------------------------------------- #
#                            Gemini Generation Logic                           #
# ---------------------------------------------------------------------------- #

async def generate_image_async(image_bytes: bytes, prompt: str, api_key: str = None, model_name: str = "gemini-3-pro-image-preview", resolution: str = None, aspect_ratio: str = None) -> bytes:
    if not api_key:
        api_key = os.environ.get("GEMINI_API_KEY")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, generate_image_sync, image_bytes, prompt, api_key, model_name, resolution, aspect_ratio)


def generate_image_sync(image_bytes: bytes, prompt: str, api_key: str, model_name: str = "gemini-3-pro-image-preview", resolution: str = None, aspect_ratio: str = None) -> bytes:
    """
    Synchronous Gemini API call
    Supports multiple Gemini image generation models
    For gemini-3-pro-image-preview, supports resolution: "1K", "2K", "4K"
    and aspect_ratio: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    """
    # Validate prompt không rỗng (safety check)
    if not prompt or not prompt.strip():
        raise ValueError("Prompt cannot be empty. Please provide a valid image generation instruction.")
    
    client = genai.Client(api_key=api_key)
    model = model_name
    
    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_bytes(mime_type="image/jpeg", data=image_bytes),
                types.Part.from_text(text=prompt),  # Gửi prompt trực tiếp, không wrap
            ],
        ),
    ]
    
    # Configure image settings for gemini-3-pro-image-preview
    image_config = None
    is_gemini_3_pro = model == "gemini-3-pro-image-preview"
    
    if is_gemini_3_pro:
        # For gemini-3-pro-image-preview, always set image_config
        # Use provided resolution or default to 1K
        if resolution:
            # Validate resolution (must be uppercase K)
            valid_resolutions = ["1K", "2K", "4K"]
            if resolution.upper() not in valid_resolutions:
                print(f"[Gemini] Warning: Invalid resolution '{resolution}', using default '1K'")
                resolution = "1K"
            else:
                resolution = resolution.upper()  # Ensure uppercase K
        else:
            resolution = "1K"  # Default resolution
            print(f"[Gemini] No resolution specified, using default '1K' for model {model}")
        
        # Use provided aspect_ratio or default to 1:1
        if not aspect_ratio:
            aspect_ratio = "1:1"  # Default aspect ratio
            print(f"[Gemini] No aspect ratio specified, using default '1:1' for model {model}")
        else:
            # Validate aspect ratio
            valid_aspect_ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
            if aspect_ratio not in valid_aspect_ratios:
                print(f"[Gemini] Warning: Invalid aspect ratio '{aspect_ratio}', using default '1:1'")
                aspect_ratio = "1:1"
        
        image_config = types.ImageConfig(
            aspect_ratio=aspect_ratio,
            image_size=resolution
        )
        print(f"[Gemini] Using resolution: {resolution}, aspect_ratio: {aspect_ratio} for model {model}")
    
    # Request both IMAGE and TEXT modalities as per documentation
    # The model will return both, but we prioritize image data
    generate_content_config = types.GenerateContentConfig(
        response_modalities=["IMAGE", "TEXT"],
        image_config=image_config if image_config else None,
    )
    
    image_data = None
    all_text_responses = []
    all_chunks_data = []
    print(f"[Gemini] Processing with model '{model}', prompt: {prompt[:100]}...")

    try:
        for chunk in client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=generate_content_config,
        ):
            # Collect full chunk data for debugging
            chunk_info = {
                "has_candidates": bool(chunk.candidates),
                "candidates_count": len(chunk.candidates) if chunk.candidates else 0,
            }
            
            if chunk.candidates and len(chunk.candidates) > 0:
                candidate = chunk.candidates[0]
                chunk_info["candidate_finish_reason"] = getattr(candidate, "finish_reason", None)
                chunk_info["candidate_safety_ratings"] = getattr(candidate, "safety_ratings", None)
                
                if candidate.content and candidate.content.parts:
                    chunk_info["parts_count"] = len(candidate.content.parts)
                    parts_info = []
                    
                    for part_idx, part in enumerate(candidate.content.parts):
                        part_info = {
                            "part_index": part_idx,
                            "has_text": hasattr(part, "text") and bool(part.text),
                            "has_inline_data": bool(part.inline_data),
                            "has_as_image": False,
                        }
                        
                        # Check for image data - try multiple methods
                        # Method 1: Check inline_data first (most reliable)
                        if part.inline_data and part.inline_data.data:
                            image_data = part.inline_data.data
                            part_info["image_data_size"] = len(part.inline_data.data)
                            part_info["image_mime_type"] = getattr(part.inline_data, "mime_type", None)
                            print(f"[Gemini] Image generated successfully via inline_data ({len(image_data)} bytes)")
                            # Still collect this chunk info but return immediately
                            parts_info.append(part_info)
                            all_chunks_data.append({
                                **chunk_info,
                                "parts": parts_info
                            })
                            return image_data
                        
                        # Method 2: Try as_image() method (may return PIL Image or other format)
                        image_obj = None
                        try:
                            if hasattr(part, "as_image"):
                                image_obj = part.as_image()
                        except Exception as e:
                            print(f"[Gemini] as_image() failed: {e}")
                            pass
                        
                        if image_obj:
                            # Try to convert to bytes - handle different return types
                            try:
                                # If it's already bytes
                                if isinstance(image_obj, bytes):
                                    image_data = image_obj
                                # If it's a PIL Image
                                elif hasattr(image_obj, "save"):
                                    img_bytes = io.BytesIO()
                                    # Try without format parameter first
                                    try:
                                        image_obj.save(img_bytes)
                                    except:
                                        # Fallback: try with format
                                        img_bytes = io.BytesIO()
                                        image_obj.save(img_bytes, format='PNG')
                                    image_data = img_bytes.getvalue()
                                # If it has tobytes() method
                                elif hasattr(image_obj, "tobytes"):
                                    image_data = image_obj.tobytes()
                                else:
                                    # Try to get bytes some other way
                                    image_data = bytes(image_obj)
                                
                                part_info["has_as_image"] = True
                                part_info["image_data_size"] = len(image_data)
                                print(f"[Gemini] Image generated successfully via as_image() ({len(image_data)} bytes)")
                                # Still collect this chunk info but return immediately
                                parts_info.append(part_info)
                                all_chunks_data.append({
                                    **chunk_info,
                                    "parts": parts_info
                                })
                                return image_data
                            except Exception as e:
                                print(f"[Gemini] Failed to convert as_image() to bytes: {e}")
                                # Continue to try other methods
                        
                        # Collect text responses
                        if hasattr(part, "text") and part.text:
                            text_content = part.text
                            all_text_responses.append(text_content)
                            part_info["text_preview"] = text_content[:200]
                            part_info["text_length"] = len(text_content)
                            print(f"[Gemini Text Output]: {text_content[:200]}...")
                        
                        parts_info.append(part_info)
                    
                    chunk_info["parts"] = parts_info
            
            all_chunks_data.append(chunk_info)
                
    except Exception as e:
        # Log lỗi chi tiết với full response data
        error_msg = str(e)
        print(f"[Gemini API Error]: {error_msg}")
        print(f"[Gemini Full Response Data]:")
        print(f"  Text Responses ({len(all_text_responses)}): {json.dumps(all_text_responses, indent=2, ensure_ascii=False)}")
        print(f"  All Chunks Data: {json.dumps(all_chunks_data, indent=2, default=str, ensure_ascii=False)}")
        raise ValueError(f"Gemini image generation failed: {error_msg}\nFull response: {json.dumps({'text_responses': all_text_responses, 'chunks': all_chunks_data}, indent=2, default=str, ensure_ascii=False)}")

    if not image_data:
        # Return full response when no image is generated
        full_response = {
            "text_responses": all_text_responses,
            "chunks_data": all_chunks_data,
            "total_text_chunks": len(all_text_responses),
            "total_chunks": len(all_chunks_data)
        }
        print(f"[Gemini] No image data received. Full response:")
        print(json.dumps(full_response, indent=2, default=str, ensure_ascii=False))
        raise ValueError(
            f"Gemini finished stream but returned no image data. "
            f"Model may have returned text instead of image. Check your prompt.\n"
            f"Full response: {json.dumps(full_response, indent=2, default=str, ensure_ascii=False)}"
        )
    
    return image_data

# ---------------------------------------------------------------------------- #
#                                 Helpers                                      #
# ---------------------------------------------------------------------------- #

async def list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config) -> List[str]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _list_files_from_gcs_folder_sync, gcs_client, bucket_name, folder_path, gcs_config)

def _list_files_from_gcs_folder_sync(gcs_client, bucket_name, folder_path, gcs_config) -> List[str]:
    bucket = gcs_client.bucket(bucket_name)
    prefix = folder_path.rstrip("/") + "/"
    blobs = bucket.list_blobs(prefix=prefix)
    
    cdn_url = gcs_config.get("cdn_url")
    if cdn_url: cdn_url = cdn_url.rstrip("/")
    
    file_urls = []
    for blob in blobs:
        if blob.name.endswith("/"):
            continue
        if not any(blob.name.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.webp']):
            continue
        # Exclude generated images (labeled _gemini) so only user uploads are used as input
        fname = blob.name.split("/")[-1]
        if "_gemini" in fname:
            continue

        # Public URL first (objects are uploaded public). Avoid signed URLs to prevent 400.
        if cdn_url:
            file_urls.append(f"{cdn_url}/{blob.name}")
        else:
            file_urls.append(f"https://storage.googleapis.com/{bucket_name}/{blob.name}")
    return file_urls

async def download_image(image_url: str) -> bytes:
    r = await http_get_with_retry(image_url, timeout=30, attempts=3, follow_redirects=True)
    return r.content

def initialize_gcs_client(gcs_config: Dict[str, Any]) -> storage.Client:
    credentials_data = gcs_config.get("credentials")
    if not credentials_data:
        raise ValueError("No GCS credentials")
    creds = json.loads(credentials_data) if isinstance(credentials_data, str) else credentials_data
    credentials = service_account.Credentials.from_service_account_info(creds)
    return storage.Client(credentials=credentials)

async def upload_to_gcs_async(gcs_client, image_bytes, gcs_config, filename, content_type: str = "image/jpeg") -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, upload_to_gcs_sync, gcs_client, gcs_config.get("bucket_name"), filename, image_bytes, gcs_config, content_type)

def upload_to_gcs_sync(gcs_client, bucket_name, blob_path, image_bytes, gcs_config=None, content_type: str = "image/jpeg") -> str:
    def label_gemini(path: str) -> str:
        """Label generated images: use _gemini in filename; avoid double prefix if already present."""
        if not path:
            return path
        parts = path.rsplit("/", 1)
        dir_part = parts[0] if len(parts) == 2 else ""
        fname = parts[-1]
        # Already labeled with _gemini (e.g. xxx_gemini.jpg) or gemini- prefix: keep as is
        if "_gemini" in fname or fname.startswith("gemini-") or fname.startswith("gemini_"):
            return path
        # Label generated image with _gemini (suffix before extension)
        new_fname = f"gemini-{fname}"
        return f"{dir_part}/{new_fname}" if dir_part else new_fname

    # Prepend path prefix if provided
    if gcs_config:
        prefix = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix")
        if prefix:
            blob_path = f"{prefix.rstrip('/')}/{blob_path.lstrip('/')}"

    # Label generated images (prepend gemini- only when filename does not already have _gemini)
    blob_path = label_gemini(blob_path)

    bucket = gcs_client.bucket(bucket_name)
    blob = bucket.blob(blob_path)
    blob.upload_from_string(image_bytes, content_type=content_type or "application/octet-stream")
    # Always return public GCS URL (objects are uploaded public)
    cdn = gcs_config.get("cdn_url") if gcs_config else None
    if cdn:
        return f"{cdn.rstrip('/')}/{blob_path}"
    return f"https://storage.googleapis.com/{bucket_name}/{blob_path}"

async def upload_file_to_gcs_async(
    gcs_client,
    local_path: str,
    gcs_config: Dict[str, Any],
    filename: str,
    content_type: str = "application/octet-stream",
) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        upload_file_to_gcs_sync,
        gcs_client,
        gcs_config.get("bucket_name"),
        local_path,
        filename,
        gcs_config,
        content_type,
    )

def upload_file_to_gcs_sync(
    gcs_client,
    bucket_name: str,
    local_path: str,
    blob_path: str,
    gcs_config: Dict[str, Any] | None = None,
    content_type: str = "application/octet-stream",
) -> str:
    # Prepend path prefix if provided
    if gcs_config:
        prefix = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix")
        if prefix:
            blob_path = f"{prefix.rstrip('/')}/{blob_path.lstrip('/')}"

    # Ensure filename uniqueness by prepending 'gemini-'
    parts = blob_path.rsplit("/", 1)
    if len(parts) == 2:
        d, f = parts
        if not (f.startswith("gemini-") or f.startswith("gemini_")):
            blob_path = f"{d}/gemini-{f}"
    else:
        if not (blob_path.startswith("gemini-") or blob_path.startswith("gemini_")):
            blob_path = f"gemini-{blob_path}"

    bucket = gcs_client.bucket(bucket_name)
    blob = bucket.blob(blob_path)
    blob.upload_from_filename(local_path, content_type=content_type or "application/octet-stream")

    cdn = gcs_config.get("cdn_url") if gcs_config else None
    if cdn:
        return f"{cdn.rstrip('/')}/{blob_path}"
    return f"https://storage.googleapis.com/{bucket_name}/{blob_path}"

async def generate_images_from_prompt_http(
    prompt: str,
    *,
    api_key: str,
    model_name: str,
    aspect_ratio: str | None = None,
    resolution: str | None = None,
) -> List[Dict[str, Any]]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
    image_config = {}
    if aspect_ratio:
        image_config["aspectRatio"] = aspect_ratio
    if resolution:
        image_config["imageSize"] = resolution

    payload: Dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
        },
    }
    if image_config:
        payload["generationConfig"]["imageConfig"] = image_config
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            raise ValueError(f"Gemini text-image error {resp.status_code}: {resp.text}")
        data = resp.json()
    images: List[Dict[str, Any]] = []
    candidates = data.get("candidates") or []
    for candidate in candidates:
        parts = []
        content = candidate.get("content")
        if content and isinstance(content, dict):
            parts = content.get("parts") or []
        elif candidate.get("parts"):
            parts = candidate.get("parts")
        for part in parts or []:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                try:
                    img_bytes = base64.b64decode(inline["data"])
                except Exception:
                    continue
                images.append({
                    "bytes": img_bytes,
                    "mime_type": inline.get("mimeType") or inline.get("mime_type") or "image/png",
                })
    if not images:
        raise ValueError("Gemini returned no image data")
    return images

def build_text_image_path(job_id: str, ratio_slug: str, prompt_index: int, variation: int, image_idx: int) -> str:
    ts = int(time.time() * 1000)
    safe_ratio = ratio_slug or "default"
    return f"{job_id}/processed/text-image/{safe_ratio}/prompt_{prompt_index}/variation_{variation}_{ts}_{image_idx}.png"

def expand_prompt_template(template: str) -> List[str]:
    if not template:
        return []
    regex = r"\{([^{}]+)\}"
    segments = []
    variables = []
    last = 0
    import re
    for m in re.finditer(regex, template):
        segments.append(template[last:m.start()])
        options = [s.strip() for s in m.group(1).split(",") if s.strip()]
        variables.append(options or [""])
        last = m.end()
    segments.append(template[last:])
    if not variables:
        return [template]
    start_time = time.time()
    results = []
    def build(idx: int, current: str):
        if idx == len(variables):
            results.append(current + segments[idx])
            return
        for opt in variables[idx]:
            build(idx + 1, current + segments[idx] + opt)
    build(0, "")
    return results

async def load_inline_images_from_gcs(gcs_files: List[Dict[str, Any]], gcs_config: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not gcs_files:
        return []
    inline_images = []
    for file in sorted(gcs_files, key=lambda x: x.get("index", 0)):
        # Prefer direct publicUrl if available to avoid extra auth
        public_url = file.get("publicUrl") or file.get("public_url")
        if public_url:
            data = await download_image(public_url)
            mime = file.get("contentType") or "image/jpeg"
        else:
            if not gcs_config:
                continue
            gcs_client = initialize_gcs_client(gcs_config)
            bucket = gcs_client.bucket(gcs_config.get("bucket_name"))
            prefix = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix") or ""
            gcs_path = file.get("gcsPath") or file.get("gcs_path") or ""
            if prefix and not gcs_path.startswith(prefix):
                gcs_path = f"{prefix.rstrip('/')}/{gcs_path.lstrip('/')}"
            blob = bucket.blob(gcs_path)
            data = blob.download_as_bytes()
            mime = file.get("contentType") or "image/jpeg"
        inline_images.append({
            "index": file.get("index", 0),
            "inlineData": {
                "mimeType": mime,
                "data": base64.b64encode(data).decode("utf-8")
            }
        })
    return inline_images

async def load_inline_images_from_urls(urls: List[str]) -> List[Dict[str, Any]]:
    inline_images = []
    for idx, url in enumerate(urls):
        data = await download_image(url)
        inline_images.append({
            "index": idx,
            "inlineData": {
                "mimeType": "image/jpeg",
                "data": base64.b64encode(data).decode("utf-8")
            }
        })
    return inline_images

def normalize_file_uri(uri: str) -> str:
    if not uri:
        return uri
    if uri.startswith("http"):
        import re
        m = re.search(r"/files/([^/\?]+)", uri)
        if m:
            return f"files/{m.group(1)}"
    if not uri.startswith("files/"):
        return f"files/{uri}"
    return uri

# ---------------------------------------------------------------------------- #
#                           HTTP helper with retries                           #
# ---------------------------------------------------------------------------- #

async def http_get_with_retry(
    url: str,
    *,
    timeout: float = 30.0,
    attempts: int = 3,
    delay: float = 1.5,
    follow_redirects: bool = False,
) -> httpx.Response:
    last_error = None
    last_status = None
    for attempt in range(1, attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=follow_redirects) as client:
                resp = await client.get(url)
                last_status = resp.status_code
                if resp.status_code == 200:
                    return resp
        except httpx.HTTPError as e:
            last_error = e
        if attempt < attempts:
            await asyncio.sleep(delay * attempt)
    if last_error:
        raise last_error
    raise ValueError(f"GET {url} failed, last status {last_status}")


async def stream_jsonl_with_retry(
    url: str,
    *,
    timeout: float = 60.0,
    attempts: int = 2,
    delay: float = 1.5,
    follow_redirects: bool = True,
):
    """
    Stream lines from a JSONL URL with retry. Yields text lines.
    """
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=follow_redirects) as client:
                async with client.stream("GET", url) as resp:
                    if resp.status_code != 200:
                        last_error = ValueError(f"status {resp.status_code}")
                        raise last_error
                    async for line in resp.aiter_lines():
                        yield line
                    return
        except Exception as e:
            last_error = e
        if attempt < attempts:
            await asyncio.sleep(delay * attempt)
    if last_error:
        raise last_error

# ---------------------------------------------------------------------------- #
#                         Fetch batch results in worker                        #
# ---------------------------------------------------------------------------- #

async def handle_fetch_results_mode(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Worker downloads Gemini Batch outputs and uploads results to GCS.
    Returns results in webhook output to avoid Next.js timeouts.
    """
    try:
        print("[fetch_results] payload:", json.dumps(_sanitize_for_log(input_data), indent=2, default=str))
    except Exception:
        print("[fetch_results] payload (log serialization failed)")
    job_id = input_data.get("job_id") or input_data.get("jobId")
    batch_names = input_data.get("batch_job_names") or input_data.get("batch_names") or []
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    gcs_config = input_data.get("gcs_config")
    save_response_jsonl_to_gcs = input_data.get("save_response_jsonl_to_gcs", True)

    if not job_id or not batch_names:
        return {"status": "failed", "error": "Missing job_id or batch_job_names", "refresh_worker": True}
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "refresh_worker": True}

    start_time = time.time()
    results = []
    total_bytes = 0
    files_to_delete = []
    response_files = []
    response_jsonl_gcs_urls: List[str] = []
    batch_names_to_delete = list(batch_names)
    print(f"[fetch_results] start group/job {input_data.get('group_id')}/{job_id} batches={batch_names}")

    for name in batch_names:
        # resolve file name via batch get
        client = genai.Client(api_key=api_key)
        batch = client.batches.get(name=name)
        dest = getattr(batch, "dest", None) or getattr(batch, "output", None)
        file_name = None
        if dest:
            file_name = getattr(dest, "file_name", None) or getattr(dest, "fileName", None) or getattr(dest, "file", None)
        if not file_name and getattr(batch, "output", None):
            file_name = getattr(batch.output, "fileUri", None) or getattr(batch.output, "file", None)
        if not file_name:
            continue

        file_uri = normalize_file_uri(file_name)
        files_to_delete.append(file_uri)
        response_files.append(file_uri)
        download_url = f"https://generativelanguage.googleapis.com/download/v1beta/{file_uri}:download?alt=media&key={api_key}"

        batch_start = time.time()
        bytes_this_batch = 0
        images_this_batch = 0
        tmp_out_path = None
        batch_slug = str(name).split("/")[-1]
        if gcs_config and save_response_jsonl_to_gcs:
            tmp_out = tempfile.NamedTemporaryFile(delete=False, dir=ensure_tmp_dir(), suffix=f"_{batch_slug}.jsonl")
            tmp_out_path = tmp_out.name
            tmp_out.close()
        try:
            async for line in stream_jsonl_with_retry(download_url, timeout=90, attempts=2, follow_redirects=True):
                if not line or not line.strip():
                    continue
                bytes_this_batch += len(line.encode("utf-8")) + 1
                total_bytes += len(line.encode("utf-8")) + 1
                if tmp_out_path:
                    try:
                        with open(tmp_out_path, "ab") as f:
                            f.write(line.encode("utf-8") + b"\n")
                    except Exception as e:
                        print(f"[fetch_results] failed write response jsonl tmp={tmp_out_path} err={e}")
                try:
                    parsed = json.loads(line)
                    images = extract_images_from_batch_line(parsed)
                    images_this_batch += len(images)
                    results.extend(images)
                except Exception:
                    continue
            duration = time.time() - batch_start
            print(f"[fetch_results] batch {name} done images={images_this_batch} bytes={bytes_this_batch} duration={duration:.1f}s")
            if tmp_out_path and gcs_config and save_response_jsonl_to_gcs:
                try:
                    gcs_client = initialize_gcs_client(gcs_config)
                    gcs_url = await upload_file_to_gcs_async(
                        gcs_client,
                        tmp_out_path,
                        gcs_config,
                        f"{job_id}/resources/responses_{batch_slug}.jsonl",
                        content_type="application/jsonl",
                    )
                    response_jsonl_gcs_urls.append(gcs_url)
                except Exception as e:
                    print(f"[fetch_results] failed upload response jsonl batch={batch_slug} err={e}")
        except Exception as e:
            print(f"[fetch_results] download failed {download_url} error={e}")
            continue
        finally:
            if tmp_out_path:
                try:
                    os.remove(tmp_out_path)
                except Exception:
                    pass

    # Upload to GCS if configured
    output_gcs_prefix = input_data.get("output_gcs_prefix")  # Docs Automatic: save to .../gemini/ instead of job_id/processed/
    if gcs_config and results:
        gcs_client = initialize_gcs_client(gcs_config)
        uploaded = []
        bucket = gcs_client.bucket(gcs_config.get("bucket_name"))
        print(f"[fetch_results] uploading {len(results)} images to GCS" + (f" (output_gcs_prefix={output_gcs_prefix})" if output_gcs_prefix else ""))
        for idx, img in enumerate(results):
            if not img.get("base64"):
                continue
            try:
                buffer = base64.b64decode(img["base64"])
                ratio_slug = img.get("ratio_slug") or "default"
                orig = img.get("original_index")
                var = img.get("variation")
                pidx = img.get("prompt_index")
                if orig is None or var is None:
                    filename = f"result_{idx}.png"
                else:
                    filename = f"p{pidx}_img{orig}_var{var}.png" if pidx is not None else f"img{orig}_var{var}.png"
                # Docs Automatic: use output_gcs_prefix (e.g. gemini-generate/test_docs_generate/gemini) as full path prefix
                if output_gcs_prefix:
                    # Docs: save to .../gemini/ with _gemini label
                    base, ext = filename.rsplit(".", 1) if "." in filename else (filename, "png")
                    fname = f"{base}_gemini.{ext}" if "_gemini" not in base else filename
                    normalized_path = f"{output_gcs_prefix.rstrip('/')}/{fname}"
                    blob = bucket.blob(normalized_path)
                    if blob.exists():
                        cdn = gcs_config.get("cdn_url")
                        gcs_url = f"{cdn.rstrip('/')}/{normalized_path}" if cdn else f"https://storage.googleapis.com/{gcs_config.get('bucket_name')}/{normalized_path}"
                    else:
                        blob.upload_from_string(buffer, content_type=img.get("mimeType") or "image/png")
                        gcs_url = f"{gcs_config.get('cdn_url', '').rstrip('/')}/{normalized_path}" if gcs_config.get("cdn_url") else f"https://storage.googleapis.com/{gcs_config.get('bucket_name')}/{normalized_path}"
                    uploaded.append({
                        "gcs_url": gcs_url,
                        "variation": img.get("variation"),
                        "original_index": img.get("original_index"),
                        "ratio": img.get("ratio"),
                    })
                else:
                    # Automatic batch: same folder as uploads (job_id/), label _gemini
                    base, ext = filename.rsplit(".", 1) if "." in filename else (filename, "png")
                    fname_gemini = f"{base}_gemini.{ext}" if "_gemini" not in base else filename
                    path = f"{job_id}/{fname_gemini}"
                    gcs_url = await upload_to_gcs_async(
                        gcs_client,
                        buffer,
                        gcs_config,
                        path,
                        content_type=img.get("mimeType") or "image/png",
                    )
                    uploaded.append({
                        "gcs_url": gcs_url,
                        "variation": img.get("variation"),
                        "original_index": img.get("original_index"),
                        "ratio": img.get("ratio"),
                    })
                if (idx + 1) % 10 == 0:
                    print(f"[fetch_results] uploaded {idx+1}/{len(results)}")
            except Exception as e:
                print(f"[fetch_results] upload failed idx={idx} err={e}")
        # De-dup by URL in case multiple batches return same key
        seen_urls = set()
        results = []
        for r in uploaded:
            url = r.get("gcs_url")
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            results.append(r)

    if files_to_delete:
        print(f"[fetch_results] files retained for cleanup_group: {len(files_to_delete)}")
    if batch_names_to_delete:
        print(f"[fetch_results] batches retained for cleanup_group: {len(batch_names_to_delete)}")

    print(f"[fetch_results] done total_images={len(results)} total_bytes={total_bytes}")
    return {
        "status": "completed",
        "results": results,
        "total_generated": len(results),
        "total_bytes": total_bytes,
        "response_files": response_files,
        "response_jsonl_gcs_urls": response_jsonl_gcs_urls,
        "batch_job_names": batch_names_to_delete,
        "duration_sec": round(time.time() - start_time, 1),
        "refresh_worker": True,
    }

def extract_images_from_batch_line(parsed: Any) -> List[Dict[str, Any]]:
    out = []
    response = parsed.get("response") or parsed
    candidates = response.get("candidates", [])
    key = response.get("key") or parsed.get("key") or ""
    for cand in candidates:
        parts = cand.get("content", {}).get("parts", []) or cand.get("parts", [])
        for part in parts:
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                match = None
                ratio = None
                ratio_slug = None
                prompt_index = None
                if key:
                    import re
                    match = re.search(r"r([0-9x]+)_p(\d+)_img(\d+)_var(\d+)", key)
                    if match:
                        ratio = match.group(1).replace("x", ":")
                        ratio_slug = match.group(1)
                        prompt_index = int(match.group(2))
                out.append({
                    "base64": inline["data"],
                    "mimeType": inline.get("mimeType", "image/png"),
                    "key": key,
                    "ratio_slug": ratio_slug,
                    "prompt_index": prompt_index,
                    "ratio": ratio,
                    "variation": int(match.group(4)) if match else None,
                    "original_index": int(match.group(3)) if match else None,
                })
    return out

# ---------------------------------------------------------------------------- #
#                              Cleanup Group (GCS + Gemini)                    #
# ---------------------------------------------------------------------------- #

async def handle_cleanup_group(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Cleanup group artifacts:
    - Delete files in GCS under prefix/jobId
    - Delete Gemini Files whose displayName/name contains any jobId
    - (DB deletion is handled in Next.js before enqueuing)
    """
    group_id = input_data.get("group_id")
    job_ids = input_data.get("job_ids") or []
    gcs_config = input_data.get("gcs_config")
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")

    if not group_id or not job_ids:
        print("[cleanup] missing group_id or job_ids, skipping")
        return {"status": "skipped", "reason": "missing group_id or job_ids", "refresh_worker": True}

    deleted_gcs = 0
    deleted_files = 0
    matched_files = 0
    matched_batches = 0
    deleted_batches = 0
    batch_names = input_data.get("batch_names") or input_data.get("batch_job_names") or []
    batch_src_files = input_data.get("batch_src_files") or []
    response_files = input_data.get("response_files") or []
    purge_gemini_all = bool(input_data.get("purge_gemini_all") or input_data.get("purge_all_gemini"))

    # GCS cleanup
    if gcs_config:
        gcs_client = initialize_gcs_client(gcs_config)
        bucket = gcs_client.bucket(gcs_config.get("bucket_name"))
        prefix_base = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix") or ""
        for job_id in job_ids:
            prefix = f"{prefix_base.rstrip('/')}/{job_id}"
            blobs = bucket.list_blobs(prefix=prefix)
            for blob in blobs:
                try:
                    blob.delete()
                    deleted_gcs += 1
                except Exception:
                    continue

    # Gemini file cleanup + batch cleanup
    if api_key:
        try:
            client = genai.Client(api_key=api_key)

            # DANGEROUS: purge everything in Gemini project (Files + Batches).
            # Guarded by an explicit flag + env allowlist to avoid accidental data loss.
            if purge_gemini_all:
                allow = os.getenv("ALLOW_GEMINI_PURGE_ALL")
                if str(allow).lower() not in {"1", "true", "yes", "y"}:
                    return {
                        "status": "failed",
                        "error": "purge_gemini_all requested but ALLOW_GEMINI_PURGE_ALL is not enabled",
                        "refresh_worker": True,
                    }
                print("[cleanup] PURGE ALL GEMINI FILES + BATCHES requested (ALLOW_GEMINI_PURGE_ALL enabled)")
                purged_files = 0
                purged_batches = 0
                # Delete all files
                try:
                    for f in client.files.list():
                        name = getattr(f, "name", None) or getattr(f, "uri", None)
                        if not name:
                            continue
                        norm = name if str(name).startswith("files/") else f"files/{str(name).split('/')[-1]}"
                        try:
                            client.files.delete(name=norm)
                            purged_files += 1
                        except Exception as e:
                            print(f"[cleanup] failed purge file {norm}: {e}")
                except Exception as e:
                    print(f"[cleanup] list files failed during purge: {e}")

                # Delete all batches
                try:
                    for b in client.batches.list():
                        bname = getattr(b, "name", None)
                        if not bname:
                            continue
                        try:
                            client.batches.delete(name=bname)
                            purged_batches += 1
                        except Exception as e:
                            print(f"[cleanup] failed purge batch {bname}: {e}")
                except Exception as e:
                    print(f"[cleanup] list batches failed during purge: {e}")

                return {
                    "status": "completed",
                    "deleted_gcs": deleted_gcs,
                    "purged_gemini_files": purged_files,
                    "purged_gemini_batches": purged_batches,
                    "refresh_worker": True,
                }

            # Preferred: strict cleanup by explicit resource names (fast, avoids scanning).
            files_to_delete = []
            for sf in batch_src_files:
                files_to_delete.append(normalize_file_uri(sf))
            for rf in response_files:
                files_to_delete.append(normalize_file_uri(rf))
            # de-dup while keeping order
            seen = set()
            files_to_delete = [f for f in files_to_delete if not (f in seen or seen.add(f))]
            batch_names = list(dict.fromkeys(batch_names))  # de-dup

            if files_to_delete or batch_names:
                print(f"[cleanup] strict delete files={len(files_to_delete)} batches={len(batch_names)}")

                for furi in files_to_delete:
                    try:
                        client.files.delete(name=furi)
                        deleted_files += 1
                        matched_files += 1
                        print(f"[cleanup] deleted Gemini file {furi}")
                    except Exception as e:
                        print(f"[cleanup] failed delete file {furi}: {e}")

                for b in batch_names:
                    try:
                        client.batches.delete(name=b)
                        deleted_batches += 1
                        matched_batches += 1
                        print(f"[cleanup] deleted batch {b}")
                    except Exception as e:
                        print(f"[cleanup] failed delete batch {b}: {e}")
            else:
                # No explicit lists provided -> no Gemini cleanup (avoid scanning whole project).
                print("[cleanup] no batch/file lists provided; skipping Gemini cleanup")
        except Exception as e:
            return {"status": "failed", "error": f"Gemini cleanup failed: {e}", "refresh_worker": True}

    return {
        "status": "completed",
        "deleted_gcs": deleted_gcs,
        "deleted_gemini_files": deleted_files,
        "matched_gemini_files": matched_files,
        "matched_batches": matched_batches,
        "deleted_batches": deleted_batches,
        "refresh_worker": True,
    }

if __name__ == "__main__":
    runpod.serverless.start({
        "handler": handler
    })
