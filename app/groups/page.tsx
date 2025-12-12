"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import JSZip from "jszip";

interface Group {
  id: string;
  name: string;
  createdAt: string;
  jobCount: number;
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const loadGroups = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/groups");
      const data = await response.json();
      setGroups(data.groups);
    } catch (error) {
      console.error("Failed to load groups:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGroups();
  }, []);

  const createGroup = async () => {
    if (!newGroupName.trim()) {
      alert("Please enter a group name");
      return;
    }

    try {
      setCreating(true);
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName }),
      });

      if (!response.ok) {
        throw new Error("Failed to create group");
      }

      setNewGroupName("");
      await loadGroups();
      alert("Group deleted successfully");
    } catch (error) {
      console.error("Failed to create group:", error);
      alert("Failed to create group");
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = (groupId: string) => {
    window.location.href = `/api/download/${groupId}`;
  };

  const handleClientDownload = async (groupId: string, name: string) => {
    try {
      setDownloading(groupId);
      const res = await fetch(`/api/download/${groupId}?mode=list`);
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
      a.download = `${name.replace(/[^a-z0-9]/gi, "_") || groupId}_images.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error("Client ZIP failed", e);
      alert("Client ZIP failed. Please try server download.");
    } finally {
      setDownloading(null);
    }
  };

  const handleDelete = async (groupId: string) => {
    if (!confirm("Delete this group and all its jobs/files?")) return;
    try {
      const res = await fetch(`/api/groups/${groupId}/delete`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Delete failed");
        return;
      }
      await loadGroups();
    } catch (e) {
      console.error("Delete group failed", e);
      alert("Delete failed");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Groups</h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Organize your image generation jobs into groups
          </p>
        </div>

        {/* Create Group */}
        <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Create New Group</h2>
          <div className="flex gap-3">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && createGroup()}
              placeholder="Enter group name..."
              className="flex-1 p-3 border rounded-lg"
              disabled={creating}
            />
            <button
              onClick={createGroup}
              disabled={creating || !newGroupName.trim()}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create Group"}
            </button>
          </div>
        </div>

        {/* Groups List */}
        {loading ? (
          <div className="text-center py-12">
            <p className="text-zinc-600">Loading groups...</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-lg p-12 text-center">
            <p className="text-zinc-600 dark:text-zinc-400 mb-4">
              No groups yet. Create your first group to get started!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {groups.map((group) => (
              <div
                key={group.id}
                className="bg-white dark:bg-zinc-900 rounded-lg p-6 border border-zinc-200 dark:border-zinc-800 hover:border-blue-500 transition-colors"
              >
                <div className="mb-4">
                  <h3 className="text-xl font-semibold mb-2">{group.name}</h3>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Created: {new Date(group.createdAt).toLocaleDateString()}
                  </p>
                </div>

                <div className="mb-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-600 dark:text-zinc-400">Jobs:</span>
                    <span className="font-medium">{group.jobCount}</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Link
                    href={`/groups/${group.id}`}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-center text-sm"
                  >
                    View Details
                  </Link>
                  <button
                    onClick={() => handleDownload(group.id)}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
                    title="Download all images"
                  >
                    Server ZIP
                  </button>
                <button
                  onClick={() => handleClientDownload(group.id, group.name)}
                  disabled={downloading === group.id}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-60"
                  title="Download ZIP in browser"
                >
                  {downloading === group.id ? "Preparing..." : "Client ZIP"}
                </button>
                <button
                  onClick={() => handleDelete(group.id)}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
                  title="Delete group and all jobs/files"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
