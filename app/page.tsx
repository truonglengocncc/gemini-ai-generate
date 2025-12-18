import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <div className="max-w-7xl mx-auto px-4 py-16">
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold mb-4">
            AI Image Generation Platform
          </h1>
          <p className="text-xl text-zinc-600 dark:text-zinc-400 max-w-2xl mx-auto">
            Generate image datasets using Banana Gemini API with two powerful modes
          </p>
        </div>

        {/* Mode Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          <Link
            href="/automatic"
            className="bg-white dark:bg-zinc-900 p-8 rounded-xl border-2 border-zinc-200 dark:border-zinc-800 hover:border-blue-500 transition-all hover:shadow-lg"
          >
            <div className="text-4xl mb-4">⚡</div>
            <h2 className="text-2xl font-semibold mb-3">Automatic Mode</h2>
            <p className="text-zinc-600 dark:text-zinc-400 mb-4">
              Batch process large image sets (100-1000+ images) with minimal UI. 
              Generate multiple variations per image automatically.
            </p>
            <ul className="text-sm text-zinc-500 space-y-2">
              <li>✓ Upload bulk images</li>
              <li>✓ Single prompt for all</li>
              <li>✓ Multiple variations per image</li>
              <li>✓ Download as ZIP</li>
            </ul>
          </Link>

          <Link
            href="/semi-automatic"
            className="bg-white dark:bg-zinc-900 p-8 rounded-xl border-2 border-zinc-200 dark:border-zinc-800 hover:border-blue-500 transition-all hover:shadow-lg"
          >
            <div className="text-4xl mb-4">🎨</div>
            <h2 className="text-2xl font-semibold mb-3">Semi-Automatic Mode</h2>
            <p className="text-zinc-600 dark:text-zinc-400 mb-4">
              Controlled batch generation with Midjourney-like workflow. 
              Multiple prompts, reference images, and organized groups.
            </p>
            <ul className="text-sm text-zinc-500 space-y-2">
              <li>✓ Multiple reference images</li>
              <li>✓ Multiple prompts per group</li>
              <li>✓ Batch processing (4 imgs/batch)</li>
              <li>✓ Queue management</li>
            </ul>
          </Link>

          <Link
            href="/text-image"
            className="bg-white dark:bg-zinc-900 p-8 rounded-xl border-2 border-zinc-200 dark:border-zinc-800 hover:border-blue-500 transition-all hover:shadow-lg"
          >
            <div className="text-4xl mb-4">🖌️</div>
            <h2 className="text-2xl font-semibold mb-3">Text-to-Image Mode</h2>
            <p className="text-zinc-600 dark:text-zinc-400 mb-4">
              Generate images from scratch using Gemini image generation without uploading reference photos.
            </p>
            <ul className="text-sm text-zinc-500 space-y-2">
              <li>✓ Prompt template expansion</li>
              <li>✓ Multiple aspect ratios</li>
              <li>✓ Variations per prompt</li>
              <li>✓ Directly saved to groups</li>
            </ul>
          </Link>
        </div>

        {/* Quick Links */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
          <Link
            href="/jobs"
            className="bg-purple-600 hover:bg-purple-700 text-white p-6 rounded-lg text-center transition-colors"
          >
            <div className="text-3xl mb-2">📋</div>
            <h3 className="font-semibold mb-1">View All Jobs</h3>
            <p className="text-sm text-purple-200">Track your generation jobs</p>
          </Link>

          <Link
            href="/groups"
            className="bg-blue-600 hover:bg-blue-700 text-white p-6 rounded-lg text-center transition-colors"
          >
            <div className="text-3xl mb-2">📁</div>
            <h3 className="font-semibold mb-1">Manage Groups</h3>
            <p className="text-sm text-blue-200">Organize your images</p>
          </Link>
        </div>
      </div>
    </div>
  );
}
