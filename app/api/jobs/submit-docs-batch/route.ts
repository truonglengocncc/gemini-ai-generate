import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Storage } from "@google-cloud/storage";

/**
 * Docs Automatic Mode: prompt/config from docs, images from GCS folder.
 * Results saved to .../gemini/ (same level as input folder, e.g. midjourney -> gemini).
 */
function parseDocsContent(text: string): {
  prompt: string;
  numImages: number;
  imageRatio: string;
  variationsPerImage: number;
  resolution: string;
} | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let prompt = "";
  let numImages = 1;
  let imageRatio = "1:1";
  let variationsPerImage = 1;
  let resolution = "1K";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (/^Prompt$/i.test(key)) prompt = value;
    else if (/^Number of Images$/i.test(key)) numImages = Math.max(1, parseInt(value, 10) || 1);
    else if (/^Image Ratio$/i.test(key)) imageRatio = value || "1:1";
    else if (/^Variations per Image$/i.test(key)) variationsPerImage = Math.max(1, parseInt(value, 10) || 1);
    else if (/^Resolution$/i.test(key)) resolution = value || "1K";
  }
  return prompt ? { prompt, numImages, imageRatio, variationsPerImage, resolution } : null;
}

function getGcsConfig(): { credentials: unknown; bucket_name: string; path_prefix: string } | null {
  const gcsServiceAccountKey = process.env.GCS_SERVICE_ACCOUNT_KEY;
  const gcsBucketName = process.env.GCS_BUCKET_NAME;
  const gcsPathPrefix = (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, "");
  if (!gcsServiceAccountKey || !gcsBucketName) return null;
  try {
    const credentials = JSON.parse(gcsServiceAccountKey);
    return { credentials, bucket_name: gcsBucketName, path_prefix: gcsPathPrefix };
  } catch {
    return null;
  }
}

function parseGsUrl(inputPath: string): { bucket: string; path: string } | null {
  const s = (inputPath || "").trim();
  if (!s.startsWith("gs://")) return null;
  const without = s.slice(5).replace(/\/+$/, "");
  const firstSlash = without.indexOf("/");
  if (firstSlash <= 0) return null;
  const bucket = without.slice(0, firstSlash);
  const path = without.slice(firstSlash + 1);
  return bucket && path ? { bucket, path } : null;
}

function outputPrefixFromInputPath(inputPath: string): string {
  const parts = inputPath.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return "gemini";
  parts[parts.length - 1] = "gemini";
  return parts.join("/");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { groupId, docsContent, gcsInputPath, parsed: parsedFromClient, model } = body;

    const parsed = parsedFromClient || (docsContent ? parseDocsContent(docsContent) : null);
    if (!parsed) {
      return NextResponse.json(
        { error: "Missing or invalid docs: provide docsContent or parsed (prompt, numImages, imageRatio, variationsPerImage, resolution)" },
        { status: 400 }
      );
    }

    const inputPath = (gcsInputPath || "").trim();
    if (!inputPath) {
      return NextResponse.json(
        { error: "Missing gcsInputPath (e.g. gs://capsure/gemini-generate/test_docs_generate/midjourney)" },
        { status: 400 }
      );
    }

    if (!groupId) {
      return NextResponse.json({ error: "Missing groupId" }, { status: 400 });
    }

    const gcsConfig = getGcsConfig();
    if (!gcsConfig) {
      return NextResponse.json({ error: "GCS not configured" }, { status: 500 });
    }

    let bucketName: string;
    let fullPrefix: string;

    const gs = parseGsUrl(inputPath);
    if (gs) {
      bucketName = gs.bucket;
      fullPrefix = gs.path;
    } else {
      bucketName = gcsConfig.bucket_name;
      fullPrefix = gcsConfig.path_prefix && !inputPath.startsWith(gcsConfig.path_prefix)
        ? `${gcsConfig.path_prefix}/${inputPath.replace(/^\/+/, "")}`
        : inputPath.replace(/^\/+/, "");
    }

    const prefix = fullPrefix.endsWith("/") ? fullPrefix : `${fullPrefix}/`;
    const storage = new Storage({ credentials: gcsConfig.credentials as object });
    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix });

    const imageExtensions = [".jpg", ".jpeg", ".png", ".webp"];
    const blobList = files.filter(
      (f) => !f.name.endsWith("/") && imageExtensions.some((ext) => f.name.toLowerCase().endsWith(ext))
    );

    if (blobList.length === 0) {
      return NextResponse.json(
        { error: `No images found in GCS at ${prefix}. Add .jpg/.jpeg/.png/.webp files.` },
        { status: 400 }
      );
    }

    const jobId = `job_docs_auto_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const imageUrls = blobList.map((f) => `https://storage.googleapis.com/${bucketName}/${f.name}`);

    // Output to .../gemini/ (same level as input folder)
    const output_gcs_prefix = outputPrefixFromInputPath(fullPrefix);

    const runpodEndpoint = process.env.RUNPOD_ENDPOINT;
    if (!runpodEndpoint) {
      return NextResponse.json({ error: "RUNPOD_ENDPOINT not configured" }, { status: 500 });
    }

    const config = {
      output_gcs_prefix,
      folder: fullPrefix,
      model: model || "gemini-3-pro-image-preview",
      num_variations: parsed.variationsPerImage,
      aspect_ratio: parsed.imageRatio,
      aspect_ratios: [parsed.imageRatio],
      resolution: parsed.resolution,
    };

    const prompts = Array.isArray(parsed.prompts) && parsed.prompts.length > 0 ? parsed.prompts : [parsed.prompt];

    await prisma.job.create({
      data: {
        id: jobId,
        groupId,
        mode: "docs_automatic",
        status: "queued",
        images: imageUrls,
        prompts,
        config,
      },
    });

    const pathPrefix = gcsConfig.path_prefix || "gemini-generate";
    const folderForWorker = fullPrefix.startsWith(pathPrefix) ? fullPrefix : `${pathPrefix}/${fullPrefix.replace(/^\/+/, "")}`;

    const payload = {
      mode: "docs_automatic",
      groupId,
      jobId,
      folder: folderForWorker,
      prompts,
      prompt_template: parsed.prompt,
      config,
      model: model || config.model,
      gcs_config: {
        ...gcsConfig,
        job_id: jobId,
        bucket_name: bucketName,
      },
      job_id: jobId,
      gemini_api_key: process.env.GEMINI_API_KEY,
    };

    const webhookUrl = process.env.WEBHOOK_URL || process.env.NEXT_PUBLIC_WEBHOOK_URL;
    const requestBody: { input: typeof payload; webhook?: string } = { input: payload };
    if (webhookUrl) requestBody.webhook = webhookUrl;

    console.log("[worker payload] submit-docs-batch", JSON.stringify(requestBody));

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
      return NextResponse.json({ error: `RunPod error: ${errorText}` }, { status: 502 });
    }

    await prisma.job.update({
      where: { id: jobId },
      data: { status: "processing" },
    });

    return NextResponse.json({ jobId, status: "queued" });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("submit-docs-batch error:", error);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
