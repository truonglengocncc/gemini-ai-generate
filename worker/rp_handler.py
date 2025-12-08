"""
RunPod Serverless Handler for Image Generation
Supports both Automatic and Semi-Automatic modes with concurrent processing
"""

import base64
import os
import json
import asyncio
import aiohttp
import time
import io
from typing import Dict, Any, List
from google import genai
from google.genai import types
from google.cloud import storage
from google.oauth2 import service_account
import runpod

# ---------------------------------------------------------------------------- #
#                               Handler Logic                                  #
# ---------------------------------------------------------------------------- #

async def handler(job):
    print(f"Worker Start")
    input_data = job['input']
    
    mode = input_data.get('mode')
    
    # Note: Automatic mode with batch API is now handled in Next.js directly
    # RunPod worker only handles regular automatic mode and semi-automatic mode
    if mode == 'automatic':
        return await handle_automatic_mode(input_data)
    elif mode == 'semi-automatic':
        return await handle_semi_automatic_mode(input_data)
    else:
        return {
            "error": f"Invalid mode: {mode}"
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
            "total": 0
        }
    
    # Đảm bảo prompt là string và hợp lệ
    prompt = str(prompt).strip()
    if len(prompt) < 3:
        return {
            "status": "failed",
            "error": f"Prompt too short (minimum 3 characters). Got: '{prompt}'",
            "results": [],
            "total": 0
        }

    config = input_data.get("config", {})
    num_variations = config.get("num_variations", 1)
    resolution = config.get("resolution")  # Get resolution from config (for gemini-3-pro-image-preview)
    aspect_ratio = config.get("aspect_ratio")  # Get aspect ratio from config (for gemini-3-pro-image-preview)
    gcs_config = input_data.get("gcs_config")
    job_id = input_data.get("job_id", "")
    
    if not folder_path or not gcs_config:
        return {"status": "failed", "error": "Missing folder or GCS config", "results": [], "total": 0}
    
    gcs_client = initialize_gcs_client(gcs_config)
    bucket_name = gcs_config.get("bucket_name")
    
    print(f"[Automatic] Listing files from: {folder_path}")
    image_urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config)
    print(f"[Automatic] Found {len(image_urls)} files, using single prompt: {prompt[:80]}...")
    
    if not image_urls:
        return {"status": "failed", "error": "No images found", "results": [], "total": 0}
    
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "results": [], "total": 0}
    
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
                    path_prefix = f"{job_id}/processed" if job_id else "processed"
                    # prepend global path prefix if provided
                    if gcs_config:
                        prefix = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix")
                        if prefix:
                            path_prefix = f"{prefix.rstrip('/')}/{path_prefix}"
                    
                    gcs_url = await upload_to_gcs_async(
                        gcs_client,
                        generated_image,
                        gcs_config,
                        f"{path_prefix}/automatic/{idx}/variation_{variation}_{unique_id}.jpg"
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
        "total_generated": len(results)
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
            "total": 0
        }
    
    config = input_data.get("config", {})
    images_per_prompt = config.get("images_per_prompt", {})
    resolution = config.get("resolution")  # Get resolution from config (for gemini-3-pro-image-preview)
    aspect_ratio = config.get("aspect_ratio")  # Get aspect ratio from config (for gemini-3-pro-image-preview)
    gcs_config = input_data.get("gcs_config")
    job_id = input_data.get("job_id", "")
    
    if not folder_path or not gcs_config:
        return {"status": "failed", "error": "Missing folder or GCS config", "results": [], "total": 0}
    
    gcs_client = initialize_gcs_client(gcs_config)
    bucket_name = gcs_config.get("bucket_name")
    
    print(f"[Semi-Auto] Listing files from: {folder_path}")
    image_urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config)
    print(f"[Semi-Auto] Found {len(image_urls)} files, using {len(prompts)} prompts")
    
    if not image_urls:
        return {"status": "failed", "error": "No images found", "results": [], "total": 0}
    
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "results": [], "total": 0}
    
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
                            path_prefix = f"{job_id}/processed" if job_id else "processed"
                            prefix = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix")
                            if prefix:
                                path_prefix = f"{prefix.rstrip('/')}/{path_prefix}"
                            
                            gcs_url = await upload_to_gcs_async(
                                gcs_client,
                                generated_image,
                                gcs_config,
                                f"{path_prefix}/semi-auto/{img_idx}/prompt_{prompt_idx}/gen_{gen_idx}_{unique_id}.jpg"
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
        "total_generated": len([r for r in results if "gcs_url" in r or "image" in r])
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

        # Public URL first (objects are uploaded public). Avoid signed URLs to prevent 400.
        if cdn_url:
            file_urls.append(f"{cdn_url}/{blob.name}")
        else:
            file_urls.append(f"https://storage.googleapis.com/{bucket_name}/{blob.name}")
    return file_urls

async def download_image(image_url: str) -> bytes:
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as response:
            if response.status != 200:
                raise ValueError(f"Failed download: {image_url} ({response.status})")
            return await response.read()

def initialize_gcs_client(gcs_config: Dict[str, Any]) -> storage.Client:
    credentials_data = gcs_config.get("credentials")
    if not credentials_data:
        raise ValueError("No GCS credentials")
    creds = json.loads(credentials_data) if isinstance(credentials_data, str) else credentials_data
    credentials = service_account.Credentials.from_service_account_info(creds)
    return storage.Client(credentials=credentials)

async def upload_to_gcs_async(gcs_client, image_bytes, gcs_config, filename) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, upload_to_gcs_sync, gcs_client, gcs_config.get("bucket_name"), filename, image_bytes, gcs_config)

def upload_to_gcs_sync(gcs_client, bucket_name, blob_path, image_bytes, gcs_config=None) -> str:
    # Prepend path prefix if provided
    if gcs_config:
        prefix = gcs_config.get("path_prefix") or gcs_config.get("path_prefixes") or gcs_config.get("root_prefix")
        if prefix:
            blob_path = f"{prefix.rstrip('/')}/{blob_path.lstrip('/')}"

    bucket = gcs_client.bucket(bucket_name)
    blob = bucket.blob(blob_path)
    blob.upload_from_string(image_bytes, content_type="image/jpeg")
    # Always return public GCS URL (objects are uploaded public)
    cdn = gcs_config.get("cdn_url") if gcs_config else None
    if cdn:
        return f"{cdn.rstrip('/')}/{blob_path}"
    return f"https://storage.googleapis.com/{bucket_name}/{blob_path}"

def adjust_concurrency(current_concurrency: int) -> int:
    return 20 if current_concurrency < 20 else current_concurrency

if __name__ == "__main__":
    runpod.serverless.start({
        "handler": handler,
        "concurrency_modifier": adjust_concurrency
    })
