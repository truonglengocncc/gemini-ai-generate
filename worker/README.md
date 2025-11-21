# RunPod Serverless Worker

Python worker for image generation using Banana Gemini API with concurrent processing support.

## Features

- **Async Handler**: Uses async/await for concurrent processing
- **Concurrent Processing**: Processes multiple images simultaneously
- **URL-based Input**: Accepts image URLs instead of base64 data
- **Dynamic Concurrency**: Automatically adjusts concurrency levels

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Set environment variable:
```bash
export GEMINI_API_KEY=your_api_key
```

## Build Docker Image

```bash
docker build -t image-generation-worker .
```

## Deploy to RunPod

1. Push image to container registry:
```bash
docker tag image-generation-worker your-registry/image-generation-worker:latest
docker push your-registry/image-generation-worker:latest
```

2. Create RunPod Serverless endpoint:
   - Handler: `handler` (async handler)
   - Container image: `your-registry/image-generation-worker:latest`
   - Environment variables: `GEMINI_API_KEY`
   - Concurrency modifier: Automatically configured

3. Test the endpoint:
```bash
curl -X POST https://api.runpod.io/v2/your-endpoint-id/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "input": {
      "mode": "semi-automatic",
      "images": ["https://example.com/image1.jpg"],
      "prompts": ["your prompt here"],
      "config": {
        "batch_size": 4,
        "images_per_prompt": {"0_0": 1}
      }
    }
  }'
```

## Handler Function

The handler function expects:
- `event.input.mode`: "automatic" or "semi-automatic"
- `event.input.images`: Array of image URLs (strings)
- `event.input.prompts`: Array of prompt strings (or dict mapping image indices)
- `event.input.config`: Configuration object
- `event.input.gcs_config`: Optional GCS configuration (see GCS_SETUP.md)

Returns:
- `status`: "completed" or "failed"
- `results`: Array of generated images
  - If GCS configured: Contains `gcs_url` field with signed URL
  - Otherwise: Contains `image` field with base64-encoded data
- `total_generated`: Number of successfully generated images
- `error`: Error message if failed

## Concurrency

The handler uses dynamic concurrency adjustment:
- Maximum concurrency: 10
- Minimum concurrency: 1
- Target concurrency: 5 (optimal for Gemini API)

The concurrency modifier automatically adjusts based on load to optimize resource usage while avoiding API rate limits.

## Image URLs

Images are downloaded from URLs using `aiohttp` for async HTTP requests. The handler supports:
- HTTP/HTTPS URLs
- Public image URLs
- URLs accessible from the RunPod worker network

For production, ensure images are stored in publicly accessible storage (S3, GCS, etc.) or use signed URLs.
