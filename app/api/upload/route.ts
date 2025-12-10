import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { Storage } from "@google-cloud/storage";
import { GoogleGenAI } from "@google/genai";

// In production, use cloud storage (S3, GCS, etc.)
const UPLOAD_DIR = join(process.cwd(), "public", "uploads");

/**
 * Get GCS client if configured
 */
function getGcsClient(): Storage | null {
  const gcsServiceAccountKey = process.env.GCS_SERVICE_ACCOUNT_KEY;
  const gcsBucketName = process.env.GCS_BUCKET_NAME;

  if (!gcsServiceAccountKey || !gcsBucketName) {
    return null; // GCS not configured
  }

  try {
    const credentials = JSON.parse(gcsServiceAccountKey);
    return new Storage({
      credentials,
    });
  } catch {
    return null;
  }
}

/**
 * Upload file to GCS
 */
async function uploadToGcs(
  gcsClient: Storage,
  buffer: Buffer,
  bucketName: string,
  blobPath: string,
  contentType: string = "image/jpeg"
): Promise<string> {
  const bucket = gcsClient.bucket(bucketName);
  const blob = bucket.file(blobPath);

  await blob.save(buffer, {
    contentType,
  });

  // Use CDN URL if configured, otherwise use signed URL (1 day) or public URL
  // Use public GCS URL (CDN currently disabled/broken)
  // const cdnUrl = null; // use public GCS

  // Generate signed URL (valid for 1 day) or use public URL
  try {
    const oneDayInMs = 24 * 60 * 60 * 1000; // 1 day in milliseconds
    const [url] = await blob.getSignedUrl({
      action: "read",
      expires: Date.now() + oneDayInMs,
    });
    return url;
  } catch {
    // Fallback to public URL
    return `https://storage.googleapis.com/${bucketName}/${blobPath}`;
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const jobId = request.nextUrl.searchParams.get("jobId");
    const useBatchApi = request.nextUrl.searchParams.get("useBatchApi") === "true";

    if (files.length === 0) {
      return NextResponse.json(
        { error: "No files provided" },
        { status: 400 }
      );
    }

    const gcsClient = getGcsClient();
    const gcsBucketName = process.env.GCS_BUCKET_NAME;
    // Always use GCS if configured, require jobId for proper path structure
    const useGcs = gcsClient && gcsBucketName;
    
    if (useGcs && !jobId) {
      return NextResponse.json(
        { error: "jobId is required when GCS is configured" },
        { status: 400 }
      );
    }

    const urls: string[] = [];
    const fileUris: Array<{ index: number; fileUri: string; fileName: string }> = [];
    const inlineDataList: Array<{ index: number; inlineData: { mimeType: string; data: string } }> = [];

    // If useBatchApi, also upload to Gemini File API
    const apiKey = useBatchApi ? process.env.GEMINI_API_KEY : null;
    if (useBatchApi && !apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY not configured for batch API" },
        { status: 500 }
      );
    }

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      // Generate unique filename
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 9);
      const extension = file.name.split(".").pop() || "jpg";
      const filename = `${timestamp}_${random}.${extension}`;
      const pathPrefix = (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, "");

      if (useGcs) {
        // Upload to GCS at {jobId}/upload path
        const blobPath = `${pathPrefix}/${jobId}/upload/${filename}`;
        const contentType = file.type || "image/jpeg";
        const url = await uploadToGcs(
          gcsClient!,
          buffer,
          gcsBucketName!,
          blobPath,
          contentType
        );
        urls.push(url);

        // If useBatchApi, upload to Gemini File API using the buffer we already have
        // (No need to download from GCS - we already have the file in memory)
        if (useBatchApi && apiKey) {
          try {
            const ai = new GoogleGenAI({ apiKey });
            // Use the buffer we already have (from FormData) - no need to download from GCS
            const blob = new Blob([buffer], { type: contentType });
            const uploadedFile = await ai.files.upload({
              file: blob,
              config: {
                mimeType: contentType,
                displayName: `batch_image_${jobId}_${idx}`,
              },
            });

            // SDK returns file URI in different formats, try both
            let fileUri = (uploadedFile as any).file?.uri || (uploadedFile as any).uri || (uploadedFile as any).name;
            if (!fileUri) {
              throw new Error("No file URI returned from upload");
            }

            // Extract files/xxx format from full URL if needed
            // SDK may return: https://generativelanguage.googleapis.com/v1beta/files/xxx
            // API needs: files/xxx
            if (fileUri.startsWith("http")) {
              const match = fileUri.match(/\/files\/([^\/\?]+)/);
              if (match) {
                fileUri = `files/${match[1]}`;
              }
            } else if (!fileUri.startsWith("files/")) {
              // If it's just an ID, prepend "files/"
              fileUri = `files/${fileUri}`;
            }

            fileUris.push({
              index: idx,
              fileUri, // e.g., "files/abc123"
              fileName: filename,
            });

            // Also return inlineData to avoid re-downloading later
            inlineDataList.push({
              index: idx,
              inlineData: {
                mimeType: contentType,
                data: buffer.toString("base64"),
              },
            });
          } catch (error: any) {
            console.error(`Error uploading ${filename} to Gemini File API:`, error);
            // Continue even if Gemini upload fails - GCS upload succeeded
          }
        }
      } else {
        // Fallback to local filesystem
        // Ensure upload directory exists
        if (!existsSync(UPLOAD_DIR)) {
          await mkdir(UPLOAD_DIR, { recursive: true });
        }

        const filepath = join(UPLOAD_DIR, filename);
        await writeFile(filepath, buffer);

        // Return public URL
        const url = `/uploads/${filename}`;
        urls.push(url);
      }
    }

    return NextResponse.json({
      urls,
      count: urls.length,
      // Include file_uris if batch API is used
      ...(useBatchApi && fileUris.length > 0 && { fileUris }),
      ...(useBatchApi && inlineDataList.length > 0 && { inlineData: inlineDataList }),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
