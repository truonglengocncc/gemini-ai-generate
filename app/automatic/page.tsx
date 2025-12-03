"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AutomaticPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [prompt, setPrompt] = useState("");
  const [numVariations, setNumVariations] = useState(4);
  const [model, setModel] = useState("gemini-3-pro-image-preview");
  const [resolution, setResolution] = useState("1K");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const createGroup = async () => {
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Auto-${Date.now()}` }),
      });
      const data = await response.json();
      setGroupId(data.id);
      return data.id;
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

    setLoading(true);
    try {
      // Create group if needed
      let currentGroupId = groupId;
      if (!currentGroupId) {
        currentGroupId = await createGroup();
        if (!currentGroupId) {
          throw new Error("Failed to create group");
        }
      }

      // Generate jobId first
      const generatedJobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setJobId(generatedJobId);

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
          prompts: [prompt],
          model: model,
          gcs_files: gcsFiles,
          config: {
            num_variations: numVariations,
            ...(model === "gemini-3-pro-image-preview" && { resolution, aspect_ratio: aspectRatio }),
          },
        }),
      });

      const data = await response.json();
      
      // Clear form state
      setFiles([]);
      setPrompt("");
      setNumVariations(4);
      setModel("gemini-3-pro-image-preview");
      setResolution("1K");
      setAspectRatio("1:1");
      setFileInputKey(prev => prev + 1); // Reset file input
      
      // Keep jobId for redirect, but clear groupId
      // groupId will be available in job detail page
      
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
                {prompt.length} characters
              </p>
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
                  Total: <span className="text-green-600 dark:text-green-400 font-bold">{files.length} × {numVariations} = {files.length * numVariations}</span> images
                </p>
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
                      Aspect Ratio
                    </label>
                    <select
                      value={aspectRatio}
                      onChange={(e) => setAspectRatio(e.target.value)}
                      className="w-full p-2 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-orange-500 dark:focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-200 dark:focus:ring-orange-900/50 transition-all text-sm"
                      disabled={loading}
                    >
                      <option value="1:1">1:1 (Square)</option>
                      <option value="2:3">2:3 (Portrait)</option>
                      <option value="3:2">3:2 (Landscape)</option>
                      <option value="3:4">3:4 (Portrait)</option>
                      <option value="4:3">4:3 (Landscape)</option>
                      <option value="4:5">4:5 (Portrait)</option>
                      <option value="5:4">5:4 (Landscape)</option>
                      <option value="9:16">9:16 (Vertical)</option>
                      <option value="16:9">16:9 (Widescreen)</option>
                      <option value="21:9">21:9 (Ultrawide)</option>
                    </select>
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
                Generate {files.length * numVariations} Images
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
