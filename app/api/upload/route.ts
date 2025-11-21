import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { Storage } from "@google-cloud/storage";

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
  const cdnUrl = process.env.CDN_ASSETS_URL_CAPSURE;
  if (cdnUrl) {
    // Use CDN URL
    return `${cdnUrl}/${blobPath}`;
  }

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

    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      // Generate unique filename
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 9);
      const extension = file.name.split(".").pop() || "jpg";
      const filename = `${timestamp}_${random}.${extension}`;

      if (useGcs) {
        // Upload to GCS at {jobId}/upload path
        const blobPath = `${jobId}/upload/${filename}`;
        const contentType = file.type || "image/jpeg";
        const url = await uploadToGcs(
          gcsClient!,
          buffer,
          gcsBucketName!,
          blobPath,
          contentType
        );
        urls.push(url);
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
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

