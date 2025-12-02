import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";
import { GoogleGenAI } from "@google/genai";

/**
 * Upload file from GCS to Gemini File API
 * Useful when you already have files in GCS and want to upload to Gemini
 * POST /api/upload/upload-from-gcs
 * Body: { gcsUrl: string, displayName?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { gcsUrl, displayName } = body;

    if (!gcsUrl) {
      return NextResponse.json(
        { error: "Missing gcsUrl" },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY not configured" },
        { status: 500 }
      );
    }

    // Parse GCS URL to get bucket and path
    // Support formats:
    // - https://storage.googleapis.com/bucket/path
    // - gs://bucket/path
    // - CDN URL
    let bucketName: string;
    let blobPath: string;

    if (gcsUrl.startsWith("gs://")) {
      const match = gcsUrl.match(/^gs:\/\/([^\/]+)\/(.+)$/);
      if (!match) {
        return NextResponse.json(
          { error: "Invalid GCS URL format" },
          { status: 400 }
        );
      }
      bucketName = match[1];
      blobPath = match[2];
    } else if (gcsUrl.includes("storage.googleapis.com")) {
      const match = gcsUrl.match(/https:\/\/storage\.googleapis\.com\/([^\/]+)\/(.+)$/);
      if (!match) {
        return NextResponse.json(
          { error: "Invalid GCS URL format" },
          { status: 400 }
        );
      }
      bucketName = match[1];
      blobPath = match[2];
    } else {
      // Try CDN URL - extract from CDN_ASSETS_URL_CAPSURE
      const cdnUrl = process.env.CDN_ASSETS_URL_CAPSURE;
      if (cdnUrl && gcsUrl.startsWith(cdnUrl)) {
        blobPath = gcsUrl.replace(cdnUrl, "").replace(/^\//, "");
        bucketName = process.env.GCS_BUCKET_NAME || "";
        if (!bucketName) {
          return NextResponse.json(
            { error: "GCS_BUCKET_NAME not configured" },
            { status: 500 }
          );
        }
      } else {
        return NextResponse.json(
          { error: "Unsupported URL format. Use gs:// or storage.googleapis.com URL" },
          { status: 400 }
        );
      }
    }

    // Get GCS client
    const gcsServiceAccountKey = process.env.GCS_SERVICE_ACCOUNT_KEY;
    if (!gcsServiceAccountKey) {
      return NextResponse.json(
        { error: "GCS_SERVICE_ACCOUNT_KEY not configured" },
        { status: 500 }
      );
    }

    const credentials = JSON.parse(gcsServiceAccountKey);
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(blobPath);

    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json(
        { error: "File not found in GCS" },
        { status: 404 }
      );
    }

    // Download file from GCS
    const [buffer] = await file.download();
    
    // Get content type
    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || "image/jpeg";

    // Upload to Gemini File API
    const ai = new GoogleGenAI({ apiKey });
    const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
    const uploadedFile = await ai.files.upload({
      file: blob,
      config: {
        mimeType: contentType,
        displayName: displayName || `gcs_${blobPath.split("/").pop()}`,
      },
    });

    // Extract files/xxx format
    let fileUri = (uploadedFile as any).file?.uri || (uploadedFile as any).uri || (uploadedFile as any).name;
    if (!fileUri) {
      throw new Error("No file URI returned from upload");
    }

    // Normalize to files/xxx format
    if (fileUri.startsWith("http")) {
      const match = fileUri.match(/\/files\/([^\/\?]+)/);
      if (match) {
        fileUri = `files/${match[1]}`;
      }
    } else if (!fileUri.startsWith("files/")) {
      fileUri = `files/${fileUri}`;
    }

    return NextResponse.json({
      fileUri,
      gcsUrl,
      displayName: displayName || blobPath.split("/").pop(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
