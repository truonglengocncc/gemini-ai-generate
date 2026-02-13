"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type ParsedDocs = {
  prompt: string;
  numImages: number;
  imageRatio: string;
  variationsPerImage: number;
  resolution: string;
} | null;

function parseDocsContent(text: string): ParsedDocs | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let prompt = "";
  let numImages = 1;
  let imageRatio = "1:1";
  let variationsPerImage = 1;
  let resolution = "1K";

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (/^Prompt$/i.test(key)) prompt = value;
    else if (/^Number of Images$/i.test(key)) numImages = Math.max(1, parseInt(value, 10) || 1);
    else if (/^Image Ratio$/i.test(key)) imageRatio = value || "1:1";
    else if (/^Variations per Image$/i.test(key)) variationsPerImage = Math.max(1, parseInt(value, 10) || 1);
    else if (/^Resolution$/i.test(key)) resolution = value || "1K";
  }

  if (!prompt) return null;
  return { prompt, numImages, imageRatio, variationsPerImage, resolution };
}

const REQUIRED_DOCS_KEYS = ["Prompt", "Number of Images", "Image Ratio", "Variations per Image", "Resolution"] as const;

function getMissingDocsVars(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = new Set<string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    for (const required of REQUIRED_DOCS_KEYS) {
      if (new RegExp(`^${required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(key)) {
        found.add(required);
        break;
      }
    }
  }
  return REQUIRED_DOCS_KEYS.filter((k) => !found.has(k));
}

export default function DocsAutomaticPage() {
  const router = useRouter();
  const [docsFile, setDocsFile] = useState<File | null>(null);
  const [docsText, setDocsText] = useState("");
  const [gcsInputPath, setGcsInputPath] = useState("");
  const [parsed, setParsed] = useState<ParsedDocs | null>(null);
  const [groupId, setGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groups, setGroups] = useState<Array<{ id: string; name: string; jobCount?: number }>>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [model, setModel] = useState("gemini-3-pro-image-preview");
  const [googleDocsUrl, setGoogleDocsUrl] = useState("");
  const [loadingGoogleDoc, setLoadingGoogleDoc] = useState(false);

  const handleDocsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setDocsFile(file);
      const reader = new FileReader();
      reader.onload = () => setDocsText(String(reader.result ?? ""));
      reader.readAsText(file);
    }
  };

  useEffect(() => {
    setParsed(docsText ? parseDocsContent(docsText) : null);
  }, [docsText]);

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

  const loadFromGoogleDoc = async () => {
    const url = googleDocsUrl.trim();
    if (!url) {
      alert("Please paste a Google Docs link (e.g. https://docs.google.com/document/d/.../edit)");
      return;
    }
    setLoadingGoogleDoc(true);
    try {
      const res = await fetch("/api/docs/fetch-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Could not load content");
        return;
      }
      setDocsText(data.content ?? "");
      setDocsFile(null);
    } catch (e) {
      console.error(e);
      alert("Error loading Google Docs");
    } finally {
      setLoadingGoogleDoc(false);
    }
  };

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
    const pathTrimmed = gcsInputPath.trim();
    if (!pathTrimmed) {
      alert("Please enter GCS path (e.g. gs://capsure/gemini-generate/test_docs_generate/midjourney)");
      return;
    }

    setLoading(true);
    setJobId(null);
    try {
      // Auto-fetch from Google Docs URL when user pasted a link and clicks Run (no need to click Load content)
      let contentToUse = docsText.trim();
      const urlTrimmed = googleDocsUrl.trim();
      if (urlTrimmed) {
        const res = await fetch("/api/docs/fetch-google", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: urlTrimmed }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || "Could not load document from link");
          setLoading(false);
          return;
        }
        contentToUse = data.content ?? "";
      }
      const resolvedParsed = contentToUse ? parseDocsContent(contentToUse) : parsed;
      if (!resolvedParsed) {
        alert("Please paste a Google Docs link, upload a file, or paste content with format: Prompt:, Number of Images:, ...");
        setLoading(false);
        return;
      }
      const missingVars = getMissingDocsVars(contentToUse);
      if (missingVars.length > 0) {
        alert("File is missing required variables:\n\n" + missingVars.join("\n") + "\n\nPlease add them in the correct format (e.g. Prompt: ..., Number of Images: 1, ...) and run again.");
        setLoading(false);
        return;
      }

      let currentGroupId = groupId;
      if (!currentGroupId) {
        currentGroupId = await createGroup(groupName || undefined);
        if (!currentGroupId) throw new Error("Failed to create group");
      }

      const response = await fetch("/api/jobs/submit-docs-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: currentGroupId,
          docsContent: contentToUse,
          gcsInputPath: pathTrimmed,
          parsed: {
            prompt: resolvedParsed.prompt,
            numImages: resolvedParsed.numImages,
            imageRatio: resolvedParsed.imageRatio,
            variationsPerImage: resolvedParsed.variationsPerImage,
            resolution: resolvedParsed.resolution,
          },
          model,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Submit failed");

      setJobId(data.jobId);
      setDocsFile(null);
      setDocsText("");
      setParsed(null);
      setGcsInputPath("");
      setGroupName("");

      setTimeout(() => router.push(`/jobs/${data.jobId}`), 1000);
    } catch (error: any) {
      console.error("Failed to submit job:", error);
      alert(error.message || "Failed to submit job");
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
            Load prompt, image count, ratio, and resolution from a docs file; input images from GCS; results saved to a gemini folder at the same level
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
                <p className="text-xs text-gray-500 dark:text-gray-400">Select an existing group or enter a new name</p>
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

          {/* GCS path */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">📁</span>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">GCS path (input images)</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Folder containing input images: gs://bucket/path/ (e.g. gs://capsure/gemini-generate/test_docs_generate/midjourney) or relative path. Results are saved to a gemini folder at the same level.</p>
              </div>
            </div>
            <input
              type="text"
              value={gcsInputPath}
              onChange={(e) => setGcsInputPath(e.target.value)}
              placeholder="gs://capsure/gemini-generate/test_docs_generate/midjourney"
              className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-blue-500"
              disabled={loading}
            />
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

          {/* Docs content (below, before Submit) */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-teal-100 dark:bg-teal-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">📄</span>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">Docs content</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Google Docs link, upload file, or paste content. Format: Prompt:, Number of Images:, Image Ratio:, Variations per Image:, Resolution:</p>
              </div>
            </div>

            {/* Link Google Docs */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Link Google Docs</label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={googleDocsUrl}
                  onChange={(e) => setGoogleDocsUrl(e.target.value)}
                  placeholder="https://docs.google.com/document/d/.../edit"
                  className="flex-1 p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-teal-500"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={loadFromGoogleDoc}
                  disabled={loading || loadingGoogleDoc}
                  className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-medium whitespace-nowrap flex items-center gap-2"
                >
                  {loadingGoogleDoc ? (
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : null}
                  Load content
                </button>
              </div>
            </div>

            {/* Upload file */}
            <div className="mb-3">
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Or upload file</label>
              <input
                type="file"
                accept=".txt,.md,text/*"
                onChange={handleDocsChange}
                className="w-full p-3 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50"
                disabled={loading}
              />
            </div>

            <textarea
              value={docsText}
              onChange={(e) => setDocsText(e.target.value)}
              className="w-full p-4 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-teal-500 resize-none"
              rows={6}
              placeholder={'Prompt: Transform the background...\nNumber of Images: 1\nImage Ratio: 1:1\nVariations per Image: 1\nResolution: 1K'}
              disabled={loading}
            />
            {parsed && (
              <div className="mt-3 p-3 bg-teal-50 dark:bg-teal-900/20 rounded-lg text-sm">
                <p className="font-medium text-gray-900 dark:text-gray-100">Parsed:</p>
                <p>Prompt: {parsed.prompt.slice(0, 80)}{parsed.prompt.length > 80 ? "…" : ""}</p>
                <p>Number of Images: {parsed.numImages} · Ratio: {parsed.imageRatio} · Variations: {parsed.variationsPerImage} · Resolution: {parsed.resolution}</p>
              </div>
            )}
            {docsText && !parsed && (
              <p className="mt-2 text-xs text-amber-600">No &quot;Prompt: ...&quot; line found. Check file format.</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !gcsInputPath.trim() || (!docsText.trim() && !googleDocsUrl.trim())}
            className="w-full py-4 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-700 hover:to-cyan-700 text-white font-semibold rounded-xl shadow-lg hover:shadow-xl transform hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Processing...
              </>
            ) : (
              <>
                <span className="text-xl">✨</span>
                Run Docs Automatic
              </>
            )}
          </button>
        </form>

        {jobId && (
          <div className="mt-6 p-6 bg-gradient-to-r from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/20 rounded-xl border-2 border-teal-200 dark:border-teal-800 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-2xl">✓</span>
              </div>
              <div className="flex-1">
                <p className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">Job submitted successfully</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Redirecting to job page...</p>
                <button
                  onClick={() => router.push(`/jobs/${jobId}`)}
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
