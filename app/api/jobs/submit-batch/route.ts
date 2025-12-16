import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Storage } from "@google-cloud/storage";

/**
 * Enqueue batch job to RunPod worker (worker will call Gemini Batch API)
 * Only for Automatic mode with batch API
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      groupId,
      jobId: providedJobId,
      folder, // GCS folder path (e.g., "job_123/upload")
      prompts,
      prompt_template, // optional template string with {a,b}
      config = {},
      model, // Model name (e.g., "gemini-2.5-flash-image")
      file_uris, // (optional) legacy, kept for compatibility
      inline_data, // optional inlineData (base64)
      gcs_files, // optional GCS files uploaded via presign
      image_urls, // optional public image URLs (if already uploaded)
    } = body;

    // Validate input (skip heavy checks on retry)
    const isRetry = body.retry === true;
    if (!groupId) {
      return NextResponse.json(
        { error: "Missing required field: groupId" },
        { status: 400 }
      );
    }

    if (!folder && !isRetry) {
      return NextResponse.json(
        { error: "Missing required field: folder (GCS path)" },
        { status: 400 }
      );
    }

    if (!isRetry && (!inline_data || inline_data.length === 0) && (!gcs_files || gcs_files.length === 0)) {
      return NextResponse.json(
        { error: "Missing inline_data or gcs_files. Upload must include images." },
        { status: 400 }
      );
    }

    // Use provided jobId or generate new one
    const jobId = providedJobId || `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // List image URLs from folder for database storage
    let imageUrls: string[] = [];
    const gcsConfig = getGcsConfig();
    if (gcsConfig && folder) {
      try {
        const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}");
        const storage = new Storage({ credentials });
        const bucket = storage.bucket(gcsConfig.bucket_name);
        const fullPrefix = gcsConfig.path_prefix
          ? `${gcsConfig.path_prefix.replace(/\/+$/, "")}/${folder}`
          : folder;
        const prefix = fullPrefix.endsWith("/") ? fullPrefix : `${fullPrefix}/`;
        
        const [files] = await bucket.getFiles({ prefix });
        // Use public GCS URLs (CDN currently disabled)
        imageUrls = files
          .filter(file => !file.name.endsWith("/"))
          .map(file => `https://storage.googleapis.com/${gcsConfig.bucket_name}/${file.name}`);
      } catch (error) {
        console.error("Failed to list files from folder:", error);
      }
    }

    // Include model & prompt metadata in config if provided
    const configWithModel = {
      ...config,
      ...(model ? { model } : {}),
      ...(prompt_template ? { prompt_template } : {}),
    };

    if (isRetry) {
      // For retry, update existing job to queued and clear errors
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "queued",
          error: null,
          updatedAt: new Date(),
        },
      });
    } else {
      // Create job record in database
      await prisma.job.create({
        data: {
          id: jobId,
          groupId,
          mode: "automatic",
          status: "queued", // worker will update to batch_submitted via webhook
          images: imageUrls,
          prompts: prompts || [],
          config: configWithModel || undefined,
        },
      });
    }

    // Send payload to RunPod worker for batch submit
    await submitToRunPodBatch(jobId, {
      mode: "automatic_batch",
      groupId,
      jobId,
      folder,
      prompts,
      prompt_template,
      config: configWithModel,
      model: model || configWithModel.model || "gemini-2.5-flash-image",
      gcs_files: gcs_files || [],
      image_urls: image_urls || [],
      inline_data: inline_data || [],
      file_uris: file_uris || [],
    });

    return NextResponse.json({
      jobId,
      status: "queued",
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

/**
 * Get GCS config from environment variables
 */
function getGcsConfig(): any | null {
  const gcsServiceAccountKey = process.env.GCS_SERVICE_ACCOUNT_KEY;
  const gcsBucketName = process.env.GCS_BUCKET_NAME;
  const gcsPathPrefix = process.env.GCS_PATH_PREFIX || "gemini-generate";

  if (!gcsServiceAccountKey || !gcsBucketName) {
    return null;
  }

  try {
    const credentials = JSON.parse(gcsServiceAccountKey);
    const config: any = {
      credentials,
      bucket_name: gcsBucketName,
      path_prefix: gcsPathPrefix.replace(/\/+$/, ""),
    };
    
    return config;
  } catch {
    return null;
  }
}

async function submitToRunPodBatch(jobId: string, payload: any) {
  const runpodEndpoint = process.env.RUNPOD_ENDPOINT;
  if (!runpodEndpoint) {
    throw new Error("RUNPOD_ENDPOINT not configured");
  }

  // Update job status to processing (worker will set batch_submitted via webhook)
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "processing" },
  });

  // Auto add gcs_config from env
  const gcsConfig = getGcsConfig();
  if (gcsConfig) {
    gcsConfig.job_id = jobId;
    payload.gcs_config = gcsConfig;
  }

  payload.job_id = jobId;

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey) {
    payload.gemini_api_key = geminiApiKey;
  }

  const webhookUrl = process.env.WEBHOOK_URL || process.env.NEXT_PUBLIC_WEBHOOK_URL;
  const requestBody: any = { input: payload };
  if (webhookUrl) requestBody.webhook = webhookUrl;

  // Debug log payload size & summary (no secrets)
  // Removed verbose payload logging (dev-only)

  const response = await fetch(runpodEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "failed", error: errorText },
    });
    throw new Error(`RunPod API error: ${response.statusText} - ${errorText}`);
  }
}
