import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Storage } from "@google-cloud/storage";
import { Buffer } from "buffer";

function getGcsConfig() {
  const key = process.env.GCS_SERVICE_ACCOUNT_KEY;
  const bucket = process.env.GCS_BUCKET_NAME;
  const prefix = process.env.GCS_PATH_PREFIX || "gemini-generate";
  if (!key || !bucket) return null;
  try {
    const credentials = JSON.parse(key);
    return {
      credentials,
      bucket_name: bucket,
      path_prefix: prefix.replace(/\/+$/, ""),
      cdn_url: process.env.GCS_CDN_URL,
    };
  } catch {
    return null;
  }
}

function buildFolderFromConfig(jobId: string) {
  const prefix = (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, "");
  return `${prefix}/${jobId}/resources/text-image`;
}

export async function POST(request: NextRequest) {
  let jobId: string | null = null;
  try {
    const body = await request.json();
    const {
      groupId,
      jobId: providedJobId,
      prompts,
      prompt_template,
      config = {},
      model = "gemini-3-pro-image-preview",
    } = body;

    if (!groupId) {
      return NextResponse.json({ error: "Missing groupId" }, { status: 400 });
    }

    let promptList: string[] = [];
    if (Array.isArray(prompts)) {
      promptList = prompts.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
    }
    if (promptList.length === 0 && typeof prompt_template === "string" && prompt_template.trim()) {
      promptList = expandPromptTemplate(prompt_template);
    }
    if (promptList.length === 0) {
      return NextResponse.json({ error: "No prompts provided" }, { status: 400 });
    }

    const gcsConfig = getGcsConfig();
    if (!gcsConfig) {
      return NextResponse.json({ error: "GCS not configured" }, { status: 500 });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    jobId = providedJobId || `job_txt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!jobId) {
      throw new Error("Failed to allocate job id");
    }
    const currentJobId: string = jobId;
    const jobPrompts = promptList.map((p) => p.trim());
    const useDirectGeneration = jobPrompts.length === 1;
    const normalizedConfig = normalizeConfig(config, model);

    await prisma.job.create({
      data: {
        id: currentJobId,
        groupId,
        mode: "text-image",
        status: useDirectGeneration ? "processing" : "queued",
        images: [],
        prompts: jobPrompts,
        config: {
          ...normalizedConfig,
          model,
          prompt_template,
        },
      },
    });

    const payload: any = {
      mode: "text-image",
      job_id: currentJobId,
      group_id: groupId,
      prompts: jobPrompts,
      prompt_template,
      config: normalizedConfig,
      gemini_api_key: apiKey,
      gcs_config: gcsConfig,
    };

    // include resource folder path for worker logging if needed
    payload.resource_folder = buildFolderFromConfig(currentJobId);

    const queueWorker = () =>
      submitToRunPod(currentJobId, payload).catch(async (err) => {
        console.error("[text-image] submit error", err);
        await prisma.job.update({
          where: { id: currentJobId },
          data: {
            status: "failed",
            error: err?.message || "Failed to queue worker job",
          },
        });
      });

    if (useDirectGeneration) {
      try {
        const { results, totalGenerated } = await runDirectTextToImage({
          jobId: currentJobId,
          prompts: jobPrompts,
          config: normalizedConfig,
          model,
          gcsConfig,
          apiKey,
        });
        await prisma.job.update({
          where: { id: currentJobId },
          data: {
            status: "completed",
            results: { results },
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        return NextResponse.json({ jobId: currentJobId, status: "completed", generated: totalGenerated });
      } catch (directError: any) {
        console.error("[text-image] direct call failed, falling back to worker:", directError);
        await queueWorker();
        return NextResponse.json({ jobId: currentJobId, status: "queued" });
      }
    }

    queueWorker();
    return NextResponse.json({ jobId: currentJobId, status: "queued" });
  } catch (error: any) {
    console.error("[text-image] API error", error);
    if (jobId) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: error?.message || "Text image submit failed",
        },
      }).catch(() => {});
    }
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}

function expandPromptTemplate(template: string) {
  if (!template) return [];
  const regex = /\{([^{}]+)\}/g;
  const segments: string[] = [];
  const options: string[][] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    segments.push(template.slice(lastIndex, match.index));
    const opts = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    options.push(opts.length > 0 ? opts : [""]);
    lastIndex = match.index + match[0].length;
  }
  segments.push(template.slice(lastIndex));
  if (options.length === 0) {
    return [template];
  }
  const results: string[] = [];
  const build = (idx: number, current: string) => {
    if (idx === options.length) {
      results.push(current + segments[idx]);
      return;
    }
    for (const opt of options[idx]) {
      build(idx + 1, current + segments[idx] + opt);
    }
  };
  build(0, "");
  return results;
}

function normalizeConfig(config: any, model: string) {
  const normalized = { ...(config || {}) };
  if (model === "gemini-3-pro-image-preview") {
    const allowed = new Set(["1K", "2K", "4K"]);
    const resolutionValue = (normalized.resolution || "1K").toString().toUpperCase();
    normalized.resolution = allowed.has(resolutionValue) ? resolutionValue : "1K";
  } else {
    delete normalized.resolution;
  }
  return normalized;
}

async function runDirectTextToImage(args: {
  jobId: string;
  prompts: string[];
  config: any;
  model: string;
  gcsConfig: ReturnType<typeof getGcsConfig>;
  apiKey: string;
}) {
  const { jobId, prompts, config, model, gcsConfig, apiKey } = args;
  const storage = new Storage({ credentials: gcsConfig?.credentials });
  const numVariations = Math.max(1, Number(config?.num_variations) || 1);
  const aspectRatio = config?.aspect_ratio || "1:1";
  const ratioSlug = String(aspectRatio).replace(/:/g, "x");
  const resolution = model === "gemini-3-pro-image-preview" ? config?.resolution || "1K" : undefined;
  const results: any[] = [];

  for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
    const promptText = prompts[promptIndex];
    for (let variation = 0; variation < numVariations; variation++) {
      const images = await callGeminiAPI({
        apiKey,
        model,
        prompt: promptText,
        aspectRatio,
        resolution,
      });
      for (const img of images) {
        const gcsUrl = await uploadBufferToGcs({
          storage,
          gcsConfig,
          buffer: img.buffer,
          filename: buildGcsPath({ jobId, ratioSlug, promptIndex, variation, resolution }),
          contentType: img.mimeType,
        });
        results.push({
          original_index: promptIndex,
          variation,
          ratio: aspectRatio,
          gcs_url: gcsUrl,
        });
      }
    }
  }

  return {
    results,
    totalGenerated: results.length,
  };
}

function buildGcsPath(opts: { jobId: string; ratioSlug: string; promptIndex: number; variation: number; resolution?: string }) {
  const { jobId, ratioSlug, promptIndex, variation, resolution } = opts;
  const timestamp = Date.now();
  const resolutionChunk = resolution ? `${resolution.toLowerCase()}/` : "";
  return `${jobId}/processed/text-image/${ratioSlug}/${resolutionChunk}prompt_${promptIndex}/variation_${variation}_${timestamp}.png`;
}

async function uploadBufferToGcs(args: {
  storage: Storage;
  gcsConfig: ReturnType<typeof getGcsConfig>;
  buffer: Buffer;
  filename: string;
  contentType?: string;
}) {
  const { storage, gcsConfig, buffer, filename, contentType } = args;
  const bucket = storage.bucket(gcsConfig!.bucket_name);
  let path = filename.replace(/^\/+/, "");
  if (gcsConfig?.path_prefix) {
    path = `${gcsConfig.path_prefix}/${path}`;
  }
  path = prependGeminiPrefix(path);
  const file = bucket.file(path);
  await file.save(buffer, {
    contentType: contentType || "image/png",
    resumable: false,
  });
  if (gcsConfig?.cdn_url) {
    const cdn = gcsConfig.cdn_url.replace(/\/+$/, "");
    return `${cdn}/${path}`;
  }
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
}

function prependGeminiPrefix(path: string) {
  const parts = path.split("/");
  if (parts.length === 0) return path;
  const file = parts.pop()!;
  const safeFile = file.startsWith("gemini-") || file.startsWith("gemini_") ? file : `gemini-${file}`;
  return [...parts, safeFile].filter(Boolean).join("/");
}

async function callGeminiAPI(args: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
}) {
  const { apiKey, model, prompt, aspectRatio, resolution } = args;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload: any = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
    },
  };
  if (aspectRatio || (resolution && model === "gemini-3-pro-image-preview")) {
    payload.generationConfig.imageConfig = {};
    if (aspectRatio) {
      payload.generationConfig.imageConfig.aspectRatio = aspectRatio;
    }
    if (model === "gemini-3-pro-image-preview" && resolution) {
      payload.generationConfig.imageConfig.imageSize = resolution;
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Gemini error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const images: Array<{ buffer: Buffer; mimeType: string }> = [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      images.push({
        buffer: Buffer.from(part.inlineData.data, "base64"),
        mimeType: part.inlineData.mimeType || "image/png",
      });
    }
  }
  if (images.length === 0) {
    throw new Error("Gemini returned no image data");
  }
  return images;
}

async function submitToRunPod(jobId: string, payload: any) {
  const runpodEndpoint = process.env.RUNPOD_ENDPOINT;
  if (!runpodEndpoint) {
    throw new Error("RUNPOD_ENDPOINT not configured");
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "processing" },
  });

  if (!payload.gcs_config) {
    const cfg = getGcsConfig();
    if (cfg) {
      (cfg as any).job_id = jobId;
      payload.gcs_config = cfg;
    }
  }

  payload.job_id = jobId;
  if (!payload.gemini_api_key && process.env.GEMINI_API_KEY) {
    payload.gemini_api_key = process.env.GEMINI_API_KEY;
  }

  const webhookUrl = process.env.WEBHOOK_URL || process.env.NEXT_PUBLIC_WEBHOOK_URL;
  const body = { input: payload, ...(webhookUrl ? { webhook: webhookUrl } : {}) };

  console.log("[worker payload] submit-text-image", JSON.stringify(body));

  const response = await fetch(runpodEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RunPod API error: ${response.status} ${errorText}`);
  }
}
