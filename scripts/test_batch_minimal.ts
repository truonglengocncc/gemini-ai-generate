#!/usr/bin/env ts-node
/**
 * Quick sanity-checker for Gemini Batch API (image).
 *
 * Usage examples:
 *   # 1) Dùng fileUri có sẵn (nhiều cái, cách nhau bởi dấu phẩy)
 *   npx ts-node scripts/test_batch_minimal.ts --model gemini-2.5-flash-image --file-uris files/a,files/b
 *
 *   # 2) Upload nhiều ảnh từ danh sách hoặc thư mục
 *   npx ts-node scripts/test_batch_minimal.ts --model gemini-2.5-flash-image --images "a.jpg,b.png"
 *   npx ts-node scripts/test_batch_minimal.ts --model gemini-2.5-flash-image --images ./samples_dir
 *
 *   # 3) Thêm variations mỗi ảnh
 *   npx ts-node scripts/test_batch_minimal.ts --model gemini-2.5-flash-image --images ./samples_dir --num-variations 3
 *
 * Env fallbacks:
 *   GEMINI_API_KEY (required)
 *   MODEL, FILE_URI, IMAGE_PATH, PROMPT, ASPECT_RATIO, RESOLUTION, MAX_POLLS
 */

import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

type CliConfig = {
  apiKey: string;
  model: string;
  fileUris: string[];
  imagePaths: string[];
  prompt: string;
  aspectRatio: string;
  resolution: string;
  numVariations: number;
  maxPolls: number;
};

const argv = process.argv.slice(2);
const getFlag = (name: string, fallback?: string): string | undefined => {
  const idx = argv.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
};

const splitCsv = (val?: string): string[] =>
  val ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];

const normalizeFileUri = (uri?: string): string | undefined => {
  if (!uri) return uri;
  if (uri.startsWith("http")) {
    const match = uri.match(/\/files\/([^\/\?]+)/);
    if (match) return `files/${match[1]}`;
  }
  if (!uri.startsWith("files/")) return `files/${uri}`;
  return uri;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadConfig(): CliConfig {
  const apiKey =
    getFlag("api-key", process.env.API_KEY) || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or --api-key)");
  }

  const fileUris = splitCsv(getFlag("file-uris", process.env.FILE_URIS));
  const imagesArg = getFlag("images", process.env.IMAGES) || "";
  let imagePaths: string[] = [];
  if (imagesArg) {
    const p = path.resolve(imagesArg);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      imagePaths = fs
        .readdirSync(p)
        .filter((f) => f.match(/\.(png|jpe?g)$/i))
        .map((f) => path.join(p, f));
    } else {
      imagePaths = splitCsv(imagesArg).map((v) => path.resolve(v));
    }
  }

  return {
    apiKey,
    model: getFlag("model", process.env.MODEL) || "gemini-2.5-flash-image",
    fileUris,
    imagePaths,
    prompt:
      getFlag("prompt", process.env.PROMPT) ||
      "Generate a single realistic variation of this input image.",
    aspectRatio: getFlag("aspect-ratio", process.env.ASPECT_RATIO) || "1:1",
    resolution: getFlag("resolution", process.env.RESOLUTION) || "1K",
    numVariations: parseInt(
      getFlag("num-variations", process.env.NUM_VARIATIONS) || "1",
      10
    ),
    maxPolls: parseInt(
      getFlag("max-polls", process.env.MAX_POLLS) || "30",
      10
    ),
  };
}

async function ensureFileUris(
  ai: GoogleGenAI,
  cfg: CliConfig
): Promise<string[]> {
  const out: string[] = [];

  // Use provided fileUris
  for (const uri of cfg.fileUris) {
    const norm = normalizeFileUri(uri);
    if (norm) out.push(norm);
  }

  // Upload image files if provided
  for (const img of cfg.imagePaths) {
    if (!fs.existsSync(img)) {
      throw new Error(`Image path not found: ${img}`);
    }
    const mime = img.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    console.log(`[Upload] Uploading ${img} (${mime}) to Gemini Files...`);
    const buffer = fs.readFileSync(img);
    const blob = new Blob([buffer], { type: mime });
    const uploaded = await ai.files.upload({
      file: blob,
      config: {
        mimeType: mime,
        displayName: path.basename(img),
      },
    });
    let fileUri =
      (uploaded as any)?.file?.uri ||
      (uploaded as any)?.uri ||
      (uploaded as any)?.name;
    fileUri = normalizeFileUri(fileUri);
    if (!fileUri) throw new Error("Upload returned no fileUri");
    console.log(`[Upload] fileUri=${fileUri}`);
    out.push(fileUri);
  }

  if (out.length === 0) {
    throw new Error("Need at least one fileUri or image to upload (--file-uris or --images).");
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey });

  const fileUris = await ensureFileUris(ai, cfg);

  // Build inline requests for each file * variation
  const inlinedRequests: any[] = [];
  for (let i = 0; i < fileUris.length; i++) {
    for (let v = 0; v < cfg.numVariations; v++) {
      const req: any = {
        contents: [
          {
            role: "user",
            parts: [{ fileData: { fileUri: fileUris[i] } }, { text: cfg.prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      };
      if (cfg.model === "gemini-3-pro-image-preview") {
        req.generationConfig.imageConfig = {
          aspectRatio: cfg.aspectRatio,
          imageSize: cfg.resolution.toUpperCase(),
        };
      }
      inlinedRequests.push(req);
    }
  }

  console.log(
    `[Batch] Creating batch model=${cfg.model} requests=${inlinedRequests.length}`
  );
  const batch = await ai.batches.create({
    model: cfg.model,
    src: { inlinedRequests },
    config: { displayName: `debug-batch-${Date.now()}` },
  });
  const batchName = (batch as any).name || (batch as any).batch?.name;
  const initialState = (batch as any).state || (batch as any).batch?.state;
  if (!batchName) throw new Error("No batch name returned");
  console.log(`[Batch] name=${batchName} state=${initialState}`);

  const completed = new Set([
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
  ]);
  let job: any = batch;
  for (let i = 0; i < cfg.maxPolls; i++) {
    const state = job.state || job.batch?.state;
    if (completed.has(state)) break;
    await sleep(10_000);
    job = await ai.batches.get({ name: batchName });
    console.log(
      `[Batch] poll ${i + 1}: state=${job.state} batchStats=${
        job.batchStats ? JSON.stringify(job.batchStats) : "n/a"
      }`
    );
  }

  const finalState = job.state || job.batch?.state;
  console.log(`[Batch] Final state: ${finalState}`);
  if (finalState !== "JOB_STATE_SUCCEEDED") {
    console.log("Job did not succeed; raw job object:");
    console.log(JSON.stringify(job, null, 2));
    return;
  }

  if (job.dest?.fileName) {
    const fileName = job.dest.fileName;
    console.log(`[Batch] Downloading results file ${fileName}...`);
    const downloadUrl = `https://generativelanguage.googleapis.com/download/v1beta/${fileName}:download?alt=media&key=${cfg.apiKey}`;
    const resp = await fetch(downloadUrl);
    if (!resp.ok) {
      throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
    }
    const arrayBuf = await resp.arrayBuffer();
    const text = Buffer.from(arrayBuf).toString("utf-8");
    const lines = text.split("\n").filter((l: string) => l.trim());
    console.log(`[Batch] Lines: ${lines.length}`);
    let ok = 0;
    let err = 0;
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.error) {
        err++;
        console.log("Error item:", obj.key, obj.error);
      } else ok++;
    }
    console.log(`[Batch] OK=${ok} ERR=${err}`);
  } else if (job.dest?.inlinedResponses) {
    console.log(
      `[Batch] Inline responses: ${job.dest.inlinedResponses.length}`
    );
  } else {
    console.log("[Batch] No results found.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
