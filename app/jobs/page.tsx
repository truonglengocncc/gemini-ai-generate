"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Job {
  id: string;
  mode: string;
  status: string;
  images: string[];
  prompts: any;
  config: any;
  results: any;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  group: {
    id: string;
    name: string;
  };
}

interface JobsResponse {
  jobs: Job[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  error?: string;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const fetchJobs = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
      });
      if (statusFilter) {
        params.append("status", statusFilter);
      }

      const response = await fetch(`/api/jobs?${params}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch jobs: ${response.statusText}`);
      }
      
      const data: JobsResponse = await response.json();

      // Handle error response
      if (data.error) {
        throw new Error(data.error);
      }

      // Ensure data structure exists
      if (data.jobs) {
        setJobs(data.jobs);
      }
      
      if (data.pagination?.totalPages !== undefined) {
        setTotalPages(data.pagination.totalPages);
      } else {
        // Fallback: calculate from jobs length if pagination missing
        setTotalPages(1);
      }
    } catch (error) {
      console.error("Error fetching jobs:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, [page, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getTotalGenerated = (job: Job) => {
    if (!job.results) return 0;
    if (job.results.total_generated) {
      return job.results.total_generated;
    }
    if (job.results.results) {
      return job.results.results.filter((r: any) => r.gcs_url || r.image).length;
    }
    return 0;
  };

  const retryFetch = async (jobId: string, mode: string, useSaved: boolean) => {
    try {
      const url =
        mode === "automatic" ? "/api/jobs/submit-batch" : "/api/jobs/submit";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, retry: true, use_preuploaded: useSaved }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Retry failed");
        return;
      }
      alert("Retry submitted. Please refresh in a moment.");
      await fetchJobs();
    } catch (e) {
      console.error("Retry failed", e);
      alert("Retry failed. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Generated Jobs</h1>
          <div className="flex gap-2">
            <button
              onClick={fetchJobs}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="rounded border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 px-3 py-2"
            >
            <option value="">All Status</option>
            <option value="queued">Queued</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-900 dark:text-gray-100 flex flex-col items-center gap-3">
          <div className="h-10 w-10 border-4 border-blue-500/40 border-t-blue-600 rounded-full animate-spin" />
          <span className="text-lg font-medium">Loading jobs...</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">No jobs found</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700">
              <thead className="bg-gray-50 dark:bg-zinc-800">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Job ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Group
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Mode
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Images
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Generated
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Completed
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-zinc-900 divide-y divide-gray-200 dark:divide-zinc-700">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-gray-50 dark:hover:bg-zinc-800">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono">
                      <Link
                        href={`/jobs/${job.id}`}
                        className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-200"
                      >
                        {job.id.substring(0, 8)}...
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      <Link
                        href={`/groups/${job.group.id}`}
                        className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-200"
                      >
                        {job.group.name}
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                      {job.mode}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(
                          job.status
                        )}`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                      {job.images.length}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                      {job.status === "completed" ? getTotalGenerated(job) : "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                      {formatDate(job.createdAt)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                      {job.completedAt ? formatDate(job.completedAt) : "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="relative">
                        <button
                          onClick={() => setOpenMenu((prev) => (prev === job.id ? null : job.id))}
                          className="px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-zinc-800"
                          aria-label="Actions"
                        >
                          ⋮
                        </button>
                        {openMenu === job.id && (
                          <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded shadow-lg z-20">
                            <Link
                              href={`/jobs/${job.id}`}
                              onClick={() => setOpenMenu(null)}
                              className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-zinc-800 text-blue-600 dark:text-blue-300"
                            >
                              View details
                            </Link>
                            {job.status === "failed" && (
                              <>
                                <button
                                  onClick={() => {
                                    setOpenMenu(null);
                                    fetch(`/api/jobs/${job.id}/check-batch`, { method: "POST" }).then(fetchJobs);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-zinc-800 text-purple-600 dark:text-purple-300"
                                >
                                  Fetch results
                                </button>
                                <button
                                  onClick={() => {
                                    setOpenMenu(null);
                                    retryFetch(job.id, job.mode, false);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-zinc-800 text-blue-600"
                                >
                                  Retry full
                                </button>
                                {job.config?.batch_src_files?.length > 0 && (
                                  <button
                                    onClick={() => {
                                      setOpenMenu(null);
                                      retryFetch(job.id, job.mode, true);
                                    }}
                                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-zinc-800 text-emerald-600"
                                  >
                                    Retry saved files
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-6 flex justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-4 py-2 border border-gray-300 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-zinc-700"
              >
                Previous
              </button>
              <span className="px-4 py-2 text-gray-900 dark:text-gray-100">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-4 py-2 border border-gray-300 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-zinc-700"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}
