import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import archiver from "archiver";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const { groupId } = await params;
    const group = await prisma.group.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      return NextResponse.json(
        { error: "Group not found" },
        { status: 404 }
      );
    }

    const mode = request.nextUrl.searchParams.get("mode") || "zip";

    // Get all completed jobs in this group
    const groupJobs = await prisma.job.findMany({
      where: {
        groupId,
        status: "completed",
      },
    });

    const imageData: Array<{ url: string; filename: string }> = [];

    for (const job of groupJobs) {
      const jobFolder = job.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      if (job.results && typeof job.results === "object") {
        const results = (job.results as any).results;
        if (Array.isArray(results)) {
          for (const result of results) {
            if (result.gcs_url) {
              // Extract filename from URL
              const urlParts = result.gcs_url.split("/");
              const filename = urlParts[urlParts.length - 1];
              imageData.push({
                url: result.gcs_url,
                filename: `${jobFolder}/${filename}`,
              });
            }
          }
        }
      }
    }

    if (imageData.length === 0) {
      return NextResponse.json(
        { error: "No images found in group" },
        { status: 404 }
      );
    }

    // If mode=list, return JSON list of files for client-side download
    if (mode === "list") {
      return NextResponse.json({
        files: imageData,
        count: imageData.length,
      });
    }

    // Create ZIP file in memory with concurrent downloads to reduce timeout
    const archive = archiver("zip", {
      zlib: { level: 6 }, // slightly lower for speed
    });

    const chunks: Buffer[] = [];
    archive.on("data", (chunk) => chunks.push(chunk));

    const archiveFinished = new Promise<void>((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);
    });

    // simple p-limit
    const limit = 8;
    let active = 0;
    let idx = 0;
    const queue: Promise<void>[] = [];

    const runNext = async () => {
      if (idx >= imageData.length) return;
      const current = imageData[idx++];
      active++;
      try {
        const buffer = await downloadWithTimeout(current.url, 20000);
        if (buffer) archive.append(buffer, { name: current.filename });
      } catch (e) {
        console.warn("Download failed", current.url, e);
      } finally {
        active--;
        if (idx < imageData.length) {
          queue.push(runNext());
        }
      }
    };

    // start workers
    const starters = Math.min(limit, imageData.length);
    for (let i = 0; i < starters; i++) {
      queue.push(runNext());
    }
    await Promise.all(queue);

    archive.finalize();
    await archiveFinished;

    const zipBuffer = Buffer.concat(chunks);

    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${group.name.replace(/[^a-z0-9]/gi, "_")}_images.zip"`,
        "Content-Length": zipBuffer.length.toString(),
      },
    });
  } catch (error: any) {
    console.error("Download error:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

async function downloadWithTimeout(url: string, timeoutMs: number): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally {
    clearTimeout(timeout);
  }
}
