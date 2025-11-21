# Payload Format Documentation

Tài liệu này mô tả format JSON mà Next.js gửi lên cho RunPod worker.

## Cấu trúc tổng quát

RunPod API nhận request với format:
```json
{
  "input": {
    // Payload data ở đây
  }
}
```

## Automatic Mode

### Request từ Frontend → Next.js API

```json
{
  "mode": "automatic",
  "groupId": "group_123",
  "images": [
    "/uploads/image1.jpg",
    "/uploads/image2.jpg"
  ],
  "prompts": ["A beautiful landscape"],
  "config": {
    "num_variations": 1
  }
}
```

### Payload Next.js gửi → RunPod Worker

```json
{
  "input": {
    "mode": "automatic",
    "job_id": "job_1234567890_abc123",
    "images": [
      "https://cdn.capsure.co/job_1234567890_abc123/upload/image1.jpg",
      "https://cdn.capsure.co/job_1234567890_abc123/upload/image2.jpg"
    ],
    "prompts": "A beautiful landscape with mountains",
    "config": {
      "num_variations": 1
    },
    "gcs_config": {
      "credentials": { /* GCS Service Account JSON */ },
      "bucket_name": "capsure",
      "path_prefix": "",
      "cdn_url": "https://cdn.capsure.co",
      "job_id": "job_1234567890_abc123"
    }
  }
}
```

## Semi-Automatic Mode

### Request từ Frontend → Next.js API

```json
{
  "mode": "semi-automatic",
  "groupId": "group_456",
  "images": [
    "/uploads/ref_image1.jpg",
    "/uploads/ref_image2.jpg"
  ],
  "prompts": [
    "A modern minimalist design",
    "Vibrant colors with bold patterns"
  ],
  "config": {
    "batch_size": 4,
    "images_per_prompt": {
      "0_0": 2,
      "0_1": 1,
      "1_0": 3
    }
  }
}
```

### Payload Next.js gửi → RunPod Worker

```json
{
  "input": {
    "mode": "semi-automatic",
    "job_id": "job_1234567890_xyz789",
    "images": [
      "https://cdn.capsure.co/job_1234567890_xyz789/upload/ref_image1.jpg",
      "https://cdn.capsure.co/job_1234567890_xyz789/upload/ref_image2.jpg"
    ],
    "prompts": [
      "A modern minimalist design",
      "Vibrant colors with bold patterns",
      "Elegant and sophisticated style"
    ],
    "config": {
      "batch_size": 4,
      "images_per_prompt": {
        "0_0": 2,
        "0_1": 1,
        "1_0": 3,
        "1_1": 2
      }
    },
    "gcs_config": {
      "credentials": { /* GCS Service Account JSON */ },
      "bucket_name": "capsure",
      "path_prefix": "",
      "cdn_url": "https://cdn.capsure.co",
      "job_id": "job_1234567890_xyz789"
    }
  }
}
```

## Các trường dữ liệu

### Trường bắt buộc

- `mode`: `"automatic"` hoặc `"semi-automatic"`
- `job_id`: ID của job (được Next.js tự động thêm)
- `images`: Mảng các URL ảnh (có thể là CDN URL hoặc local URL)

### Trường tùy chọn

- `prompts`: 
  - Automatic mode: String hoặc mảng string
  - Semi-automatic mode: Mảng string
- `config`: Object chứa các cấu hình:
  - `num_variations`: Số lượng biến thể cho mỗi ảnh (automatic mode)
  - `batch_size`: Kích thước batch (semi-automatic mode)
  - `images_per_prompt`: Object mapping `"{image_index}_{prompt_index}": count` (semi-automatic mode)
- `gcs_config`: Cấu hình GCS (được Next.js tự động thêm từ env):
  - `credentials`: GCS Service Account JSON
  - `bucket_name`: Tên bucket (ví dụ: "capsure")
  - `path_prefix`: Tiền tố đường dẫn (thường rỗng)
  - `cdn_url`: CDN URL (ví dụ: "https://cdn.capsure.co")
  - `job_id`: ID của job (để tổ chức đường dẫn)

## Response từ Worker

### Automatic Mode Response

```json
{
  "status": "completed",
  "results": [
    {
      "original_index": 0,
      "variation": 0,
      "gcs_url": "https://cdn.capsure.co/job_1234567890_abc123/processed/automatic/0/variation_0_1234567890_0_0.jpg"
    },
    {
      "original_index": 1,
      "variation": 0,
      "gcs_url": "https://cdn.capsure.co/job_1234567890_abc123/processed/automatic/1/variation_0_1234567890_1_0.jpg"
    }
  ],
  "total_generated": 2
}
```

### Semi-Automatic Mode Response

```json
{
  "status": "completed",
  "results": [
    {
      "image_index": 0,
      "prompt_index": 0,
      "generation_index": 0,
      "prompt": "A modern minimalist design",
      "gcs_url": "https://cdn.capsure.co/job_1234567890_xyz789/processed/semi-auto/0/prompt_0/gen_0_1234567890_0_0_0.jpg"
    },
    {
      "image_index": 0,
      "prompt_index": 0,
      "generation_index": 1,
      "prompt": "A modern minimalist design",
      "gcs_url": "https://cdn.capsure.co/job_1234567890_xyz789/processed/semi-auto/0/prompt_0/gen_1_1234567890_0_0_1.jpg"
    }
  ],
  "total_generated": 2
}
```

## Lưu ý

1. **CDN URL**: Nếu `CDN_ASSETS_URL_CAPSURE` được cấu hình trong `.env`, tất cả URL trả về sẽ sử dụng CDN URL thay vì signed URL.

2. **Đường dẫn GCS**:
   - Upload: `{job_id}/upload/{filename}`
   - Processed: `{job_id}/processed/{mode}/{subfolder}/{filename}`

3. **GCS Config**: Được Next.js tự động thêm từ environment variables, không cần frontend gửi lên.

4. **Job ID**: Được Next.js tự động generate và thêm vào payload.

