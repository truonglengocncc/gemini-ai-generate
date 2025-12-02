import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Storage } from "@google-cloud/storage";

/**
 * Check Gemini Batch API status and update job
 * Only for automatic mode with batch_submitted status
 * Called manually by user (refresh button)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    
    // Get job from database
    const job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }

    // Only check batch for automatic mode with batch_submitted status
    if (job.mode !== "automatic" || job.status !== "batch_submitted") {
      return NextResponse.json({
        message: "Job is not in batch_submitted status or not automatic mode",
        currentStatus: job.status,
        mode: job.mode,
      });
    }

    if (!job.batchJobName) {
      return NextResponse.json(
        { error: "Batch job name not found" },
        { status: 400 }
      );
    }

    // Get Gemini API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY not configured" },
        { status: 500 }
      );
    }

    // Check Gemini Batch API status
    const batchJobName = job.batchJobName;
    console.log(`[Check Batch] Checking batch job: ${batchJobName}`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${batchJobName}?key=${apiKey}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Check Batch] Error checking batch: ${errorText}`);
      return NextResponse.json(
        { error: `Failed to check batch: ${errorText}` },
        { status: response.status }
      );
    }

    const batchJob = await response.json();

    // Batch API sometimes returns the state in different shapes:
    // - Operation style: { done, metadata: { state, batchStats }, response: { responsesFile|inlinedResponses } }
    // - Direct batch object: { state, dest: { fileName|inlinedResponses }, batchStats }
    const {
      state: batchState,
      responsesFileName,
      inlinedResponses,
      batchStats,
      error: batchError,
    } = normalizeBatchResponse(batchJob);

    logBatchJobSummary(batchJob, {
      state: batchState,
      responsesFileName,
      inlineCount: inlinedResponses?.length ?? 0,
    });

    // Update job status based on batch state
    const updateData: any = {
      updatedAt: new Date(),
    };

    const successStates = ["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"];
    const failedStates = ["JOB_STATE_FAILED", "BATCH_STATE_FAILED"];
    const cancelledStates = [
      "JOB_STATE_CANCELLED",
      "BATCH_STATE_CANCELLED",
      "JOB_STATE_EXPIRED",
      "BATCH_STATE_EXPIRED",
    ];

    if (successStates.includes(batchState)) {
      // Download and process results
      console.log(`[Check Batch] Batch job completed, downloading results...`);
      
      if (responsesFileName) {
        const results = await downloadAndProcessBatchResults(
          responsesFileName,
          apiKey,
          job
        );
        
        updateData.status = "completed";
        updateData.results = { results };
        updateData.completedAt = new Date();
        
        console.log(`[Check Batch] Processed ${results.length} results`);
      } else {
        // Inline responses path (typically small batches)
        const results = await processInlineResponses(inlinedResponses, job);
        updateData.status = "completed";
        updateData.results = { results };
        updateData.completedAt = new Date();
      }
    } else if (failedStates.includes(batchState)) {
      updateData.status = "failed";
      updateData.error = batchError?.message || JSON.stringify(batchError) || "Batch job failed";
    } else if (cancelledStates.includes(batchState)) {
      updateData.status = "failed";
      updateData.error = "Batch job was cancelled or expired";
    } else {
      // Still processing: JOB_STATE_PENDING, JOB_STATE_RUNNING
      // Don't update status, just return current state
      return NextResponse.json({
        message: "Batch job still processing",
        state: batchState,
        status: job.status,
        batchStats,
      });
    }

    // Update job in database
    await prisma.job.update({
      where: { id: job.id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      jobId: job.id,
      batchState,
      status: updateData.status,
      resultsCount: updateData.results?.results?.length || 0,
    });
  } catch (error: any) {
    console.error("[Check Batch] Error:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

/**
 * Normalize batch response from Gemini Batch API.
 * Supports both Operation-style responses (metadata/response) and direct batch objects (state/dest).
 */
function normalizeBatchResponse(batchJob: any) {
  const state = batchJob?.state || batchJob?.metadata?.state;
  const batchStats = batchJob?.batchStats || batchJob?.metadata?.batchStats;

  // Results location can be inline or a responses file
  const responsesFileName =
    batchJob?.dest?.fileName ||
    batchJob?.dest?.responsesFile ||
    batchJob?.response?.responsesFile ||
    batchJob?.response?.responsesFileName ||
    batchJob?.responsesFile; // fallback just in case

  const inlinedResponses =
    batchJob?.dest?.inlinedResponses ||
    batchJob?.response?.inlinedResponses;

  const error = batchJob?.error || batchJob?.response?.error;

  return { state, responsesFileName, inlinedResponses, batchStats, error };
}

/**
 * Log a compact summary of batch job for debugging without flooding logs
 */
function logBatchJobSummary(batchJob: any, opts: { state: string; responsesFileName?: string; inlineCount: number }) {
  const {
    state,
    responsesFileName,
    inlineCount,
  } = opts;

  const batchStats =
    batchJob?.batchStats ||
    batchJob?.metadata?.batchStats ||
    batchJob?.response?.batchStats;

  console.log(
    `[Check Batch] State=${state} responsesFile=${responsesFileName || "none"} inlineCount=${inlineCount} ` +
      `batchStats=${batchStats ? JSON.stringify(batchStats) : "n/a"}`
  );
}

/**
 * Download batch results JSONL file and process it
 */
async function downloadAndProcessBatchResults(
  fileName: string,
  apiKey: string,
  job: any
): Promise<any[]> {
  try {
    // Download results file
    const downloadUrl = `https://generativelanguage.googleapis.com/download/v1beta/${fileName}:download?alt=media&key=${apiKey}`;
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new Error(`Failed to download results: ${response.statusText}`);
    }

    const jsonlText = await response.text();
    console.log(
      `[Check Batch] Downloaded results file ${fileName} (${Buffer.byteLength(
        jsonlText,
        "utf-8"
      )} bytes)`
    );
    const lines = jsonlText.split("\n").filter((line) => line.trim());

    // Parse JSONL and extract results
    const results: any[] = [];
    const errors: any[] = [];
    const gcsConfig = getGcsConfig();
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const parsed = JSON.parse(line);
        
        // Check if this is an error response
        if (parsed.error) {
          errors.push(parsed.error);
          continue;
        }

        // Extract image from response
        if (parsed.response?.candidates?.[0]?.content?.parts) {
          for (const part of parsed.response.candidates[0].content.parts) {
            if (part.inlineData?.data) {
              // Decode base64 image
              const imageBuffer = Buffer.from(part.inlineData.data, "base64");
              
              // Parse key to get image index and variation
              // key format: "image_{index}_variation_{variation}"
              const key = parsed.key || `result_${results.length}`;
              const match = key.match(/image_(\d+)_variation_(\d+)/);
              const imageIndex = match ? parseInt(match[1]) : results.length;
              const variation = match ? parseInt(match[2]) : 0;
              
              // Upload to GCS
              if (gcsConfig) {
                const gcsUrl = await uploadImageToGcs(
                  imageBuffer,
                  key,
                  job.id,
                  imageIndex,
                  variation,
                  gcsConfig
                );
                
                results.push({
                  original_index: imageIndex,
                  variation: variation,
                  gcs_url: gcsUrl,
                });
              } else {
                // Fallback: return base64
                results.push({
                  original_index: imageIndex,
                  variation: variation,
                  image: part.inlineData.data,
                });
              }
            }
          }
        }
      } catch (parseError) {
        console.error(`[Check Batch] Error parsing line:`, parseError);
      }
    }

    if (errors.length > 0) {
      console.error(
        `[Check Batch] Batch contained ${errors.length} error items. First 3:`,
        errors.slice(0, 3)
      );
    }

    return results;
  } catch (error: any) {
    console.error(`[Check Batch] Error processing results:`, error);
    throw error;
  }
}

/**
 * Process inline batch responses (returned directly in the operation response)
 */
async function processInlineResponses(inlinedResponses: any[] | undefined, job: any): Promise<any[]> {
  if (!inlinedResponses || inlinedResponses.length === 0) return [];

  const results: any[] = [];
  const gcsConfig = getGcsConfig();

  console.log(`[Check Batch] Processing inline responses: ${inlinedResponses.length}`);

  for (const inlineResponse of inlinedResponses) {
    if (inlineResponse.error) {
      console.error(`[Check Batch] Error in inline response:`, inlineResponse.error);
      continue;
    }

    const parts = inlineResponse.response?.candidates?.[0]?.content?.parts;
    if (!parts) continue;

    const key =
      inlineResponse.key ||
      inlineResponse.metadata?.key ||
      `result_${results.length}`;
    const match = key.match(/image_(\d+)_variation_(\d+)/);
    const imageIndex = match ? parseInt(match[1]) : results.length;
    const variation = match ? parseInt(match[2]) : 0;

    for (const part of parts) {
      if (part.inlineData?.data) {
        const imageBuffer = Buffer.from(part.inlineData.data, "base64");

        if (gcsConfig) {
          const gcsUrl = await uploadImageToGcs(
            imageBuffer,
            key,
            job.id,
            imageIndex,
            variation,
            gcsConfig
          ).catch((err) => {
            console.error("[Check Batch] Failed to upload inline image:", err);
            return null;
          });

          if (gcsUrl) {
            results.push({
              original_index: imageIndex,
              variation,
              gcs_url: gcsUrl,
            });
          }
        } else {
          results.push({
            original_index: imageIndex,
            variation,
            image: part.inlineData.data,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Upload image to GCS
 */
async function uploadImageToGcs(
  imageBuffer: Buffer,
  key: string,
  jobId: string,
  imageIndex: number,
  variation: number,
  gcsConfig: any
): Promise<string> {
  const credentials = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_KEY || "{}");
  const storage = new Storage({ credentials });
  const bucket = storage.bucket(gcsConfig.bucket_name);
  
  // Use same path structure as regular automatic mode
  const timestamp = Date.now();
  const uniqueId = `${timestamp}_${imageIndex}_${variation}`;
  const pathPrefix = `${jobId}/processed`;
  const filename = `${pathPrefix}/automatic/${imageIndex}/variation_${variation}_${uniqueId}.jpg`;
  
  const blob = bucket.file(filename);
  await blob.save(imageBuffer, {
    contentType: "image/jpeg",
  });

  // Return CDN URL or signed URL
  const cdnUrl = process.env.CDN_ASSETS_URL_CAPSURE;
  if (cdnUrl) {
    return `${cdnUrl.replace(/\/$/, "")}/${filename}`;
  }
  
  try {
    const [url] = await blob.getSignedUrl({
      action: "read",
      expires: Date.now() + 86400 * 1000, // 24 hours
    });
    return url;
  } catch {
    return `https://storage.googleapis.com/${gcsConfig.bucket_name}/${filename}`;
  }
}

/**
 * Get GCS config from environment
 */
function getGcsConfig(): any | null {
  const gcsServiceAccountKey = process.env.GCS_SERVICE_ACCOUNT_KEY;
  const gcsBucketName = process.env.GCS_BUCKET_NAME;

  if (!gcsServiceAccountKey || !gcsBucketName) {
    return null;
  }

  try {
    const credentials = JSON.parse(gcsServiceAccountKey);
    return {
      credentials,
      bucket_name: gcsBucketName,
    };
  } catch {
    return null;
  }
}
