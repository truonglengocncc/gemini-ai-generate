import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Storage } from "@google-cloud/storage";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      mode,
      groupId,
      jobId: providedJobId,
      folder, // GCS folder path (e.g., "job_123/upload")
      prompts,
      config = {},
      model, // Model name (e.g., "gemini-2.5-flash-image")
      gcs_config,
    } = body;

    // Validate input
    if (!mode || !groupId) {
      return NextResponse.json(
        { error: "Missing required fields: mode, groupId" },
        { status: 400 }
      );
    }

    if (!folder) {
      return NextResponse.json(
        { error: "Missing required field: folder (GCS path)" },
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
        const prefix = folder.endsWith("/") ? folder : `${folder}/`;
        
        const [files] = await bucket.getFiles({ prefix });
        const cdnUrl = process.env.CDN_ASSETS_URL_CAPSURE;
        
        imageUrls = files
          .filter(file => !file.name.endsWith("/"))
          .map(file => {
            if (cdnUrl) {
              return `${cdnUrl.replace(/\/$/, "")}/${file.name}`;
            }
            return `https://storage.googleapis.com/${gcsConfig.bucket_name}/${file.name}`;
          });
      } catch (error) {
        console.error("Failed to list files from folder:", error);
        // Continue without URLs, will be empty array
      }
    }

    // Include model in config if provided
    const configWithModel = model 
      ? { ...config, model }
      : config;

    // Create job record in database
    const job = await prisma.job.create({
      data: {
        id: jobId,
        groupId,
        mode,
        status: "queued",
        images: imageUrls, // Store URLs for UI display
        prompts: prompts ? (Array.isArray(prompts) ? prompts : [prompts]) : undefined,
        config: configWithModel || undefined,
      },
    });

    // Submit to RunPod Serverless (async)
    // Note: Automatic mode with batch API is handled in /api/jobs/submit-batch (Next.js)
    // This route is for semi-automatic mode and regular automatic mode (via RunPod)
    // GCS config will be automatically added from env in submitToRunPod
    submitToRunPod(jobId, {
      mode,
      folder, // GCS folder path (worker will list all files from this folder)
      prompts,
      config: configWithModel,
      // Only include gcs_config if explicitly provided (not recommended)
      ...(gcs_config && { gcs_config }),
    }).catch(async (error) => {
      // Update job status in database on error
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: truncateError(error?.message || String(error)),
        },
      });
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
 * This is secure as it's only accessible server-side
 */
function getGcsConfig(): any | null {
  const gcsServiceAccountKey = process.env.GCS_SERVICE_ACCOUNT_KEY;
  const gcsBucketName = process.env.GCS_BUCKET_NAME;
  const gcsPathPrefix = process.env.GCS_PATH_PREFIX || "";
  const cdnUrl = process.env.CDN_ASSETS_URL_CAPSURE;

  if (!gcsServiceAccountKey || !gcsBucketName) {
    return null; // GCS not configured
  }

  try {
    const credentials = JSON.parse(gcsServiceAccountKey);
    const config: any = {
      credentials,
      bucket_name: gcsBucketName,
      path_prefix: gcsPathPrefix,
    };
    
    // Add CDN URL if configured
    if (cdnUrl) {
      config.cdn_url = cdnUrl;
    }
    
    return config;
  } catch {
    return null;
  }
}

function truncateError(msg: string, max: number = 180) {
  if (!msg) return "";
  return msg.length > max ? `${msg.slice(0, max - 3)}...` : msg;
}

async function submitToRunPod(jobId: string, payload: any) {
  const runpodEndpoint = process.env.RUNPOD_ENDPOINT;
  if (!runpodEndpoint) {
    throw new Error("RUNPOD_ENDPOINT not configured");
  }

  // Update job status to processing in database
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "processing" },
  });

  // Automatically add GCS config from env if not provided and available
  // This ensures credentials stay server-side and are never exposed to frontend
  if (!payload.gcs_config) {
    const gcsConfig = getGcsConfig();
    if (gcsConfig) {
      // Add jobId to path prefix for organized storage
      gcsConfig.job_id = jobId;
      payload.gcs_config = gcsConfig;
    }
  }
  
  // Also pass jobId in payload for worker to use in paths
  payload.job_id = jobId;
  
  // Add GEMINI_API_KEY to payload (from environment variable)
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey) {
    payload.gemini_api_key = geminiApiKey;
  } else {
    console.warn("GEMINI_API_KEY not found in environment variables");
  }

  // Construct webhook URL (use ngrok URL from env or default)
  const webhookUrl = process.env.WEBHOOK_URL || process.env.NEXT_PUBLIC_WEBHOOK_URL;
  
  // Log full payload for debugging
  const requestBody: any = {
    input: payload,
  };
  
  // Add webhook URL if available
  if (webhookUrl) {
    requestBody.webhook = webhookUrl;
    console.log(`[${new Date().toISOString()}] Webhook URL configured: ${webhookUrl}`);
  } else {
    console.warn(`[${new Date().toISOString()}] No webhook URL configured. Job status will need manual polling.`);
  }
  
  console.log("=".repeat(80));
  console.log(`[${new Date().toISOString()}] Sending payload to RunPod worker for job: ${jobId}`);
  console.log("Full payload:", JSON.stringify(requestBody, null, 2));
  console.log("Payload size:", JSON.stringify(requestBody).length, "bytes");
  console.log("=".repeat(80));

  try {
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
      console.error(`[${new Date().toISOString()}] RunPod API error for job ${jobId}:`, {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      throw new Error(`RunPod API error: ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`[${new Date().toISOString()}] RunPod response received for job ${jobId}:`, {
      runpodJobId: result.id,
      hasOutput: !!result.output,
      status: result.status || "unknown",
    });

    // Note: Job results will be updated by webhook using job_id from input
    // We don't need to save RunPod's ID since webhook will use our job_id
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Error submitting to RunPod for job ${jobId}:`, error);
    // Update job status in database on error
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: error.message,
      },
    });
    throw error;
  }
}
