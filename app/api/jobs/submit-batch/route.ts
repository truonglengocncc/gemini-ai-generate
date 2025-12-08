import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Storage } from "@google-cloud/storage";
import { GoogleGenAI } from "@google/genai";

/**
 * Submit batch job directly to Gemini Batch API (Next.js, not RunPod)
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
      file_uris, // (optional) legacy
      inline_data, // optional inlineData
      gcs_files, // optional GCS files uploaded via presign
    } = body;

    // Validate input
    if (!groupId) {
      return NextResponse.json(
        { error: "Missing required field: groupId" },
        { status: 400 }
      );
    }

    if (!folder) {
      return NextResponse.json(
        { error: "Missing required field: folder (GCS path)" },
        { status: 400 }
      );
    }

    if ((!inline_data || inline_data.length === 0) && (!gcs_files || gcs_files.length === 0)) {
      return NextResponse.json(
        { error: "Missing inline_data or gcs_files. Upload must include images." },
        { status: 400 }
      );
    }

    // Expand prompt variables (cartesian product of comma-separated lists inside {})
    const promptTemplate =
      prompt_template ||
      (Array.isArray(prompts) ? prompts[0] : prompts) ||
      "";
    const expandedPrompts = expandPromptTemplate(promptTemplate);
    if (!expandedPrompts.length) {
      return NextResponse.json(
        { error: "Prompt is required" },
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

    // Get prompt
    // Include model & prompt metadata in config if provided
    const configWithModel = {
      ...config,
      ...(model ? { model } : {}),
      ...(promptTemplate ? { prompt_template: promptTemplate } : {}),
      prompt_combinations: expandedPrompts.length,
    };

    // Create job record in database
    const job = await prisma.job.create({
      data: {
        id: jobId,
        groupId,
        mode: "automatic",
        status: "batch_submitted", // Will be updated when batch completes
        images: imageUrls,
        prompts: expandedPrompts,
        config: configWithModel || undefined,
      },
    });

    // Submit batch job directly to Gemini Batch API
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "failed", error: truncateError("GEMINI_API_KEY not configured") },
      });
      return NextResponse.json(
        { error: "GEMINI_API_KEY not configured" },
        { status: 500 }
      );
    }

    try {
      const batchJobName = await createBatchJob(
        apiKey,
        gcs_files || [],
        expandedPrompts,
        model || configWithModel.model || "gemini-2.5-flash-image",
        configWithModel,
        jobId,
        inline_data
      );

      const filesCount =
        (gcs_files && Array.isArray(gcs_files) ? gcs_files.length : 0) ||
        (inline_data && Array.isArray(inline_data) ? inline_data.length : 0);

      console.log(
        `[Submit Batch] Created batch job ${batchJobName} ` +
        `(files=${filesCount}, variations=${configWithModel.num_variations || 1}, model=${model})`
      );

      // Persist batchJobName inside config JSON to avoid schema mismatch on some envs
      await prisma.job.update({
        where: { id: jobId },
        data: { 
          config: {
            ...((configWithModel as any) || {}),
            batchJobName,
          } as any,
        },
      });

      return NextResponse.json({
        jobId,
        status: "batch_submitted",
        batchJobName,
      });
    } catch (error: any) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: truncateError(error?.message || String(error)),
        },
      });
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

/**
 * Create batch job in Gemini Batch API
 */
async function createBatchJob(
  apiKey: string,
  gcsFiles: Array<{ index: number; gcsPath: string; contentType?: string; publicUrl?: string }>,
  prompts: string[],
  model: string,
  config: any,
  jobId: string,
  inlineData?: Array<{ index: number; inlineData: { mimeType: string; data: string } }>
): Promise<string> {
  const numVariations = config.num_variations || 1;
  const resolution = config.resolution;
  const aspectRatios: string[] = Array.isArray(config.aspect_ratios) && config.aspect_ratios.length
    ? config.aspect_ratios
    : [config.aspect_ratio || "1:1"];

  // Prefer inlineData passed from upload; if absent, download from GCS
  let inlineImages = (inlineData || []).sort((a, b) => a.index - b.index);
  if (!inlineImages.length) {
    const gcsConfig = getGcsConfig();
    if (!gcsConfig) {
      throw new Error("GCS not configured and inline_data not provided");
    }
    const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}");
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(gcsConfig.bucket_name);

    inlineImages = await Promise.all(
      gcsFiles.sort((a, b) => a.index - b.index).map(async (file) => {
        const hasPrefix = file.gcsPath.startsWith(gcsConfig.path_prefix);
        const gcsPath = hasPrefix
          ? file.gcsPath
          : `${gcsConfig.path_prefix}/${file.gcsPath.replace(/^\/+/, "")}`;
        const [buffer] = await bucket.file(gcsPath).download();
        const mimeType = file.contentType || "image/jpeg";
        return {
          index: file.index,
          inlineData: {
            mimeType,
            data: buffer.toString("base64"),
          },
        };
      })
    );
  }

  // Create JSONL batch requests with inlineData
  const batchRequests: any[] = [];
  prompts.forEach((prompt, promptIdx) => {
    for (const img of inlineImages) {
      for (const ratio of aspectRatios) {
        const ratioSlug = ratio.replace(/:/g, "x");
        for (let variation = 0; variation < numVariations; variation++) {
          const requestObj: any = {
            contents: [{
              parts: [
                { inlineData: img.inlineData },
                { text: prompt }
              ],
              role: "user"
            }],
            generationConfig: {
              responseModalities: ["IMAGE"]
            }
          };

          if (model === "gemini-3-pro-image-preview") {
            requestObj.generationConfig.imageConfig = {
              aspectRatio: ratio,
              imageSize: (resolution || "1K").toUpperCase()
            };
          }

          batchRequests.push({
            key: `r${ratioSlug}_p${promptIdx}_image_${img.index}_variation_${variation}`,
            request: requestObj
          });
        }
      }
    }
  });

  const jsonlContent = batchRequests.map(req => JSON.stringify(req)).join("\n");
  const jsonlBuffer = Buffer.from(jsonlContent, "utf-8");
  console.log(
    `[Submit Batch] JSONL requests ready (requests=${batchRequests.length}, size=${jsonlBuffer.length} bytes)`
  );

  const ai = new GoogleGenAI({ apiKey });
  const jsonlBlob = new Blob([jsonlBuffer], { type: "application/jsonl" });
  const uploadedJsonlFile = await ai.files.upload({
    file: jsonlBlob,
    config: {
      mimeType: "application/jsonl",
      displayName: `batch_requests_${jobId}`,
    },
  });

  let jsonlFileUri = (uploadedJsonlFile as any).uri || (uploadedJsonlFile as any).name;
  if (!jsonlFileUri) {
    throw new Error("No file URI returned from JSONL upload");
  }
  jsonlFileUri = normalizeFileUri(jsonlFileUri);

  const batchJob = await ai.batches.create({
    model: model,
    src: jsonlFileUri,
    config: {
      displayName: `batch-job-${jobId}`,
    },
  });
  console.log(`[Submit Batch] Batch API response`, JSON.stringify(batchJob).slice(0, 500));

  const batchJobName = (batchJob as any).name || (batchJob as any).batch?.name;
  if (!batchJobName) {
    throw new Error("No batch job name returned");
  }

  return batchJobName;
}

function normalizeFileUri(fileUri: string): string {
  if (fileUri.startsWith("http")) {
    const match = fileUri.match(/\/files\/([^\/\?]+)/);
    if (match) return `files/${match[1]}`;
  }
  if (!fileUri.startsWith("files/")) {
    return `files/${fileUri}`;
  }
  return fileUri;
}

function truncateError(msg: string, max: number = 180) {
  if (!msg) return "";
  return msg.length > max ? `${msg.slice(0, max - 3)}...` : msg;
}

function expandPromptTemplate(template: string): string[] {
  if (!template) return [];
  const regex = /\{([^{}]+)\}/g;
  const segments: string[] = [];
  const variables: string[][] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    segments.push(template.slice(lastIndex, match.index));
    const options = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    variables.push(options.length ? options : [""]);
    lastIndex = regex.lastIndex;
  }
  segments.push(template.slice(lastIndex));

  if (!variables.length) return [template];

  const results: string[] = [];
  const build = (idx: number, current: string) => {
    if (idx === variables.length) {
      results.push(current + segments[idx]);
      return;
    }
    for (const opt of variables[idx]) {
      build(idx + 1, current + segments[idx] + opt);
    }
  };
  build(0, "");
  return results;
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
