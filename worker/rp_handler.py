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
    
    model_name = input_data.get("model", "gemini-2.5-flash-image")
    
    async def process_image(idx: int, image_url: str):
        try:
            image_bytes = await download_image(image_url)
            image_results = []
            for variation in range(num_variations):
                # Generate Image
                generated_image = await generate_image_async(image_bytes, prompt, api_key, model_name)
                
                if gcs_client and gcs_config:
                    timestamp = int(time.time() * 1000)
                    unique_id = f"{timestamp}_{idx}_{variation}"
                    path_prefix = f"{job_id}/processed" if job_id else "processed"
                    
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
    
    model_name = input_data.get("model", "gemini-2.5-flash-image")
    
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
                        generated_image = await generate_image_async(image_bytes, prompt, api_key, model_name)
                        
                        if gcs_client and gcs_config:
                            timestamp = int(time.time() * 1000)
                            unique_id = f"{timestamp}_{img_idx}_{prompt_idx}_{gen_idx}"
                            path_prefix = f"{job_id}/processed" if job_id else "processed"
                            
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

async def generate_image_async(image_bytes: bytes, prompt: str, api_key: str = None, model_name: str = "gemini-2.5-flash-image") -> bytes:
    if not api_key:
        api_key = os.environ.get("GEMINI_API_KEY")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, generate_image_sync, image_bytes, prompt, api_key, model_name)


def generate_image_sync(image_bytes: bytes, prompt: str, api_key: str, model_name: str = "gemini-2.5-flash-image") -> bytes:
    """
    Synchronous Gemini API call
    Supports multiple Gemini image generation models
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
    
    generate_content_config = types.GenerateContentConfig(
        response_modalities=[
            "IMAGE",
            "TEXT",
        ],
    )
    
    image_data = None
    print(f"[Gemini] Processing with model '{model}', prompt: {prompt[:100]}...")

    try:
        for chunk in client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=generate_content_config,
        ):
            if not chunk.candidates or not chunk.candidates[0].content or not chunk.candidates[0].content.parts:
                continue
            
            part = chunk.candidates[0].content.parts[0]
            
            # Check for image data first
            if part.inline_data and part.inline_data.data:
                image_data = part.inline_data.data
                print(f"[Gemini] Image generated successfully ({len(image_data)} bytes)")
                return image_data
            
            # Log text chunks for debugging (nếu có)
            if hasattr(part, "text") and part.text:
                print(f"[Gemini Text Output]: {part.text[:200]}...")
                
    except Exception as e:
        # Log lỗi chi tiết
        error_msg = str(e)
        print(f"[Gemini API Error]: {error_msg}")
        raise ValueError(f"Gemini image generation failed: {error_msg}")

    if not image_data:
        raise ValueError(
            "Gemini finished stream but returned no image data. "
            "Model may have returned text instead of image. Check your prompt."
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
        if blob.name.endswith("/"): continue
        if not any(blob.name.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.webp']):
            continue

        if cdn_url:
            file_urls.append(f"{cdn_url}/{blob.name}")
        else:
            try:
                url = blob.generate_signed_url(expiration=86400, method="GET")
                file_urls.append(url)
            except:
                file_urls.append(blob.public_url or f"https://storage.googleapis.com/{bucket_name}/{blob.name}")
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
    bucket = gcs_client.bucket(bucket_name)
    blob = bucket.blob(blob_path)
    blob.upload_from_string(image_bytes, content_type="image/jpeg")
    if gcs_config and gcs_config.get("cdn_url"):
        return f"{gcs_config.get('cdn_url').rstrip('/')}/{blob_path}"
    try:
        return blob.generate_signed_url(expiration=86400, method="GET")
    except:
        return f"https://storage.googleapis.com/{bucket_name}/{blob_path}"

def adjust_concurrency(current_concurrency: int) -> int:
    return 20 if current_concurrency < 20 else current_concurrency

if __name__ == "__main__":
    runpod.serverless.start({
        "handler": handler,
        "concurrency_modifier": adjust_concurrency
    })