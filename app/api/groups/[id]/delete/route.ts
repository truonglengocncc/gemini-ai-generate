import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: groupId } = await params;

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: { jobs: true },
    });

    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }

    // Delete jobs & group in DB
    await prisma.job.deleteMany({ where: { groupId } });
    await prisma.group.delete({ where: { id: groupId } });

    // Collect batch_job_names from configs (if any) before deletion
    const batchNames: string[] = [];
    for (const j of group.jobs) {
      const cfg: any = j.config || {};
      const names =
        cfg.batch_job_names ||
        cfg.batchJobNames ||
        (cfg.batchJobName ? [cfg.batchJobName] : []);
      if (Array.isArray(names)) {
        batchNames.push(...names);
      }
    }

    // Enqueue cleanup worker (GCS + Gemini files + batches)
    await submitCleanupToWorker(groupId, group.jobs.map((j) => j.id), batchNames);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Delete group error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function submitCleanupToWorker(groupId: string, jobIds: string[], batchNames: string[]) {
  const runpodEndpoint = process.env.RUNPOD_ENDPOINT;
  if (!runpodEndpoint) return;

  const payload: any = {
    mode: "cleanup_group",
    group_id: groupId,
    job_ids: jobIds,
    job_id: groupId, // for webhook compatibility
    batch_names: batchNames,
  };

  const gcsConfig = getGcsConfig();
  if (gcsConfig) payload.gcs_config = gcsConfig;

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) payload.gemini_api_key = geminiKey;

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
  }).catch(() => null);
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
