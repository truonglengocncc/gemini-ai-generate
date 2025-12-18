"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Group = { id: string; name: string; jobCount?: number };

const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const TEXT_MODELS = [
  {
    value: "gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image Preview (Default, higher quality)",
  },
  {
    value: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image (Fast option)",
  },
];

function expandPromptTemplate(template: string) {
  if (!template) return [] as string[];
  const regex = /\{([^{}]+)\}/g;
  const segments: string[] = [];
  const variables: string[][] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    segments.push(template.slice(last, match.index));
    const opts = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    variables.push(opts.length ? opts : [""]);
    last = match.index + match[0].length;
  }
  segments.push(template.slice(last));
  if (variables.length === 0) return [template];
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

export default function TextImagePage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gemini-3-pro-image-preview");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [numVariations, setNumVariations] = useState(1);
  const [resolution, setResolution] = useState("1K");
  const [expandedPrompts, setExpandedPrompts] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    const combos = expandPromptTemplate(prompt);
    setExpandedPrompts(combos);
  }, [prompt]);

  const handleGroupNameChange = (value: string) => {
    setGroupName(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setGroupId("");
      return;
    }
    const found = groups.find((g) => g.name.toLowerCase() === trimmed.toLowerCase());
    setGroupId(found ? found.id : "");
  };

  const totalRequests = useMemo(() => expandedPrompts.length * Math.max(1, numVariations), [expandedPrompts, numVariations]);

  const loadGroups = async () => {
    try {
      setGroupsLoading(true);
      const res = await fetch("/api/groups");
      if (!res.ok) return;
      const data = await res.json();
      setGroups(data.groups || []);
    } catch (error) {
      console.error("Failed to load groups", error);
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
        body: JSON.stringify({ name: name || `Text-${Date.now()}` }),
      });
      const resJson = await response.json();
      setGroupId(resJson.id);
      return resJson.id;
    } catch (error) {
      console.error("Failed to create group", error);
      return null;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      alert("Please enter a prompt");
      return;
    }
    if (expandedPrompts.length === 0) {
      alert("Prompt is empty after parsing. Please adjust it.");
      return;
    }

    setLoading(true);
    setJobId(null);
    try {
      let currentGroupId = groupId;
      if (!currentGroupId) {
        currentGroupId = await createGroup(groupName || undefined);
        if (!currentGroupId) throw new Error("Unable to create group");
      }

      const ratioSlug = aspectRatio.replace(/:/g, "x");
      const generatedJobId = `job_txt_${ratioSlug}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const configPayload: any = {
        num_variations: numVariations,
        aspect_ratio: aspectRatio,
      };
      if (model === "gemini-3-pro-image-preview") {
        configPayload.resolution = resolution;
      }

      const response = await fetch("/api/jobs/submit-text-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: currentGroupId,
          jobId: generatedJobId,
          prompts: expandedPrompts,
          prompt_template: prompt,
          model,
          config: configPayload,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Submit failed");
      }

      setJobId(generatedJobId);
      setPrompt("");
      setNumVariations(1);
      setResolution("1K");
      setAspectRatio("1:1");
      setGroupName("");
      setGroupId(currentGroupId);

      setTimeout(() => router.push(`/jobs/${generatedJobId}`), 1200);
    } catch (error: any) {
      console.error("Failed to submit text image job", error);
      alert(error?.message || "Submit failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-blue-50/30 to-purple-50/30 dark:from-black dark:via-zinc-950 dark:to-zinc-900 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg">
              <span className="text-2xl">🖌️</span>
            </div>
            <div>
              <p className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                Mode
                <span className="ml-2 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                  Text to Image
                </span>
              </p>
              <h1 className="mt-3 text-3xl font-extrabold tracking-tight">
                <span className="bg-gradient-to-r from-blue-600 via-purple-600 to-pink-500 bg-clip-text text-transparent">
                  Text-to-Image Mode
                </span>
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
                Generate brand-new images using Gemini image generation without uploading reference photos. Use template
                syntax like {"{happy,sad}"} to automatically create multiple prompt variations. Default model: Gemini 3 Pro Image Preview.
              </p>
            </div>
          </div>

          <div className="flex w-full flex-col gap-2 rounded-2xl border border-zinc-200 bg-white/80 p-4 text-xs text-zinc-600 shadow-lg backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-300 md:w-64">
            <p className="font-medium text-zinc-800 dark:text-zinc-100">Quick guide</p>
            <ul className="space-y-1">
              <li>Use {"{happy,sad}"} to branch adjectives.</li>
              <li>Separate options with commas.</li>
              <li>Each combination will create its own request.</li>
            </ul>
          </div>
        </div>

        {jobId && (
          <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 shadow-sm dark:border-green-900/40 dark:bg-green-950/40 dark:text-green-200">
            <p className="flex items-center justify-between gap-4">
              <span>
                Job submitted! Redirecting to{" "}
                <span className="font-mono text-xs font-semibold underline decoration-dotted underline-offset-2">
                  {jobId}
                </span>
              </span>
              <span className="hidden text-[11px] text-green-800/80 dark:text-green-300/80 md:inline">
                You can safely navigate away, the job is queued.
              </span>
            </p>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white/90 p-6 shadow-lg shadow-zinc-200/60 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/90 dark:shadow-black/40"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-blue-500/5 via-transparent to-transparent dark:from-blue-400/10" />

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            <div className="relative">
              <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Prompt
              </label>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Supports template syntax. Use braces to branch options within a single sentence.
              </p>
              <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/80 shadow-inner dark:border-zinc-800 dark:bg-zinc-900/60">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={7}
                  className="w-full resize-none rounded-xl border-0 bg-transparent p-3 text-sm text-zinc-900 outline-none focus:ring-0 dark:text-zinc-50"
                  placeholder="A cinematic portrait of {happy,serious} astronaut, ultra detailed, volumetric lighting"
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                <span>
                  Expanded prompts:{" "}
                  <span className="font-semibold text-zinc-800 dark:text-zinc-100">{expandedPrompts.length}</span>
                </span>
                <span className="hidden md:inline">
                  Example: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">
                    A {`{happy,sad}`} astronaut on {`{Mars,Earth}`}
                  </code>
                </span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/60">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Group & preset
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Select group
                    </label>
                    <input
                      type="text"
                      value={groupName}
                      onChange={(e) => handleGroupNameChange(e.target.value)}
                      placeholder="Existing group name or new name"
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-0 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-950/40"
                      list="groups-list"
                    />
                    <datalist id="groups-list">
                      {groups.map((g) => (
                        <option key={g.id} value={g.name} />
                      ))}
                    </datalist>
                    {groupsLoading && (
                      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Loading groups...</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Model</label>
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-950/40"
                      >
                        {TEXT_MODELS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                        Choose Gemini 3 Pro for 1K/2K/4K renders, Gemini 2.5 for faster 1024px images.
                      </p>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                        Aspect ratio
                      </label>
                      <select
                        value={aspectRatio}
                        onChange={(e) => setAspectRatio(e.target.value)}
                        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-950/40"
                      >
                        {ASPECT_RATIOS.map((ratio) => (
                          <option key={ratio} value={ratio}>
                            {ratio}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {model === "gemini-3-pro-image-preview" && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                        Resolution
                      </label>
                      <select
                        value={resolution}
                        onChange={(e) => setResolution(e.target.value)}
                        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-950/40"
                      >
                        <option value="1K">1K (Fastest)</option>
                        <option value="2K">2K</option>
                        <option value="4K">4K (Sharpest)</option>
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Variations per prompt
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={numVariations}
                      onChange={(e) => setNumVariations(parseInt(e.target.value) || 1)}
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-950/40"
                    />
                    <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Each prompt will generate this many images.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50/80 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900/60">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Run summary
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-zinc-500 dark:text-zinc-400">Prompts expanded</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                      {expandedPrompts.length || 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500 dark:text-zinc-400">Total requests</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{totalRequests}</p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Total requests = expanded prompts × variations per prompt. Make sure this fits within your quota.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-8 flex flex-col items-stretch justify-between gap-3 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400 md:flex-row md:items-center">
            <p>
              You can review generated images later in the <span className="font-medium text-zinc-700 dark:text-zinc-200">Jobs</span>{" "}
              section.
            </p>
            <div className="flex flex-1 items-center justify-end gap-3">
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-zinc-900"
              >
                {loading ? "Submitting..." : "Generate images"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
