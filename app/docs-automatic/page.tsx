"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseSheet, type SheetRow } from "@/lib/sheetParse";
import { expandPromptTemplate } from "@/lib/promptExpand";

const GOOGLE_SHEET_URL_REGEX = /docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+/;

export default function DocsAutomaticPage() {
  const router = useRouter();
  const [sheetText, setSheetText] = useState("");
  const [reviewRows, setReviewRows] = useState<SheetRow[] | null>(null);
  const [reviewErrors, setReviewErrors] = useState<string[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groups, setGroups] = useState<Array<{ id: string; name: string; jobCount?: number }>>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [model, setModel] = useState("gemini-3-pro-image-preview");
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [loadingSheet, setLoadingSheet] = useState(false);
  const [viewRowIndex, setViewRowIndex] = useState<number | null>(null);
  const autoLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFromGoogleSheet = async (urlOverride?: string) => {
    const url = (urlOverride ?? googleSheetUrl).trim();
    if (!url) {
      if (!urlOverride) alert("Please paste a Google Sheet link (e.g. https://docs.google.com/spreadsheets/d/.../edit)");
      return;
    }
    if (!GOOGLE_SHEET_URL_REGEX.test(url)) return;
    setLoadingSheet(true);
    try {
      const res = await fetch("/api/docs/fetch-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Could not load sheet");
        return;
      }
      const content = data.content ?? "";
      setSheetText(content);
      const { rows, errors } = parseSheet(content);
      setReviewRows(rows);
      setReviewErrors(errors);
      setShowReview(true);
    } catch (e) {
      console.error(e);
      alert("Error loading Google Sheet");
    } finally {
      setLoadingSheet(false);
    }
  };

  useEffect(() => {
    const url = googleSheetUrl.trim();
    if (!url || !GOOGLE_SHEET_URL_REGEX.test(url)) return;
    if (autoLoadTimerRef.current) clearTimeout(autoLoadTimerRef.current);
    autoLoadTimerRef.current = setTimeout(() => {
      autoLoadTimerRef.current = null;
      loadFromGoogleSheet(url);
    }, 700);
    return () => {
      if (autoLoadTimerRef.current) clearTimeout(autoLoadTimerRef.current);
    };
  }, [googleSheetUrl]);

  const handleReviewSheet = () => {
    const { rows, errors } = parseSheet(sheetText);
    setReviewRows(rows);
    setReviewErrors(errors);
    setShowReview(true);
  };

  const handleGroupNameChange = (value: string) => {
    setGroupName(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setGroupId("");
      return;
    }
    const found = groups.find((g) => g.name.toLowerCase() === trimmed.toLowerCase());
    if (found) setGroupId(found.id);
    else setGroupId("");
  };

  const loadGroups = async () => {
    try {
      setGroupsLoading(true);
      const res = await fetch("/api/groups");
      if (!res.ok) return;
      const data = await res.json();
      setGroups(data.groups || []);
    } catch (error) {
      console.error("Failed to load groups:", error);
    } finally {
      setGroupsLoading(false);
    }
  };

  useEffect(() => {
    loadGroups();
  }, []);

  const createGroup = async (name?: string) => {
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || `DocsAuto-${Date.now()}` }),
      });
      const resJson = await response.json();
      setGroupId(resJson.id);
      return resJson.id;
    } catch (error) {
      console.error("Failed to create group:", error);
      return null;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { rows, errors } = parseSheet(sheetText.trim());
    if (rows.length === 0) {
      alert(errors.length ? errors.join("\n") : "Paste a sheet with columns: FILE, Prompt, Images, Ratio, Variations, Resolution. Each row = one job.");
      return;
    }

    setLoading(true);
    setJobIds([]);
    try {
      let currentGroupId = groupId;
      if (!currentGroupId) {
        currentGroupId = await createGroup(groupName || undefined);
        if (!currentGroupId) throw new Error("Failed to create group");
      }

      const submitted: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const response = await fetch("/api/jobs/submit-docs-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupId: currentGroupId,
            gcsInputPath: row.file,
            parsed: {
              prompt: row.prompt,
              prompts: expandPromptTemplate(row.prompt),
              numImages: row.numImages,
              imageRatio: row.imageRatio,
              variationsPerImage: row.variationsPerImage,
              resolution: row.resolution,
            },
            model,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Job ${i + 1} failed`);
        submitted.push(data.jobId);
      }

      setJobIds(submitted);
      setSheetText("");
      setReviewRows(null);
      setReviewErrors([]);
      setShowReview(false);
      setGroupName("");
      setTimeout(() => router.push(`/jobs/${submitted[0]}`), 1000);
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error("Failed to submit jobs:", error);
      alert(err.message || "Failed to submit jobs");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-blue-50/30 to-purple-50/30 dark:from-black dark:via-zinc-950 dark:to-zinc-900 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-teal-500 to-cyan-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-3xl">📄</span>
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-teal-600 to-cyan-600 bg-clip-text text-transparent mb-2">
            Docs Automatic Mode
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Paste a sheet (TSV/CSV) with columns: FILE, Prompt, Images, Ratio, Variations, Resolution. Each row = one generate job; GCS link from FILE column.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Group */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">🗂️</span>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">Group</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Select an existing group or enter a new group name (all jobs in the sheet share one group)</p>
              </div>
              <button
                type="button"
                onClick={loadGroups}
                disabled={groupsLoading || loading}
                className="text-xs px-3 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
              >
                {groupsLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">Select group</label>
                <select
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    if (e.target.value) setGroupName("");
                  }}
                  className="w-full mt-1 p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-amber-500"
                  disabled={loading}
                >
                  <option value="">-- Create new group --</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} {g.jobCount ? `(${g.jobCount} jobs)` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">Or enter new group name</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => handleGroupNameChange(e.target.value)}
                  placeholder="e.g., Docs batch 1"
                  className="w-full mt-1 p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-amber-500"
                  disabled={loading}
                />
              </div>
            </div>
          </div>

          {/* Sheet paste */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-teal-100 dark:bg-teal-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">📋</span>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">Sheet (paste from Excel / Google Sheets)</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Columns: FILE (gs://... link), Prompt, Images, Ratio, Variations, Resolution. First row may be header. Each row = one generate job.</p>
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Or load from Google Sheet URL</label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={googleSheetUrl}
                  onChange={(e) => setGoogleSheetUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                  className="flex-1 p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-teal-500"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => loadFromGoogleSheet()}
                  disabled={loading || loadingSheet}
                  className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-medium whitespace-nowrap flex items-center gap-2"
                >
                  {loadingSheet ? (
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : null}
                  Load
                </button>
              </div>
            </div>
            {showReview && reviewRows !== null && (
              <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 dark:border-zinc-700 max-h-80 overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-100 dark:bg-zinc-800 sticky top-0">
                    <tr>
                      <th className="p-2 font-semibold">#</th>
                      <th className="p-2 font-semibold">FILE</th>
                      <th className="p-2 font-semibold">Prompt</th>
                      <th className="p-2 font-semibold">Images</th>
                      <th className="p-2 font-semibold">Ratio</th>
                      <th className="p-2 font-semibold">Variations</th>
                      <th className="p-2 font-semibold">Resolution</th>
                      <th className="p-2 font-semibold w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewRows.map((row, idx) => (
                      <tr key={idx} className="border-t border-gray-200 dark:border-zinc-700">
                        <td className="p-2">{idx + 1}</td>
                        <td className="p-2 font-mono text-xs max-w-[180px] truncate" title={row.file}>{row.file}</td>
                        <td className="p-2 max-w-[200px] truncate" title={row.prompt}>{row.prompt}</td>
                        <td className="p-2">{row.numImages}</td>
                        <td className="p-2">{row.imageRatio}</td>
                        <td className="p-2">{row.variationsPerImage}</td>
                        <td className="p-2">{row.resolution}</td>
                        <td className="p-2">
                          <button
                            type="button"
                            onClick={() => setViewRowIndex(idx)}
                            className="cursor-pointer text-xs px-2 py-1 rounded border border-teal-300 dark:border-teal-700 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/30"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {viewRowIndex !== null && reviewRows[viewRowIndex] && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setViewRowIndex(null)}>
                    <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-gray-200 dark:border-zinc-700 max-w-lg w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Row {viewRowIndex + 1} details</h3>
                        <button type="button" onClick={() => setViewRowIndex(null)} className="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1">✕</button>
                      </div>
                      {(() => {
                        const row = reviewRows[viewRowIndex]!;
                        const expanded = expandPromptTemplate(row.prompt);
                        return (
                          <div className="space-y-4 text-sm">
                            <div><span className="font-semibold text-gray-600 dark:text-gray-400">FILE:</span><br /><span className="font-mono text-xs break-all">{row.file}</span></div>
                            <div><span className="font-semibold text-gray-600 dark:text-gray-400">Prompt:</span><br /><span className="break-words">{row.prompt}</span></div>
                            <div className="grid grid-cols-2 gap-2">
                              <div><span className="font-semibold text-gray-600 dark:text-gray-400">Images:</span> {row.numImages}</div>
                              <div><span className="font-semibold text-gray-600 dark:text-gray-400">Ratio:</span> {row.imageRatio}</div>
                              <div><span className="font-semibold text-gray-600 dark:text-gray-400">Variations:</span> {row.variationsPerImage}</div>
                              <div><span className="font-semibold text-gray-600 dark:text-gray-400">Resolution:</span> {row.resolution}</div>
                            </div>
                            {expanded.length > 1 ? (
                              <div className="text-xs text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-3">
                                <p className="font-medium mb-2">Detected {expanded.length} prompt variants from braces. Assigned to images in order (round-robin).</p>
                                <ul className="list-disc ml-4 space-y-1">
                                  {expanded.map((p, i) => (
                                    <li key={i} className="font-mono text-[11px] break-words">{p}</li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
                {reviewErrors.length > 0 && (
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 text-xs border-t border-amber-200 dark:border-amber-800">
                    {reviewErrors.map((err, i) => (
                      <div key={i}>{err}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Model */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6">
            <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50"
              disabled={loading}
            >
              <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
              <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image Preview (4K)</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={loading || !sheetText.trim() || (reviewRows !== null && reviewRows.length === 0)}
            className="w-full py-4 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-700 hover:to-cyan-700 text-white font-semibold rounded-xl shadow-lg hover:shadow-xl transform hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Submitting {reviewRows?.length ?? 0} job(s)...
              </>
            ) : (
              <>
                <span className="text-xl">✨</span>
                Run Docs Automatic{reviewRows && reviewRows.length > 0 ? ` (${reviewRows.length} job(s))` : ""}
              </>
            )}
          </button>
        </form>

        {jobIds.length > 0 && (
          <div className="mt-6 p-6 bg-gradient-to-r from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/20 rounded-xl border-2 border-teal-200 dark:border-teal-800 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-2xl">✓</span>
              </div>
              <div className="flex-1">
                <p className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">Submitted {jobIds.length} job(s)</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Redirecting to first job...</p>
                <button
                  onClick={() => router.push(`/jobs/${jobIds[0]}`)}
                  className="px-6 py-2.5 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-700 hover:to-cyan-700 text-white rounded-lg font-medium"
                >
                  View job
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
