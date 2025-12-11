"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function AutomaticPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [prompt, setPrompt] = useState("");
  const [numVariations, setNumVariations] = useState(4);
  const [model, setModel] = useState("gemini-3-pro-image-preview");
  const [resolution, setResolution] = useState("1K");
  const [aspectRatios, setAspectRatios] = useState<string[]>(["1:1"]);
  const [promptCombos, setPromptCombos] = useState(0);
  const [expandedPrompts, setExpandedPrompts] = useState<string[]>([]);
  const [groupId, setGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groups, setGroups] = useState<Array<{ id: string; name: string; jobCount?: number }>>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);

  const handleGroupNameChange = (value: string) => {
    setGroupName(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setGroupId("");
      return;
    }
    const found = groups.find(
      (g) => g.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (found) {
      setGroupId(found.id);
    } else {
      setGroupId("");
    }
  };
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
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

  // Recompute prompt combinations whenever prompt changes
  useEffect(() => {
    const combos = expandPromptTemplate(prompt);
    setExpandedPrompts(combos);
    setPromptCombos(combos.length);
  }, [prompt]);

  const createGroup = async (name?: string) => {
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || `Auto-${Date.now()}` }),
      });
      const resJson = await response.json();
      setGroupId(resJson.id);
      return resJson.id;
    } catch (error) {
      console.error("Failed to create group:", error);
      return null;
    }
  };

  // uploadImages function removed - now handled inline in handleSubmit for batch API

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0 || !prompt) {
      alert("Please select images and enter a prompt");
      return;
    }

    if (promptCombos === 0) {
      alert("Prompt is empty after parsing. Please enter a prompt.");
      return;
    }

    setLoading(true);
    setJobId(null); // hide success banner until submission actually succeeds
    try {
      // Create group if needed
      let currentGroupId = groupId;
      if (!currentGroupId) {
        currentGroupId = await createGroup(groupName || undefined);
        if (!currentGroupId) {
          throw new Error("Failed to create group");
        }
      }

      // Generate jobId with resolution + aspect ratio for easy identification
      const ratioSlug = (aspectRatios[0] || "1:1").replace(/:/g, "x");
      const generatedJobId = `job_${(resolution || "res").toLowerCase()}_${ratioSlug}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      // Presign GCS URLs then upload directly from client
      const presignRes = await fetch("/api/upload/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: generatedJobId,
          files: files.map((f, idx) => ({
            index: idx,
            filename: f.name,
            contentType: f.type || "image/jpeg",
          })),
        }),
      });
      if (!presignRes.ok) {
        throw new Error("Failed to presign upload URLs");
      }
      const { uploads } = await presignRes.json();
      // Upload each file with fetch PUT
      await Promise.all(
        uploads.map(async (u: any) => {
          const file = files[u.index];
          await fetch(u.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": u.contentType },
            body: file,
          });
        })
      );

      const gcsFiles = uploads.map((u: any) => ({
        index: u.index,
        gcsPath: u.filePath,
        contentType: u.contentType,
        publicUrl: u.publicUrl,
      }));

      // Submit batch job directly to Gemini (Next.js, not RunPod)
      const response = await fetch("/api/jobs/submit-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: currentGroupId,
          jobId: generatedJobId,
          folder: `${generatedJobId}/upload`,
          prompts: expandedPrompts,
          prompt_template: prompt,
          model: model,
          gcs_files: gcsFiles,
          config: {
            num_variations: numVariations,
            ...(model === "gemini-3-pro-image-preview" && {
              resolution,
              aspect_ratio: aspectRatios[0] || "1:1",
              aspect_ratios: aspectRatios,
            }),
          },
        }),
      });

      await response.json();
      setJobId(generatedJobId); // show success banner only after all API calls succeed
      
      // Clear form state
      setFiles([]);
      setPrompt("");
      setNumVariations(4);
      setModel("gemini-3-pro-image-preview");
      setResolution("1K");
      setAspectRatios(["1:1"]);
      setPromptCombos(0);
      setExpandedPrompts([]);
      setFileInputKey(prev => prev + 1); // Reset file input
      
      // Keep jobId for redirect, but clear groupId/name
      // groupId will be available in job detail page
      setGroupName("");
      
      // Redirect to job detail page after a short delay
      setTimeout(() => {
        router.push(`/jobs/${generatedJobId}`);
      }, 1000);
    } catch (error) {
      console.error("Failed to submit job:", error);
      alert("Failed to submit job");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-blue-50/30 to-purple-50/30 dark:from-black dark:via-zinc-950 dark:to-zinc-900 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-3xl">⚡</span>
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-2">
            Automatic Mode
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Batch process large image sets with AI-powered variations
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Group selection / naming */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">🗂️</span>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Group
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Select an existing group or enter a new name (empty = Auto-[timestamp]).
                </p>
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
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Choose existing group
                </label>
                <select
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    if (e.target.value) setGroupName(""); // clear name when picking existing
                  }}
                  className="w-full mt-1 p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-amber-500 dark:focus:border-amber-500 focus:outline-none"
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
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Or enter a new group name
                </label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => handleGroupNameChange(e.target.value)}
                  placeholder="e.g., Project A - background set"
                  className="w-full mt-1 p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-amber-500 dark:focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:focus:ring-amber-900/40 transition-all"
                  disabled={loading}
                />
              </div>
            </div>
          </div>
          {/* Upload Images Card */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">📤</span>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Upload Images
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Multiple files supported</p>
              </div>
            </div>
            <div className="relative">
              <input
                key={fileInputKey}
                type="file"
                multiple
                accept="image/*"
                onChange={handleFileChange}
                className="w-full p-3 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 hover:border-blue-400 dark:hover:border-blue-600 focus:border-blue-500 dark:focus:border-blue-500 focus:outline-none transition-colors cursor-pointer"
                disabled={loading}
              />
              {files.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-sm text-gray-400 dark:text-gray-500">Click or drag files here</span>
                </div>
              )}
            </div>
            {files.length > 0 && (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className="px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full font-medium">
                  ✓ {files.length} file{files.length > 1 ? 's' : ''} selected
                </span>
              </div>
            )}
          </div>

          {/* Prompt Card */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">✍️</span>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Prompt
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Describe the variations you want</p>
              </div>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full p-4 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-purple-500 dark:focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:focus:ring-purple-900/50 transition-all resize-none"
              rows={5}
              placeholder="e.g., Transform the background into a warm sunset scene. Add soft orange and pink sky tones..."
              disabled={loading}
            />
            {prompt.length > 0 && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {prompt.length} characters · {promptCombos || 1} prompt
                {promptCombos > 1 ? "s" : ""}
              </p>
            )}
            {promptCombos > 1 && (
              <div className="mt-3 text-xs text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-3">
                Detected {promptCombos} prompt variants from braces. They will be assigned to images in order (round-robin), not multiplied.
                <ul className="list-disc ml-4 mt-2 space-y-1">
                  {expandedPrompts.slice(0, 3).map((p, idx) => (
                    <li key={idx} className="font-mono text-[11px] break-words">{p}</li>
                  ))}
                  {expandedPrompts.length > 3 && <li className="italic">...and {expandedPrompts.length - 3} more</li>}
                </ul>
              </div>
            )}
          </div>

          {/* Variations & Model Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Variations Card */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                  <span className="text-xl">🔄</span>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Variations per Image
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">How many variations?</p>
                </div>
              </div>
              <input
                type="number"
                value={numVariations}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 1;
                  setNumVariations(Math.max(1, Math.min(20, value)));
                }}
                className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-green-500 dark:focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-200 dark:focus:ring-green-900/50 transition-all text-center text-lg font-semibold"
                min="1"
                max="20"
                disabled={loading}
              />
                <div className="mt-3 p-3 bg-gradient-to-r from-green-50 to-blue-50 dark:from-green-900/20 dark:to-blue-900/20 rounded-lg">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Total requests:{" "}
                    <span className="text-green-600 dark:text-green-400 font-bold">
                    {Math.max(files.length, promptCombos || 1)} outputs × {numVariations} variations × {aspectRatios.length} ratios ={" "}
                    {Math.max(files.length, promptCombos || 1) * numVariations * aspectRatios.length}
                    </span>
                  </p>
                  {promptCombos > 1 && (
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                      Prompt variants will be cycled across outputs (round-robin), not multiplied.
                    </p>
                  )}
              </div>
            </div>

            {/* Model Card */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                  <span className="text-xl">🤖</span>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                    AI Model
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Choose your model</p>
                </div>
              </div>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-orange-500 dark:focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-200 dark:focus:ring-orange-900/50 transition-all"
                disabled={loading}
              >
              <option value="gemini-2.5-flash-image" title="Optimized for high-volume, low-latency tasks. Generates 1024px images quickly.">
                Gemini 2.5 Flash Image (Default - Fast, 1024px)
              </option>
              <option value="gemini-3-pro-image-preview" title="Professional asset production with real-world grounding using Google Search. Supports up to 4K resolution with advanced 'Thinking' process.">
                Gemini 3 Pro Image Preview (4K, Search-grounded)
              </option>
              </select>
              {model === "gemini-3-pro-image-preview" && (
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                      Resolution
                    </label>
                    <select
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      className="w-full p-2 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-orange-500 dark:focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-200 dark:focus:ring-orange-900/50 transition-all text-sm"
                      disabled={loading}
                    >
                      <option value="1K">1K (Default)</option>
                      <option value="2K">2K</option>
                      <option value="4K">4K</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                      Aspect Ratios (multi-select)
                    </label>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {[
                        "1:1",
                        "2:3",
                        "3:2",
                        "3:4",
                        "4:3",
                        "4:5",
                        "5:4",
                        "9:16",
                        "16:9",
                        "21:9",
                      ].map((ratio) => {
                        const checked = aspectRatios.includes(ratio);
                        return (
                          <label
                            key={ratio}
                            className={`flex items-center gap-2 border rounded-lg px-3 py-2 cursor-pointer ${
                              checked
                                ? "border-orange-500 bg-orange-50 dark:bg-orange-900/20"
                                : "border-gray-200 dark:border-zinc-700"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setAspectRatios((prev) =>
                                  checked
                                    ? prev.filter((r) => r !== ratio)
                                    : [...prev, ratio]
                                );
                              }}
                              className="accent-orange-500"
                              disabled={loading}
                            />
                            <span>{ratio}</span>
                          </label>
                        );
                      })}
                    </div>
                    {aspectRatios.length === 0 && (
                      <p className="text-xs text-red-600 mt-1">Select at least one ratio.</p>
                    )}
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                💡 Hover over options for details
              </p>
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
          disabled={loading || files.length === 0 || !prompt}
            className="w-full py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold rounded-xl shadow-lg hover:shadow-xl transform hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:hover:shadow-lg flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Processing...
              </>
            ) : (
              <>
                <span className="text-xl">✨</span>
                Generate {files.length * numVariations * aspectRatios.length * (promptCombos || 1)} Images
              </>
            )}
          </button>
        </form>

        {jobId && (
          <div className="mt-6 p-6 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 rounded-xl border-2 border-blue-200 dark:border-blue-800 shadow-lg animate-pulse">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-2xl">✓</span>
              </div>
              <div className="flex-1">
                <p className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">
                  Job Submitted Successfully! 🎉
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  Your job is being processed. Redirecting to job details...
                </p>
                <button
                  onClick={() => router.push(`/jobs/${jobId}`)}
                  className="px-6 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white rounded-lg font-medium shadow-md hover:shadow-lg transform hover:scale-105 transition-all flex items-center gap-2"
                >
                  <span>View Job Details</span>
                  <span>→</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Expand prompt variables defined as comma-separated lists inside curly braces.
// Example: "a {red, blue} {cat, dog}" -> ["a red cat", "a red dog", "a blue cat", "a blue dog"]
function expandPromptTemplate(template: string): string[] {
  if (!template) return [];
  const regex = /\{([^{}]+)\}/g;
  const segments: string[] = [];
  const variables: string[][] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    segments.push(template.slice(lastIndex, match.index));
    const options = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    variables.push(options.length ? options : [""]);
    lastIndex = regex.lastIndex;
  }
  segments.push(template.slice(lastIndex));

  if (!variables.length) return [template];

  const results: string[] = [];
  const build = (idx: number, current: string) => {
    if (idx === variables.length) {
      results.push(current + segments[idx]);
      return;
    }
    for (const opt of variables[idx]) {
      build(idx + 1, current + segments[idx] + opt);
    }
  };
  build(0, "");
  return results;
}
