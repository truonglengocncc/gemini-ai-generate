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
    const isRetry = body.retry === true;

    // Validate input
    if (!mode || (!groupId && !isRetry)) {
      return NextResponse.json(
        { error: "Missing required fields: mode, groupId" },
        { status: 400 }
      );
    }

    if (!folder && !isRetry) {
      return NextResponse.json(
        { error: "Missing required field: folder (GCS path)" },
        { status: 400 }
      );
    }

    // Use provided jobId or generate new one
    const jobId = providedJobId || `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // On retry: load existing job to restore fields
    let resolvedGroupId = groupId;
    let resolvedFolder = folder;
    let existingJob: any = null;
    if (isRetry) {
      existingJob = await prisma.job.findUnique({ where: { id: jobId } });
      if (!existingJob) {
        return NextResponse.json({ error: "Job not found for retry" }, { status: 404 });
      }
      resolvedGroupId = existingJob.groupId;
      const cfg = (existingJob.config || {}) as any;
      resolvedFolder =
        folder ||
        cfg.folder ||
        cfg.upload_folder ||
        cfg.folder_path ||
        cfg.folderPath;
      if (!resolvedFolder) {
        return NextResponse.json({ error: "Missing folder for retry" }, { status: 400 });
      }
    }

    // List image URLs from folder for database storage
    let imageUrls: string[] = [];
    const gcsConfig = getGcsConfig();
    if (gcsConfig && (resolvedFolder || folder)) {
      try {
        const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}");
        const storage = new Storage({ credentials });
        const bucket = storage.bucket(gcsConfig.bucket_name);
        const pathPrefix = (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, "");
        const resolved = resolvedFolder || folder;
        const prefix = `${pathPrefix}/${resolved}${resolved.endsWith("/") ? "" : "/"}`;
        // const useCdn = false; // public GCS

        const [files] = await bucket.getFiles({ prefix });
        imageUrls = files
          .filter(file => !file.name.endsWith("/"))
          .map(file => `https://storage.googleapis.com/${gcsConfig.bucket_name}/${file.name}`);
      } catch (error) {
        console.error("Failed to list files from folder:", error);
        // Continue without URLs, will be empty array
      }
    }

    // Include model in config if provided
    const configWithModel = model 
      ? { ...config, model, folder: resolvedFolder || folder }
      : { ...config, ...(resolvedFolder || folder ? { folder: resolvedFolder || folder } : {}) };

    if (isRetry) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "processing",
          error: null,
          updatedAt: new Date(),
          config: {
            ...(existingJob?.config || {}),
            ...(configWithModel || {}),
          },
        },
      });
    } else {
      // Create job record in database
      await prisma.job.create({
        data: {
          id: jobId,
          groupId: resolvedGroupId,
          mode,
          status: "queued",
          images: imageUrls, // Store URLs for UI display
          prompts: prompts ? (Array.isArray(prompts) ? prompts : [prompts]) : undefined,
          config: {
            ...(configWithModel || {}),
            ...(resolvedFolder ? { folder: resolvedFolder } : {}),
          },
        },
      });
    }

    // Normalize folder for worker (include path prefix)
    const pathPrefix = (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, "");
    const useFolder = resolvedFolder || folder;
    const folderForWorker = useFolder.startsWith(pathPrefix)
      ? useFolder
      : `${pathPrefix}/${useFolder.replace(/^\/+/, "")}`;

    // Submit to RunPod Serverless (async)
    // Note: Automatic mode with batch API is handled in /api/jobs/submit-batch (Next.js)
    // This route is for semi-automatic mode and regular automatic mode (via RunPod)
    // GCS config will be automatically added from env in submitToRunPod
    submitToRunPod(jobId, {
      mode,
      folder: folderForWorker, // GCS folder path (worker will list all files from this folder)
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

  if (!gcsServiceAccountKey || !gcsBucketName) {
    return null; // GCS not configured
  }

  try {
    const credentials = JSON.parse(gcsServiceAccountKey);
    const config: any = {
      credentials,
      bucket_name: gcsBucketName,
      path_prefix: (gcsPathPrefix || "gemini-generate").replace(/\/+$/, ""),
    };

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
  console.log("Payload prepared (details omitted for privacy).");
  console.log("=".repeat(80));

  try {
    const result = await postRunpodWithRetry(runpodEndpoint, requestBody, jobId);
    console.log(`[${new Date().toISOString()}] RunPod response received for job ${jobId}:`, {
      runpodJobId: result.id,
      hasOutput: !!result.output,
      status: result.status || "unknown",
    });
    // Webhook will update DB later
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Error submitting to RunPod for job ${jobId}:`, error);
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: error?.message || "submitToRunPod failed",
      },
    });
    throw error;
  }
}

async function postRunpodWithRetry(endpoint: string, body: any, jobId: string, attempts = 3) {
  let lastError: any = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`RunPod API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      const backoffMs = attempt * 1500;
      console.warn(`RunPod fetch failed for job ${jobId} (attempt ${attempt}/${attempts - 1}). Retrying in ${backoffMs}ms...`, error);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}
