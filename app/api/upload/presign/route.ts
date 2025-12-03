import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";

let corsEnsured = false;

interface PresignFile {
  index: number;
  filename: string;
  contentType?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { jobId, files } = body as { jobId: string; files: PresignFile[] };

    if (!jobId || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json(
        { error: "Missing jobId or files" },
        { status: 400 }
      );
    }

    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName || !process.env.GCS_SERVICE_ACCOUNT_KEY) {
      return NextResponse.json(
        { error: "GCS not configured" },
        { status: 500 }
      );
    }

    const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY);
    const storage = new Storage({ credentials });
    const bucket = storage.bucket(bucketName);

    // Ensure CORS for browser direct upload (optional, controlled by env)
    if (!corsEnsured && process.env.GCS_ENABLE_CORS === "true") {
      try {
        await bucket.setCors([
          {
            origin: ["*"],
            method: ["PUT", "POST", "GET", "HEAD"],
            responseHeader: ["Content-Type", "x-goog-meta-*"],
            maxAgeSeconds: 3600,
          },
        ]);
        corsEnsured = true;
        console.log("[Presign] Set bucket CORS for direct uploads");
      } catch (err) {
        console.warn("[Presign] Failed to set CORS (continuing):", err);
      }
    }

    const uploads = await Promise.all(
      files.map(async (file) => {
        const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${jobId}/upload/${safeName}`;
        const gcsFile = bucket.file(path);
        const [url] = await gcsFile.getSignedUrl({
          version: "v4",
          action: "write",
          expires: Date.now() + 15 * 60 * 1000,
          contentType: file.contentType || "application/octet-stream",
        });

        const cdn = process.env.CDN_ASSETS_URL_CAPSURE;
        const publicUrl = cdn
          ? `${cdn.replace(/\/$/, "")}/${path}`
          : `https://storage.googleapis.com/${bucketName}/${path}`;

        return {
          index: file.index,
          uploadUrl: url,
          filePath: path,
          contentType: file.contentType || "application/octet-stream",
          publicUrl,
        };
      })
    );

    return NextResponse.json({ uploads });
  } catch (error: any) {
    console.error("[Presign] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
