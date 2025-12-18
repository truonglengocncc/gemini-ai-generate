"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import JSZip from "jszip";

interface Job {
  id: string;
  groupId: string;
  mode: string;
  status: string;
  images: string[];
  prompts: string[];
  config: any;
  results: any;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export default function JobDetailPage() {
  const { id } = useParams();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingBatch, setCheckingBatch] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showUploads, setShowUploads] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadingClient, setDownloadingClient] = useState(false);

  const fetchJobDetails = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/jobs/${id}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setJob(data);
    } catch (err: any) {
      setError(err.message);
      console.error("Failed to fetch job details:", err);
    } finally {
      setLoading(false);
    }
  };

  const checkBatchStatus = async () => {
    if (!job || job.mode !== "automatic" || job.status !== "batch_submitted") {
      return;
    }

    try {
      setCheckingBatch(true);
      const response = await fetch(`/api/jobs/${id}/check-batch`, {
        method: "POST",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to check batch status");
      }

      const data = await response.json();
      
      const state = data.batchState || data.state;

      // If batch is still processing, just show message
      if (state && (state === "JOB_STATE_PENDING" || state === "JOB_STATE_RUNNING")) {
        alert(`Batch job is still processing. State: ${state}`);
        // Refresh job details to get latest status
        await fetchJobDetails();
        return;
      }

      // If completed or failed, refresh job details to get updated status
      await fetchJobDetails();
    } catch (err: any) {
      console.error("Failed to check batch status:", err);
      alert(`Error: ${err.message}`);
    } finally {
      setCheckingBatch(false);
    }
  };

  useEffect(() => {
    if (id) {
      fetchJobDetails();
    }
  }, [id]); // eslint-disable-line react-hooks-exhaustive-deps

  // Auto-collapse huge lists to keep UI light
  useEffect(() => {
    if (job) {
      if (job.images.length > 50) setShowUploads(false);
      if (job.config && Object.keys(job.config).length > 0) setShowConfig(false);
    }
  }, [job]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300";
      case "failed":
        return "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300";
      case "processing":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-300";
      case "queued":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300";
      case "batch_submitted":
        return "bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-300";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-300";
    }
  };

  const isAutomaticMode = job?.mode === "automatic";
  const canFetchResults = isAutomaticMode && Array.isArray(job?.config?.batch_job_names) && job.config.batch_job_names.length > 0;
  const canRetrySavedFiles = Array.isArray(job?.config?.batch_src_files) && job.config.batch_src_files.length > 0;
  const canRetryFromStart = job?.mode === "automatic" && !!(job?.config?.folder || (job?.images && job.images.length > 0));

  const refreshJobOnly = async () => {
    if (!job) return;
    setCheckingBatch(true);
    try {
      await fetchJobDetails();
    } finally {
      setCheckingBatch(false);
    }
  };

  const fetchResultsAgain = async () => {
    if (!job) return;
    if (!isAutomaticMode) {
      await refreshJobOnly();
      return;
    }
    if (!confirm("Fetch batch results again?")) return;
    setCheckingBatch(true);
    try {
      await fetch(`/api/jobs/${job.id}/check-batch`, { method: "POST" });
      await fetchJobDetails();
    } finally {
      setCheckingBatch(false);
    }
  };

  const retryFromStart = async () => {
    if (!job) return;
    if (!confirm("Retry this job from the start? This may create new batches.")) return;
    setCheckingBatch(true);
    try {
      const url = job.mode === "automatic" ? "/api/jobs/submit-batch" : "/api/jobs/submit";
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, retry: true }),
      });
      await fetchJobDetails();
    } finally {
      setCheckingBatch(false);
    }
  };

  const retryWithSavedFiles = async () => {
    if (!job) return;
    if (!confirm("Retry using saved JSONL files?")) return;
    setCheckingBatch(true);
    try {
      const url = job.mode === "automatic" ? "/api/jobs/submit-batch" : "/api/jobs/submit";
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, retry: true, use_preuploaded: true }),
      });
      await fetchJobDetails();
    } finally {
      setCheckingBatch(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black p-8 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-gray-700 dark:text-gray-200">
          <div className="h-10 w-10 border-4 border-blue-500/40 border-t-blue-600 rounded-full animate-spin" />
          <p className="text-lg font-medium">Loading job details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black p-8">
        <div className="max-w-6xl mx-auto">
          <Link href="/jobs" className="text-blue-600 hover:text-blue-800 dark:text-blue-400 mb-4 inline-block">
            ← Back to Jobs
          </Link>
          <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-lg">
            <p className="text-red-600 dark:text-red-400">Error: {error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black p-8">
        <div className="max-w-6xl mx-auto">
          <Link href="/jobs" className="text-blue-600 hover:text-blue-800 dark:text-blue-400 mb-4 inline-block">
            ← Back to Jobs
          </Link>
          <p className="text-gray-600 dark:text-gray-400">Job not found.</p>
        </div>
      </div>
    );
  }

  const resultList: any[] = Array.isArray(job.results?.results) ? job.results.results : [];
  const generatedImages = resultList.map((r: any) => r.gcs_url).filter(Boolean);
  const variationCount =
    Number(job.config?.num_variations) ||
    Number((job.config as any)?.config?.num_variations) ||
    Number((job.config as any)?.config?.config?.num_variations) ||
    1;
  const rawAspectRatios =
    (job.config as any)?.aspect_ratios ||
    (job.config as any)?.config?.aspect_ratios ||
    (job.config as any)?.config?.config?.aspect_ratios;
  const aspectRatioValue =
    (job.config as any)?.aspect_ratio ||
    (job.config as any)?.config?.aspect_ratio ||
    (job.config as any)?.config?.config?.aspect_ratio;
  const ratioCount =
    Array.isArray(rawAspectRatios) && rawAspectRatios.length > 0
      ? rawAspectRatios.length
      : aspectRatioValue
        ? 1
        : 1;
  const expectedImages =
    job.mode === "text-image"
      ? (Array.isArray(job.prompts) ? job.prompts.length : 0) * Math.max(1, variationCount)
      : (Array.isArray(job.images) ? job.images.length : 0) * Math.max(1, variationCount) * ratioCount;

  const handleClientDownload = async () => {
    if (!job) return;
    try {
      setDownloadingClient(true);
      const res = await fetch(`/api/download/${job.groupId}?mode=list`);
      if (!res.ok) throw new Error("Failed to fetch file list");
      const data = await res.json();
      const files: Array<{ url: string; filename: string }> = data.files || [];
      const zip = new JSZip();

      let idx = 0;
      const limit = 8;
      const worker = async () => {
        while (idx < files.length) {
          const current = files[idx++];
          try {
            const r = await fetch(current.url);
            if (!r.ok) continue;
            const blob = await r.blob();
            zip.file(current.filename, blob);
          } catch (e) {
            console.error("client download failed", current.url, e);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(limit, files.length) }, () => worker())
      );

      const content = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(content);
      a.download = `${job.groupId}_images.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error("Client ZIP failed", e);
      alert("Client ZIP failed. Please try server download.");
    } finally {
      setDownloadingClient(false);
    }
  };
  const groupedResults: Record<string, any[]> = resultList.reduce((acc: Record<string, any[]>, item: any) => {
    const key = item.ratio || "default";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
  const ratioKeys = Object.keys(groupedResults);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black p-8">
      <div className="max-w-7xl mx-auto">
        <Link href="/jobs" className="text-blue-600 hover:text-blue-800 dark:text-blue-400 mb-4 inline-block">
          ← Back to Jobs
        </Link>

        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-3xl font-bold">Job Details</h1>
            <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getStatusColor(job.status)}`}>
              {job.status.toUpperCase()}
            </span>
          </div>


          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Job ID</p>
              <p className="font-mono text-sm break-all">{job.id}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Mode</p>
              <p className="font-semibold">{job.mode}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Model</p>
              <p className="font-semibold">{job.config?.model || "N/A"}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Created At</p>
              <p>{new Date(job.createdAt).toLocaleString()}</p>
            </div>
            {job.completedAt && (
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Completed At</p>
                <p>{new Date(job.completedAt).toLocaleString()}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Group ID</p>
              <Link 
                href={`/groups/${job.groupId}`}
                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 font-mono text-sm"
              >
                {job.groupId}
              </Link>
            </div>
          </div>

          {(canFetchResults || canRetrySavedFiles || canRetryFromStart) && (
            <div className="mb-6 bg-white dark:bg-zinc-900 rounded-lg p-6 border border-zinc-200 dark:border-zinc-800">
              <h3 className="text-lg font-semibold mb-3">Actions</h3>
              <div className="flex flex-wrap gap-3">
                {canFetchResults && (
                  <button
                    onClick={fetchResultsAgain}
                    disabled={checkingBatch}
                    className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-60 text-sm font-medium"
                  >
                    {checkingBatch ? "Working..." : "Fetch results"}
                  </button>
                )}
                {canRetrySavedFiles && (
                  <button
                    onClick={retryWithSavedFiles}
                    disabled={checkingBatch}
                    className="px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-60 text-sm font-medium"
                  >
                    {checkingBatch ? "Working..." : "Retry saved files"}
                  </button>
                )}
                {canRetryFromStart && (
                  <button
                    onClick={retryFromStart}
                    disabled={checkingBatch}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60 text-sm font-medium"
                  >
                    {checkingBatch ? "Working..." : "Retry from start"}
                  </button>
                )}
              </div>
            </div>
          )}

          {job.prompts && job.prompts.length > 0 && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-2">Prompts</h3>
              <div className="space-y-2">
                {job.prompts.map((prompt, idx) => (
                  <div key={idx} className="bg-gray-50 dark:bg-zinc-800 p-3 rounded">
                    <p className="text-sm">{prompt}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {job.config && Object.keys(job.config).length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold">Configuration</h3>
                <button
                  onClick={() => setShowConfig((v) => !v)}
                  className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800"
                >
                  {showConfig ? "Hide" : "Show"}
                </button>
              </div>
              {showConfig && (
                <div className="bg-gray-50 dark:bg-zinc-800 p-4 rounded">
                  <pre className="text-sm overflow-x-auto">
                    {JSON.stringify(job.config, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {job.error && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-2 text-red-600 dark:text-red-400">Error</h3>
              <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded">
                <p className="text-sm text-red-600 dark:text-red-400">{job.error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Uploaded Images Section */}
        {job.images && job.images.length > 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold">
                Uploaded Images ({job.images.length})
              </h2>
              <button
                onClick={() => setShowUploads((v) => !v)}
                className="text-xs px-3 py-1 rounded border border-gray-300 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800"
              >
                {showUploads ? "Hide" : "Show"}
              </button>
            </div>
            {showUploads && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {job.images.map((url, idx) => (
                  <div key={idx} className="relative group">
                    <img
                      src={url}
                      alt={`Uploaded ${idx + 1}`}
                      className="w-full h-48 object-cover rounded-lg border-2 border-gray-200 dark:border-zinc-700"
                    />
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute inset-0 bg-black bg-opacity-0 hover:bg-opacity-50 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100 rounded-lg"
                    >
                      <span className="text-white font-semibold">View Full</span>
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Generated Images Section */}
        {generatedImages.length > 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <h2 className="text-2xl font-bold">
                Generated Images ({generatedImages.length})
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => window.location.href = `/api/jobs/${job.id}/download`}
                  disabled={job.status !== "completed"}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow"
                  title={job.status === "completed" ? "Download results as ZIP" : "Job not completed yet"}
                >
                  Server ZIP
                </button>
                <button
                  onClick={handleClientDownload}
                  disabled={downloadingClient}
                  className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed shadow"
                  title="Download ZIP in browser to avoid server timeout"
                >
                  {downloadingClient ? "Preparing..." : "Client ZIP (beta)"}
                </button>
              </div>
            </div>
            <div className="space-y-6">
              {ratioKeys.map((ratioKey) => (
                <div key={ratioKey}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="px-3 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-200 text-xs font-semibold">
                      Ratio {ratioKey === "default" ? "N/A" : ratioKey.replace(/x/g, ":")}
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {groupedResults[ratioKey].length} images
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {groupedResults[ratioKey].map((result: any, idx: number) => (
                      <div key={`${ratioKey}-${idx}`} className="relative group">
                        <img
                          src={result.gcs_url}
                          alt={`Generated ${idx + 1}`}
                          className="w-full h-48 object-cover rounded-lg border-2 border-green-200 dark:border-green-700"
                        />
                        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                          <span className="bg-black bg-opacity-75 text-white text-[11px] px-2 py-1 rounded">
                            Var {result.variation}
                          </span>
                          {result.original_index !== undefined && (
                            <span className="bg-gray-800 bg-opacity-80 text-white text-[11px] px-2 py-1 rounded">
                              Img {result.original_index}
                            </span>
                          )}
                        </div>
                        <a
                          href={result.gcs_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="absolute inset-0 bg-black bg-opacity-0 hover:bg-opacity-50 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100 rounded-lg"
                        >
                          <span className="text-white font-semibold">View Full</span>
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {job.status === "completed" && generatedImages.length === 0 && (
          <div className="bg-yellow-50 dark:bg-yellow-900/20 p-6 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-300 mb-3">
              Job completed but no generated images found.
            </p>
            {isAutomaticMode ? (
              <button
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    await fetch(`/api/jobs/${job.id}/check-batch`, { method: "POST" });
                    await fetchJobDetails();
                  } catch (err) {
                    console.error("Failed to refresh from worker", err);
                  }
                  setRefreshing(false);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium disabled:opacity-60"
                disabled={refreshing}
              >
                {refreshing ? "Refreshing..." : "Fetch results again"}
              </button>
            ) : (
              <button
                onClick={refreshJobOnly}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium disabled:opacity-60"
                disabled={checkingBatch}
              >
                {checkingBatch ? "Refreshing..." : "Refresh page state"}
              </button>
            )}
          </div>
        )}

        {generatedImages.length > 0 && generatedImages.length < expectedImages && (
          <div className="bg-yellow-50 dark:bg-yellow-900/20 p-6 rounded-lg mt-4">
            <p className="text-yellow-800 dark:text-yellow-300 mb-3">
              Generated {generatedImages.length}/{expectedImages} images. You can fetch again to check for more results.
            </p>
            {isAutomaticMode ? (
              <button
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    await fetch(`/api/jobs/${job.id}/check-batch`, { method: "POST" });
                    await fetchJobDetails();
                  } catch (err) {
                    console.error("Failed to refresh from worker", err);
                  }
                  setRefreshing(false);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium disabled:opacity-60"
                disabled={refreshing}
              >
                {refreshing ? "Refreshing..." : "Fetch results again"}
              </button>
            ) : (
              <button
                onClick={refreshJobOnly}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium disabled:opacity-60"
                disabled={checkingBatch}
              >
                {checkingBatch ? "Refreshing..." : "Refresh page state"}
              </button>
            )}
          </div>
        )}

        {job.status === "processing" && generatedImages.length < expectedImages && (
          <div className="bg-blue-50 dark:bg-blue-900/20 p-6 rounded-lg">
            <p className="text-blue-800 dark:text-blue-300">
              {isAutomaticMode
                ? "Job is currently processing. Refresh the page to see updates."
                : "Job is processing on the worker. Refresh the page in a bit to see new images."}
            </p>
            {isAutomaticMode ? (
              <button
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    await fetch(`/api/jobs/${job.id}/check-batch`, { method: "POST" });
                    await fetchJobDetails();
                  } finally {
                    setRefreshing(false);
                  }
                }}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60"
                disabled={refreshing}
              >
                {refreshing ? "Refreshing..." : "Fetch results again"}
              </button>
            ) : (
              <button
                onClick={refreshJobOnly}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60"
                disabled={checkingBatch}
              >
                {checkingBatch ? "Refreshing..." : "Refresh page state"}
              </button>
            )}
          </div>
        )}

        {job.status === "failed" && (
          <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-lg mt-4">
            <p className="text-red-800 dark:text-red-300">
              Job failed: {job.error || "worker/network error"}
            </p>
          </div>
        )}

        {job.status === "batch_submitted" && job.mode === "automatic" && (
          <div className="bg-purple-50 dark:bg-purple-900/20 p-6 rounded-lg">
            <p className="text-purple-800 dark:text-purple-300 mb-2">
              Batch job has been submitted to Gemini. It may take some time to complete.
            </p>
            <p className="text-sm text-purple-700 dark:text-purple-400 mb-4">
              Click the button below to check if the batch job has completed.
            </p>
            <button
              onClick={checkBatchStatus}
              disabled={checkingBatch}
              className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {checkingBatch ? (
                <>
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Checking...
                </>
              ) : (
                <>
                  <span>🔄</span>
                  Check Batch Status
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
