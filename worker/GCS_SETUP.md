# GCS Configuration Guide

## Overview

The worker supports uploading generated images to Google Cloud Storage (GCS). GCS credentials and configuration are passed from the backend via the `gcs_config` field in the job input.

## GCS Config Format

The `gcs_config` object should be included in the job submission payload:

```json
{
  "mode": "automatic",
  "images": ["https://example.com/image1.jpg"],
  "prompts": ["prompt text"],
  "config": {...},
  "gcs_config": {
    "credentials": {
      "type": "service_account",
      "project_id": "your-project-id",
      "private_key_id": "...",
      "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
      "client_email": "service-account@project.iam.gserviceaccount.com",
      "client_id": "...",
      "auth_uri": "https://accounts.google.com/o/oauth2/auth",
      "token_uri": "https://oauth2.googleapis.com/token",
      "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
      "client_x509_cert_url": "..."
    },
    "bucket_name": "your-bucket-name",
    "path_prefix": "generated-images/"  // Optional
  }
}
```

## Credentials Format

The `credentials` field can be provided in two formats:

1. **JSON Object** (recommended):
```json
{
  "credentials": {
    "type": "service_account",
    "project_id": "...",
    ...
  }
}
```

2. **JSON String**:
```json
{
  "credentials": "{\"type\":\"service_account\",\"project_id\":\"...\",...}"
}
```

## Path Structure

Images are uploaded with the following path structure:

- **Automatic Mode**: `{path_prefix}automatic/{image_index}/variation_{variation}.jpg`
- **Semi-Automatic Mode**: `{path_prefix}semi-auto/{image_index}/prompt_{prompt_index}/gen_{generation_index}.jpg`

If `path_prefix` is not provided, images are uploaded to the root of the bucket.

## Response Format

When GCS is configured, the response will contain `gcs_url` instead of base64 `image`:

```json
{
  "status": "completed",
  "results": [
    {
      "original_index": 0,
      "variation": 0,
      "gcs_url": "https://storage.googleapis.com/bucket/path/to/image.jpg?..."
    }
  ],
  "total_generated": 1
}
```

## Signed URLs

The worker generates signed URLs valid for 1 year. These URLs work even if the bucket is not publicly accessible.

## Fallback Behavior

If `gcs_config` is not provided or GCS upload fails, the worker falls back to returning base64-encoded images in the response.

## Security Notes

- **Never expose service account credentials in client-side code**
- Credentials should be stored securely on the backend
- Use environment variables or secure secret management
- Consider using short-lived credentials or signed URLs for better security

## Example Backend Implementation

```typescript
// In your Next.js API route
const gcsConfig = {
  credentials: JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}"),
  bucket_name: process.env.GCS_BUCKET_NAME,
  path_prefix: `groups/${groupId}/`,
};

await submitToRunPod(jobId, {
  mode,
  images,
  prompts,
  config,
  gcs_config: gcsConfig,
});
```


