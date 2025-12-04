import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";

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
    const prefix = (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, "");
    const useCdn = false; // CDN disabled, use public GCS URL

    const uploads = await Promise.all(
      files.map(async (file) => {
        const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${prefix}/${jobId}/upload/${safeName}`;
        const gcsFile = bucket.file(path);
        const [url] = await gcsFile.getSignedUrl({
          version: "v4",
          action: "write",
          expires: Date.now() + 15 * 60 * 1000,
          contentType: file.contentType || "application/octet-stream",
        });

        const publicUrl = `https://storage.googleapis.com/${bucketName}/${path}`;

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
