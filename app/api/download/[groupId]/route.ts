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

    // Get all completed jobs in this group
    const groupJobs = await prisma.job.findMany({
      where: {
        groupId,
        status: "completed",
      },
    });

    const imageData: Array<{ url: string; filename: string }> = [];

    for (const job of groupJobs) {
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
                filename: filename,
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

    // Create ZIP file in memory
    const archive = archiver("zip", {
      zlib: { level: 9 }, // Maximum compression
    });

    const chunks: Buffer[] = [];

    // Collect all chunks
    archive.on("data", (chunk) => {
      chunks.push(chunk);
    });

    // Wait for archive to finish
    const archiveFinished = new Promise<void>((resolve, reject) => {
      archive.on("end", () => {
        resolve();
      });
      archive.on("error", (err) => {
        reject(err);
      });
    });

    // Download and add each image to the ZIP
    for (const image of imageData) {
      try {
        const response = await fetch(image.url);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          archive.append(Buffer.from(buffer), { name: image.filename });
        } else {
          console.warn(`Failed to download image: ${image.url}`);
        }
      } catch (error) {
        console.error(`Error downloading image ${image.url}:`, error);
      }
    }

    // Finalize the archive
    archive.finalize();

    // Wait for archive to complete
    await archiveFinished;

    // Combine all chunks into a single buffer
    const zipBuffer = Buffer.concat(chunks);

    // Return ZIP file with proper headers
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

