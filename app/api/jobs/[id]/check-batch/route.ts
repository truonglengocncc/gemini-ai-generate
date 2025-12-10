import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const config = (job.config || {}) as any;
    const batchNames: string[] =
      config.batch_job_names ||
      (config.batchJobName ? [config.batchJobName] : []) ||
      [];
    const requestKeys: string[] = config.request_keys || [];

    if (!batchNames.length) {
      return NextResponse.json(
        { error: "No batch job names stored for this job" },
        { status: 400 }
      );
    }

    // Enqueue worker to fetch results
    await submitFetchResultsToWorker(id, {
      job_id: id,
      batch_job_names: batchNames,
      request_keys: requestKeys,
      mode: "fetch_results",
    });

    // Mark as processing while worker fetches
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "processing" },
    });

    return NextResponse.json({
      status: "queued",
      message: "Worker is fetching batch results; page will update after webhook.",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function submitFetchResultsToWorker(jobId: string, payload: any) {
  const runpodEndpoint = process.env.RUNPOD_ENDPOINT;
  if (!runpodEndpoint) {
    throw new Error("RUNPOD_ENDPOINT not configured");
  }

  // attach gcs_config and gemini api on server side
  const gcsConfig = getGcsConfig();
  if (gcsConfig) {
    payload.gcs_config = gcsConfig;
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    payload.gemini_api_key = geminiKey;
  }
  payload.job_id = jobId;

  const webhookUrl = process.env.WEBHOOK_URL || process.env.NEXT_PUBLIC_WEBHOOK_URL;
  const requestBody: any = { input: payload };
  if (webhookUrl) requestBody.webhook = webhookUrl;

  await fetch(runpodEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });
}

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
      path_prefix: (process.env.GCS_PATH_PREFIX || "gemini-generate").replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}
