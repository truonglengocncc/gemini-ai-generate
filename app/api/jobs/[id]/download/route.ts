import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import archiver from "archiver";
import { PassThrough, Readable } from "stream";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await prisma.job.findUnique({ where: { id } });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.status !== "completed") {
      return NextResponse.json(
        { error: "Job is not completed yet" },
        { status: 400 }
      );
    }

    const results = (job.results as any)?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return NextResponse.json(
        { error: "No result images found for this job" },
        { status: 404 }
      );
    }

    const jobFolder = job.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const imageData: Array<{ url: string; filename: string }> = [];

    for (const result of results) {
      if (result.gcs_url) {
        const urlParts = result.gcs_url.split("/");
        const filename = urlParts[urlParts.length - 1];
        imageData.push({
          url: result.gcs_url,
          filename: `${jobFolder}/${filename}`,
        });
      }
    }

    if (imageData.length === 0) {
      return NextResponse.json(
        { error: "No downloadable images found" },
        { status: 404 }
      );
    }

    // Stream zip to client (avoid buffering 1k images in memory)
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    archive.on("error", (err) => stream.destroy(err));
    archive.pipe(stream);

    for (const image of imageData) {
      try {
        const resp = await fetch(image.url);
        if (!resp.ok || !resp.body) continue;
        // Convert web ReadableStream to Node Readable for archiver
        const nodeStream =
          typeof Readable.fromWeb === "function"
            ? Readable.fromWeb(resp.body as any)
            : Readable.from(resp.body as any);
        archive.append(nodeStream, { name: image.filename });
      } catch (err) {
        console.error(`Download error for ${image.url}:`, err);
      }
    }

    // Finalize archive
    archive.finalize();

    const safeName = jobFolder || "job";

    return new NextResponse(stream as any, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName}.zip"`,
      },
    });
  } catch (error: any) {
    console.error("Job download error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
