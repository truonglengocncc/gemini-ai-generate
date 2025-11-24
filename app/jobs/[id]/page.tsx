"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

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

  useEffect(() => {
    if (id) {
      fetchJobDetails();
    }
  }, [id]);

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
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-300";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-black p-8 flex items-center justify-center">
        <p className="text-xl">Loading job details...</p>
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

  const generatedImages = job.results?.results?.map((r: any) => r.gcs_url).filter(Boolean) || [];

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
              <h3 className="text-lg font-semibold mb-2">Configuration</h3>
              <div className="bg-gray-50 dark:bg-zinc-800 p-4 rounded">
                <pre className="text-sm overflow-x-auto">
                  {JSON.stringify(job.config, null, 2)}
                </pre>
              </div>
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
            <h2 className="text-2xl font-bold mb-4">
              Uploaded Images ({job.images.length})
            </h2>
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
          </div>
        )}

        {/* Generated Images Section */}
        {generatedImages.length > 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-bold mb-4">
              Generated Images ({generatedImages.length})
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {job.results.results.map((result: any, idx: number) => (
                <div key={idx} className="relative group">
                  <img
                    src={result.gcs_url}
                    alt={`Generated ${idx + 1}`}
                    className="w-full h-48 object-cover rounded-lg border-2 border-green-200 dark:border-green-700"
                  />
                  <div className="absolute top-2 right-2 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded">
                    Var {result.variation}
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
        )}

        {job.status === "completed" && generatedImages.length === 0 && (
          <div className="bg-yellow-50 dark:bg-yellow-900/20 p-6 rounded-lg">
            <p className="text-yellow-800 dark:text-yellow-300">
              Job completed but no generated images found.
            </p>
          </div>
        )}

        {job.status === "processing" && (
          <div className="bg-blue-50 dark:bg-blue-900/20 p-6 rounded-lg">
            <p className="text-blue-800 dark:text-blue-300">
              Job is currently processing. Refresh the page to see updates.
            </p>
            <button
              onClick={fetchJobDetails}
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Refresh Status
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

