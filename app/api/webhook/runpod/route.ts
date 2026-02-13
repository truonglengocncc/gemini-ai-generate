import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Webhook endpoint to receive job completion callbacks from RunPod Serverless
 * 
 * RunPod will POST to this endpoint when a job completes.
 * Configure the webhook URL in RunPod Serverless endpoint settings.
 */
const LOG = "[webhook/runpod]";

export async function POST(request: NextRequest) {
  const start = Date.now();
  try {
    console.log(`${LOG} POST received`);
    const body = await request.json();
    const { id: runpodJobId, status, output, error, input } = body;
    console.log(`${LOG} body parsed | runpodId=${runpodJobId} status=${status} keys=${Object.keys(body).join(",")}`);

    // Handle cleanup webhook (no job_id)
    if (input?.mode === "cleanup_group") {
      console.log(`${LOG} cleanup_group ignored`);
      return NextResponse.json({ success: true, mode: "cleanup_group" });
    }

    const jobId = input?.job_id;
    if (!jobId) {
      console.error(`${LOG} missing job_id in input:`, JSON.stringify(input).slice(0, 200));
      return NextResponse.json(
        { error: "Missing job_id in input payload" },
        { status: 400 }
      );
    }

    console.log(`${LOG} findUnique jobId=${jobId}`);
    const job = await prisma.job.findUnique({
      where: {
        id: jobId,
      },
    });

    if (!job) {
      console.warn(`${LOG} job not found jobId=${jobId} runpodId=${runpodJobId}`);
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }
    console.log(`${LOG} job found jobId=${jobId} runpodId=${runpodJobId}`);

    // Update job status and results
    const updateData: any = {
      status: status === "COMPLETED" ? "completed" : status === "FAILED" ? "failed" : "processing",
      updatedAt: new Date(),
    };

    // Handle batch_submitted status (from Batch API)
    if (output?.status === "batch_submitted" && (output?.batch_job_name || output?.batch_job_names)) {
      const batchNames = output.batch_job_names || [output.batch_job_name];
      const requestKeys = output.request_keys || [];
      const batchSrcFiles = output.batch_src_files || [];
      const resourceJsonlGcsUrls = output.resource_jsonl_gcs_urls || [];
      updateData.status = "batch_submitted";
      updateData.config = {
        ...((job.config as any) || {}),
        batch_job_names: batchNames,
        batch_src_files: batchSrcFiles,
        resource_jsonl_gcs_urls: resourceJsonlGcsUrls,
        request_keys: requestKeys,
      };
      console.log(`${LOG} batch_submitted jobId=${jobId} batchNames=${batchNames.join(",")}`);
      await prisma.job.update({
        where: { id: job.id },
        data: updateData,
      });

      console.log(`${LOG} response batch_submitted jobId=${jobId} duration=${Date.now() - start}ms`);
      return NextResponse.json({
        success: true,
        jobId: job.id,
        status: "batch_submitted",
        batchJobNames: batchNames,
      });
    }

    if (status === "COMPLETED" && output) {
      // Merge results to avoid duplicates on repeated fetches
      const prev = (job.results as any)?.results;
      const next = output?.results;
      if (Array.isArray(prev) && Array.isArray(next)) {
        const merged = [...prev, ...next];
        const seen = new Set<string>();
        output.results = merged.filter((r: any) => {
          const key = r?.gcs_url || r?.image;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        output.total_generated = output.results.length;
      }
      // Store full output in results field
      updateData.results = output;
      updateData.completedAt = new Date();
      // Persist response file names and batch names for later cleanup
      if ((Array.isArray(output.response_files) && output.response_files.length > 0) ||
          (Array.isArray(output.batch_job_names) && output.batch_job_names.length > 0)) {
        updateData.config = {
          ...((job.config as any) || {}),
          response_files: Array.isArray(output.response_files) ? output.response_files : (job.config as any)?.response_files,
          batch_job_names: Array.isArray(output.batch_job_names) ? output.batch_job_names : (job.config as any)?.batch_job_names,
          response_jsonl_gcs_urls: Array.isArray(output.response_jsonl_gcs_urls)
            ? output.response_jsonl_gcs_urls
            : (job.config as any)?.response_jsonl_gcs_urls,
        };
      }
      
      // Log full output for debugging
      // console.log("Output:", JSON.stringify(output, null, 2));
      
      // Extract generated image URLs from output.results and store separately
      if (output.results && Array.isArray(output.results)) {
        const generatedUrls = output.results
          .map((result: any) => result.gcs_url)
          .filter((url: string) => url); // Filter out any null/undefined
        
        if (generatedUrls.length > 0) {
          // Store generated images in a separate field (not merging with uploaded images)
          // job.images = uploaded images (refs)
          // updateData.results = full output with generated URLs
          console.log(`${LOG} jobId=${jobId} completed generated=${generatedUrls.length} uploaded=${Array.isArray(job.images) ? job.images.length : 0}`);
        }
      }
    }

    if (status === "FAILED" && error) {
      const errMsg = typeof error === "string" ? error : JSON.stringify(error);
      updateData.error = truncateError(errMsg);
      console.warn(`${LOG} jobId=${jobId} FAILED error=${truncateError(errMsg, 200)}`);
    }

    console.log(`${LOG} update jobId=${jobId} status=${updateData.status}`);
    await prisma.job.update({
      where: { id: job.id },
      data: updateData,
    });

    console.log(`${LOG} success jobId=${job.id} status=${updateData.status} duration=${Date.now() - start}ms`);
    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: updateData.status,
    });
  } catch (error: any) {
    console.error(`${LOG} error duration=${Date.now() - start}ms`, error?.message ?? String(error));
    console.error(`${LOG} stack:`, error?.stack);
    return NextResponse.json(
      { error: error?.message ?? "Webhook handler error" },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for webhook verification (if needed by RunPod)
 */
export async function GET(_request: NextRequest) {
  return NextResponse.json({
    message: "RunPod webhook endpoint is active",
  });
}

function truncateError(msg: string, max: number = 180) {
  if (!msg) return "";
  return msg.length > max ? `${msg.slice(0, max - 3)}...` : msg;
}
