import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Webhook endpoint to receive job completion callbacks from RunPod Serverless
 * 
 * RunPod will POST to this endpoint when a job completes.
 * Configure the webhook URL in RunPod Serverless endpoint settings.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    console.log("Webhook body:", JSON.stringify(body, null, 2));
    // RunPod webhook format: https://docs.runpod.io/serverless/workers/webhooks
    const { id: runpodJobId, status, output, error, input } = body;
    
    // Extract our job_id from input payload
    const jobId = input?.job_id;
    
    if (!jobId) {
      console.error("Missing job_id in webhook input:", input);
      return NextResponse.json(
        { error: "Missing job_id in input payload" },
        { status: 400 }
      );
    }

    // Find job by our job_id (not RunPod's ID)
    const job = await prisma.job.findUnique({
      where: {
        id: jobId,
      },
    });

    if (!job) {
      console.warn(`Job not found for job_id: ${jobId} (RunPod ID: ${runpodJobId})`);
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }
    
    console.log(`Processing webhook for job: ${jobId} (RunPod ID: ${runpodJobId})`);

    // Update job status and results
    const updateData: any = {
      status: status === "COMPLETED" ? "completed" : status === "FAILED" ? "failed" : "processing",
      updatedAt: new Date(),
    };

    if (status === "COMPLETED" && output) {
      // Store full output in results field
      updateData.results = output;
      updateData.completedAt = new Date();
      
      // Log full output for debugging
      console.log("Output:", JSON.stringify(output, null, 2));
      
      // Extract generated image URLs from output.results and store separately
      if (output.results && Array.isArray(output.results)) {
        const generatedUrls = output.results
          .map((result: any) => result.gcs_url)
          .filter((url: string) => url); // Filter out any null/undefined
        
        if (generatedUrls.length > 0) {
          // Store generated images in a separate field (not merging with uploaded images)
          // job.images = uploaded images (refs)
          // updateData.results = full output with generated URLs
          console.log(`Job ${jobId} completed with ${generatedUrls.length} generated images`);
          const uploadedCount = Array.isArray(job.images) ? job.images.length : 0;
          console.log(`Uploaded images: ${uploadedCount}, Generated images: ${generatedUrls.length}`);
        }
      }
    }

    if (status === "FAILED" && error) {
      updateData.error = typeof error === "string" ? error : JSON.stringify(error);
    }

    await prisma.job.update({
      where: { id: job.id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: updateData.status,
    });
  } catch (error: any) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for webhook verification (if needed by RunPod)
 */
export async function GET(request: NextRequest) {
  return NextResponse.json({
    message: "RunPod webhook endpoint is active",
  });
}

