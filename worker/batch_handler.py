"""
Batch API Handler for Automatic Mode
Creates Gemini Batch jobs and returns immediately with batch_job_name
Next.js will handle polling and result processing
"""

import os
import json
import asyncio
import aiohttp
from typing import Dict, Any, List
from google import genai
from google.genai import types
from google.cloud import storage
from google.oauth2 import service_account


async def handle_automatic_mode_batch(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle automatic mode using Gemini Batch API
    - Upload images to Gemini File API
    - Create JSONL batch file
    - Submit batch job
    - Return immediately with batch_job_name (Next.js will poll)
    """
    folder_path = input_data.get("folder")
    
    # Get prompt (same logic as regular automatic mode)
    prompt = input_data.get("prompt")
    if not prompt or (isinstance(prompt, str) and not prompt.strip()):
        prompts_list = input_data.get("prompts")
        if prompts_list:
            if isinstance(prompts_list, list) and len(prompts_list) > 0:
                prompt = prompts_list[0] if isinstance(prompts_list[0], str) else str(prompts_list[0])
            elif isinstance(prompts_list, str):
                prompt = prompts_list
    
    if not prompt or (isinstance(prompt, str) and not prompt.strip()):
        return {
            "status": "failed",
            "error": "Missing or empty 'prompt'/'prompts' in input for automatic mode.",
            "results": [],
            "total": 0
        }
    
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
    resolution = config.get("resolution")
    aspect_ratio = config.get("aspect_ratio")
    gcs_config = input_data.get("gcs_config")
    job_id = input_data.get("job_id", "")
    
    if not folder_path or not gcs_config:
        return {"status": "failed", "error": "Missing folder or GCS config", "results": [], "total": 0}
    
    gcs_client = initialize_gcs_client(gcs_config)
    bucket_name = gcs_config.get("bucket_name")
    
    print(f"[Batch API] Listing files from: {folder_path}")
    image_urls = await list_files_from_gcs_folder(gcs_client, bucket_name, folder_path, gcs_config)
    print(f"[Batch API] Found {len(image_urls)} files, using prompt: {prompt[:80]}...")
    
    if not image_urls:
        return {"status": "failed", "error": "No images found", "results": [], "total": 0}
    
    api_key = input_data.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"status": "failed", "error": "Missing GEMINI_API_KEY", "results": [], "total": 0}
    
    model_name = input_data.get("model") or config.get("model") or "gemini-2.5-flash-image"
    print(f"[Batch API] Using model: {model_name}")
    
    # Step 1: Upload images to Gemini File API with chunk download and parallel processing
    print(f"[Batch API] Uploading {len(image_urls)} images to Gemini File API (parallel with chunk download)...")
    client = genai.Client(api_key=api_key)
    
    # Limit concurrent uploads to avoid overwhelming the API
    max_concurrent = 10  # Adjust based on API rate limits
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def upload_single_image(idx: int, image_url: str):
        """Download and upload a single image with chunk streaming"""
        async with semaphore:  # Limit concurrent requests
            try:
                # Stream download with chunks (memory efficient for large images)
                import io
                image_buffer = io.BytesIO()
                
                async with aiohttp.ClientSession() as session:
                    async with session.get(image_url) as response:
                        if response.status != 200:
                            raise ValueError(f"Failed download: {image_url} ({response.status})")
                        
                        # Stream download in chunks (default 64KB chunks)
                        async for chunk in response.content.iter_chunked(65536):  # 64KB chunks
                            image_buffer.write(chunk)
                
                image_buffer.seek(0)  # Reset to beginning for upload
                image_buffer.name = f"batch_image_{job_id}_{idx}.jpg"  # Required for upload
                
                # Upload to Gemini File API (streaming from buffer)
                uploaded_file = client.files.upload(
                    file=image_buffer,
                    config=types.UploadFileConfig(
                        display_name=f"batch_image_{job_id}_{idx}",
                        mime_type="image/jpeg"
                    )
                )
                
                print(f"[Batch API] Uploaded image {idx+1}/{len(image_urls)}: {uploaded_file.name}")
                return {
                    "index": idx,
                    "file_uri": uploaded_file.name,  # e.g., "files/abc123"
                    "image_url": image_url
                }
            except Exception as e:
                print(f"[Batch API] Error uploading image {idx}: {e}")
                raise Exception(f"Failed to upload image {idx} to Gemini File API: {str(e)}")
    
    # Process all images in parallel (with semaphore limiting)
    try:
        upload_tasks = [upload_single_image(idx, url) for idx, url in enumerate(image_urls)]
        uploaded_files = await asyncio.gather(*upload_tasks)
        # Sort by index to maintain order
        uploaded_files = sorted(uploaded_files, key=lambda x: x["index"])
        print(f"[Batch API] Successfully uploaded {len(uploaded_files)} images")
    except Exception as e:
        return {
            "status": "failed",
            "error": f"Failed to upload images to Gemini File API: {str(e)}",
            "results": [],
            "total": 0
        }
    
    # Step 2: Create JSONL batch file
    print(f"[Batch API] Creating JSONL batch file with {len(image_urls) * num_variations} requests...")
    batch_requests = []
    
    for img_data in uploaded_files:
        for variation in range(num_variations):
            # Build request for this image + variation
            # Note: JSONL file uses camelCase (raw JSON format), not snake_case
            request_obj = {
                "contents": [{
                    "parts": [
                        {"fileData": {"fileUri": img_data["file_uri"]}},
                        {"text": prompt}
                    ],
                    "role": "user"
                }],
                "generationConfig": {
                    "responseModalities": ["TEXT", "IMAGE"]  # Order: TEXT first as per docs
                }
            }
            
            # Add imageConfig for gemini-3-pro-image-preview
            if model_name == "gemini-3-pro-image-preview":
                if not resolution:
                    resolution = "1K"
                if not aspect_ratio:
                    aspect_ratio = "1:1"
                
                request_obj["generationConfig"]["imageConfig"] = {
                    "aspectRatio": aspect_ratio,
                    "imageSize": resolution.upper()
                }
            
            # Add to batch with unique key
            batch_requests.append({
                "key": f"image_{img_data['index']}_variation_{variation}",
                "request": request_obj
            })
    
    # Step 3: Create JSONL file content
    jsonl_lines = [json.dumps(req) for req in batch_requests]
    jsonl_content = "\n".join(jsonl_lines)
    
    # Step 4: Upload JSONL to Gemini File API
    print(f"[Batch API] Uploading JSONL batch file...")
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as tmp_file:
        tmp_file.write(jsonl_content)
        tmp_file_path = tmp_file.name
    
    try:
        jsonl_file = client.files.upload(
            file=tmp_file_path,
            config=types.UploadFileConfig(
                display_name=f"batch_requests_{job_id}",
                mime_type="application/jsonl"
            )
        )
        print(f"[Batch API] Uploaded JSONL file: {jsonl_file.name}")
    finally:
        os.unlink(tmp_file_path)
    
    # Step 5: Create batch job
    print(f"[Batch API] Creating batch job...")
    try:
        batch_job = client.batches.create(
            model=f"models/{model_name}",
            src=jsonl_file.name,  # File URI from File API
            config={
                "display_name": f"batch-job-{job_id}",
            }
        )
        
        print(f"[Batch API] Batch job created: {batch_job.name}")
        print(f"[Batch API] Batch job state: {batch_job.state}")
        
        # Return immediately with batch_job_name
        # Next.js will handle polling
        return {
            "status": "batch_submitted",
            "batch_job_name": batch_job.name,
            "batch_job_state": batch_job.state,
            "total_requests": len(batch_requests),
            "message": f"Batch job submitted successfully. Next.js will poll for completion.",
            "results": [],  # Will be populated by polling service
            "total": 0
        }
    except Exception as e:
        print(f"[Batch API] Error creating batch job: {e}")
        return {
            "status": "failed",
            "error": f"Failed to create batch job: {str(e)}",
            "results": [],
            "total": 0
        }


# Helper functions (same as rp_handler.py)
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
    """
    Download image with chunk streaming (memory efficient)
    Note: This function is kept for backward compatibility.
    For batch uploads, use upload_single_image which streams directly.
    """
    async with aiohttp.ClientSession() as session:
        async with session.get(image_url) as response:
            if response.status != 200:
                raise ValueError(f"Failed download: {image_url} ({response.status})")
            # Stream download in chunks
            chunks = []
            async for chunk in response.content.iter_chunked(65536):  # 64KB chunks
                chunks.append(chunk)
            return b''.join(chunks)

def initialize_gcs_client(gcs_config: Dict[str, Any]) -> storage.Client:
    credentials_data = gcs_config.get("credentials")
    if not credentials_data:
        raise ValueError("No GCS credentials")
    creds = json.loads(credentials_data) if isinstance(credentials_data, str) else credentials_data
    credentials = service_account.Credentials.from_service_account_info(creds)
    return storage.Client(credentials=credentials)

