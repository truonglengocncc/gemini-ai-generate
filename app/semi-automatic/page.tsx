"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

interface Group {
  id: string;
  name: string;
  createdAt: string;
  jobCount?: number;
  imageCount?: number;
}

interface Prompt {
  text: string;
  countPerRef: number;
}

export default function SemiAutomaticPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [submitGroupName, setSubmitGroupName] = useState("");
  const [refImages, setRefImages] = useState<File[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([{ text: "", countPerRef: 1 }]);
  const [model, setModel] = useState("gemini-3-pro-image-preview");
  const [resolution, setResolution] = useState("1K");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<any[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueHasMore, setQueueHasMore] = useState(true);
  const [queueOffset, setQueueOffset] = useState(0);
  const queueLimit = 10;
  const queueScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadGroups();
    loadQueue(true); // Load initial 10 items
  }, []);

  // Scroll listener for lazy loading
  useEffect(() => {
    const scrollContainer = queueScrollRef.current;
    if (!scrollContainer) return;

    const handleScroll = async () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      // Load more when scrolled to bottom (with 50px threshold)
      if (scrollHeight - scrollTop <= clientHeight + 50 && queueHasMore && !queueLoading) {
        try {
          setQueueLoading(true);
          const response = await fetch(`/api/queue?limit=${queueLimit}&offset=${queueOffset}`);
          const data = await response.json();
          
          setQueue(prev => [...prev, ...data.jobs]);
          setQueueOffset(prev => prev + data.jobs.length);
          setQueueHasMore(data.hasMore);
        } catch (error) {
          console.error("Failed to load more queue:", error);
        } finally {
          setQueueLoading(false);
        }
      }
    };

    scrollContainer.addEventListener('scroll', handleScroll);
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [queueHasMore, queueLoading, queueOffset]);

  const loadGroups = async () => {
    try {
      const response = await fetch("/api/groups");
      const data = await response.json();
      setGroups(data.groups);
    } catch (error) {
      console.error("Failed to load groups:", error);
    }
  };

  const loadQueue = async (reset = false) => {
    try {
      setQueueLoading(true);
      const offset = reset ? 0 : queueOffset;
      const response = await fetch(`/api/queue?limit=${queueLimit}&offset=${offset}`);
      const data = await response.json();
      
      if (reset) {
        setQueue(data.jobs);
        setQueueOffset(data.jobs.length);
      } else {
        setQueue(prev => [...prev, ...data.jobs]);
        setQueueOffset(prev => prev + data.jobs.length);
      }
      
      setQueueHasMore(data.hasMore);
    } catch (error) {
      console.error("Failed to load queue:", error);
    } finally {
      setQueueLoading(false);
    }
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName }),
      });
      const data = await response.json();
      setGroups([...groups, data]);
      setSelectedGroupId(data.id);
      setNewGroupName("");
    } catch (error) {
      console.error("Failed to create group:", error);
    }
  };

  const handleRefImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newImages = Array.from(e.target.files);
      setRefImages([...refImages, ...newImages]);
    }
  };

  const addPrompt = () => {
    setPrompts([...prompts, { text: "", countPerRef: 1 }]);
  };

  const removePrompt = (index: number) => {
    if (prompts.length > 1) {
      setPrompts(prompts.filter((_, idx) => idx !== index));
    }
  };

  const updatePromptText = (index: number, text: string) => {
    const updated = [...prompts];
    updated[index] = { ...updated[index], text };
    setPrompts(updated);
  };

  const updatePromptCount = (index: number, count: number) => {
    const updated = [...prompts];
    updated[index] = { ...updated[index], countPerRef: Math.max(1, count) };
    setPrompts(updated);
  };

  const removeRefImage = (index: number) => {
    setRefImages(refImages.filter((_, idx) => idx !== index));
  };

  const uploadRefImages = async (jobId: string): Promise<string[]> => {
    // 1) Presign upload URLs
    const presignRes = await fetch("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        files: refImages.map((f, idx) => ({
          index: idx,
          filename: f.name,
          contentType: f.type || "image/jpeg",
        })),
      }),
    });
    if (!presignRes.ok) throw new Error("Failed to presign upload URLs");
    const { uploads } = await presignRes.json();

    // 2) Upload directly to GCS
    await Promise.all(
      uploads.map(async (u: any) => {
        const file = refImages[u.index];
        await fetch(u.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": u.contentType },
          body: file,
        });
      })
    );

    // 3) Return public URLs for UI display
    return uploads.map((u: any) => u.publicUrl);
  };

  // Calculate total images
  const totalImages = refImages.length * prompts.reduce((sum, p) => sum + (p.countPerRef || 0), 0);

  const handleSubmit = async () => {
    if (refImages.length === 0) {
      alert("Please upload reference images");
      return;
    }

    const validPrompts = prompts.filter(p => p.text.trim());
    if (validPrompts.length === 0) {
      alert("Please add at least one prompt");
      return;
    }

    if (!selectedGroupId) {
      alert("Please select or create a group first");
      return;
    }

    setLoading(true);
    try {
      const groupIdToUse = selectedGroupId;

      // Generate jobId
      const generatedJobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Upload ref images to GCS
      await uploadRefImages(generatedJobId);
      
      // Build prompts array and images_per_prompt mapping
      const promptTexts: string[] = [];
      const imagesPerPrompt: Record<string, number> = {};
      
      validPrompts.forEach((p, promptIdx) => {
        promptTexts.push(p.text);
        // Mỗi ref image sẽ dùng prompt này để generate countPerRef ảnh
        refImages.forEach((_, refIdx) => {
          imagesPerPrompt[`${refIdx}_${promptIdx}`] = p.countPerRef;
        });
      });

      // Submit single job - worker will handle concurrent processing
      await fetch("/api/jobs/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "semi-automatic",
          groupId: groupIdToUse,
          jobId: generatedJobId,
          folder: `${generatedJobId}/upload`,
          prompts: promptTexts,
          model: model,
          config: {
            images_per_prompt: imagesPerPrompt,
            ...(model === "gemini-3-pro-image-preview" && { resolution, aspect_ratio: aspectRatio }),
          },
        }),
      });

      alert(`Job submitted successfully! Generating ${totalImages} images.`);
      loadQueue(true); // Reset queue
      
      // Reset form
      setRefImages([]);
      setPrompts([{ text: "", countPerRef: 1 }]);
      setModel("gemini-3-pro-image-preview"); // Reset model to default
      setResolution("1K"); // Reset resolution to default
      setAspectRatio("1:1"); // Reset aspect ratio to default
    } catch (error) {
      console.error("Failed to submit jobs:", error);
      alert("Failed to submit jobs");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-purple-50/30 to-pink-50/30 dark:from-black dark:via-zinc-950 dark:to-zinc-900 p-4 sm:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-3xl">🎨</span>
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent mb-2">
            Semi-Automatic Mode
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Controlled batch generation with Midjourney-like workflow
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Group & Settings */}
          <div className="space-y-6">
            {/* Groups Card */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                  <span className="text-xl">📁</span>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Groups</h2>
              </div>
              
              <div className="mb-4">
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="New group name"
                  className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-blue-500 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-900/50 transition-all mb-3"
                />
                <button
                  onClick={createGroup}
                  className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg hover:from-blue-700 hover:to-blue-800 font-medium shadow-md hover:shadow-lg transform hover:scale-[1.02] transition-all"
                >
                  + Create Group
                </button>
              </div>

              <select
                value={selectedGroupId}
                onChange={(e) => setSelectedGroupId(e.target.value)}
                className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-blue-500 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-900/50 transition-all"
              >
                <option value="">Select a group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.jobCount || 0} jobs)
                  </option>
                ))}
              </select>
              
              {!selectedGroupId && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 text-center">
                  💡 Or create a new group above, then select it
                </p>
              )}
            </div>

            {/* Summary Card */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                  <span className="text-xl">📊</span>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Summary</h2>
              </div>
              
              <div className="space-y-3">
                <div className="flex justify-between items-center p-2 rounded-lg bg-gray-50 dark:bg-zinc-800/50">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Reference Images:</span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{refImages.length}</span>
                </div>
                <div className="flex justify-between items-center p-2 rounded-lg bg-gray-50 dark:bg-zinc-800/50">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Prompts:</span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{prompts.filter(p => p.text.trim()).length}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded-lg bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 border-2 border-blue-200 dark:border-blue-800">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Total Images:</span>
                  <span className="text-lg font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">{totalImages}</span>
                </div>
                <div className="flex justify-between items-center p-2 rounded-lg bg-gray-50 dark:bg-zinc-800/50">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Selected Group:</span>
                  <span className={`font-semibold ${selectedGroupId ? 'text-purple-600 dark:text-purple-400' : 'text-gray-400'}`}>
                    {selectedGroupId ? groups.find(g => g.id === selectedGroupId)?.name || 'N/A' : 'None'}
                  </span>
                </div>
              </div>

              {/* Model Section */}
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-zinc-700">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">🤖</span>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                    AI Model
                  </label>
                </div>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 focus:border-orange-500 dark:focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-200 dark:focus:ring-orange-900/50 transition-all text-sm"
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
                  <div className="mt-3 space-y-3">
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

              <div className="mt-4 p-3 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <p className="text-xs text-gray-700 dark:text-gray-300">
                  ℹ️ Each reference image will be used with all prompts to generate images.
                </p>
              </div>
            </div>
          </div>

          {/* Middle Column: Reference Images & Prompts */}
          <div className="space-y-6">
            {/* Reference Images */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-pink-100 dark:bg-pink-900/30 rounded-lg flex items-center justify-center">
                  <span className="text-xl">🖼️</span>
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Reference Images</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Each will be used with all prompts</p>
                </div>
              </div>
              
              <div className="relative mb-4">
                <input
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={handleRefImageUpload}
                  className="w-full p-3 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800/50 hover:border-pink-400 dark:hover:border-pink-600 focus:border-pink-500 dark:focus:border-pink-500 focus:outline-none transition-colors cursor-pointer"
                />
                {refImages.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="text-sm text-gray-400 dark:text-gray-500">Click or drag files here</span>
                  </div>
                )}
              </div>

              {refImages.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {refImages.map((image, idx) => (
                    <div key={idx} className="relative group border-2 border-gray-200 dark:border-zinc-700 rounded-lg p-2 hover:border-pink-400 dark:hover:border-pink-600 transition-colors">
                      <img
                        src={URL.createObjectURL(image)}
                        alt={`Ref ${idx + 1}`}
                        className="w-full h-32 object-cover rounded"
                      />
                      <button
                        onClick={() => removeRefImage(idx)}
                        className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-7 h-7 flex items-center justify-center text-sm hover:bg-red-600 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-2 truncate font-medium">{image.name}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Prompts */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                    <span className="text-xl">✍️</span>
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Prompts</h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Each applied to all reference images</p>
                  </div>
                </div>
                <button
                  onClick={addPrompt}
                  className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg text-sm font-medium hover:from-purple-700 hover:to-pink-700 shadow-md hover:shadow-lg transform hover:scale-105 transition-all"
                >
                  + Add Prompt
                </button>
              </div>

              <div className="space-y-4">
                {prompts.map((prompt, idx) => (
                  <div key={idx} className="border-2 border-gray-200 dark:border-zinc-700 rounded-lg p-4 hover:border-purple-400 dark:hover:border-purple-600 transition-colors bg-gray-50/50 dark:bg-zinc-800/30">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="flex-1">
                        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Prompt {idx + 1}
                        </label>
                        <textarea
                          value={prompt.text}
                          onChange={(e) => updatePromptText(idx, e.target.value)}
                          placeholder="e.g., dog in forest, running on beach..."
                          className="w-full p-3 border-2 border-gray-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 focus:border-purple-500 dark:focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:focus:ring-purple-900/50 transition-all resize-none text-sm"
                          rows={3}
                        />
                      </div>
                      {prompts.length > 1 && (
                        <button
                          onClick={() => removePrompt(idx)}
                          className="mt-7 px-3 py-1.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg text-xs font-medium hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3 p-2 bg-gradient-to-r from-green-50 to-blue-50 dark:from-green-900/20 dark:to-blue-900/20 rounded-lg">
                      <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Images per ref:</label>
                      <input
                        type="number"
                        value={prompt.countPerRef}
                        onChange={(e) => updatePromptCount(idx, parseInt(e.target.value) || 1)}
                        className="w-16 p-1.5 border-2 border-gray-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-center text-sm font-semibold focus:border-green-500 dark:focus:border-green-500 focus:outline-none"
                        min="1"
                        max="20"
                      />
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                        = {refImages.length} refs × {prompt.countPerRef} = <span className="text-green-600 dark:text-green-400 font-bold">{refImages.length * prompt.countPerRef}</span> images
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={handleSubmit}
                disabled={loading || !selectedGroupId || refImages.length === 0 || prompts.filter(p => p.text.trim()).length === 0}
                className="w-full mt-6 py-4 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-semibold rounded-xl shadow-lg hover:shadow-xl transform hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:hover:shadow-lg flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Submitting...
                  </>
                ) : (
                  <>
                    <span className="text-xl">🚀</span>
                    Submit Job ({totalImages} images)
                  </>
                )}
              </button>
              
              {!selectedGroupId && (
                <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-xs text-red-600 dark:text-red-400 text-center font-medium">
                    ⚠️ Please select or create a group first
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Queue */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-gray-200 dark:border-zinc-800 p-6 hover:shadow-xl transition-shadow flex flex-col h-[calc(100vh-8rem)]">
            <div className="flex items-center gap-3 mb-4 flex-shrink-0">
              <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                <span className="text-xl">📋</span>
              </div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Queue</h2>
            </div>
            
            <div 
              ref={queueScrollRef}
              className="space-y-3 overflow-y-auto flex-1 pr-2" 
              style={{ maxHeight: 'calc(100vh - 12rem)' }}
            >
              {queue.length === 0 && !queueLoading ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-2">📭</div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">No jobs in queue</p>
                </div>
              ) : (
                <>
                  {queue.map((job) => {
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

                  return (
                    <div
                      key={job.id}
                      className="p-4 border-2 border-gray-200 dark:border-zinc-700 rounded-lg hover:border-orange-400 dark:hover:border-orange-600 hover:shadow-md transition-all bg-gray-50/50 dark:bg-zinc-800/30"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{job.mode === 'automatic' ? '⚡' : '🎨'}</span>
                          <p className="font-semibold text-sm text-gray-900 dark:text-gray-100 capitalize">{job.mode}</p>
                        </div>
                        <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${getStatusColor(job.status)}`}>
                          {job.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                        {new Date(job.createdAt).toLocaleString()}
                      </p>
                      <Link
                        href={`/jobs/${job.id}`}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200 font-semibold hover:underline"
                      >
                        View Details
                        <span>→</span>
                      </Link>
                    </div>
                  );
                  })}
                  
                  {/* Loading indicator */}
                  {queueLoading && (
                    <div className="text-center py-4">
                      <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-orange-600"></div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Loading more...</p>
                    </div>
                  )}
                  
                  {/* End of list */}
                  {!queueHasMore && queue.length > 0 && (
                    <div className="text-center py-4">
                      <p className="text-xs text-gray-400 dark:text-gray-500">No more jobs to load</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
