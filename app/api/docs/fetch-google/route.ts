import { NextRequest, NextResponse } from "next/server";

/**
 * Extract Google Docs document ID from various URL formats.
 * e.g. https://docs.google.com/document/d/1Oy_yaGGsUYn9USM72O-yCnkBEkWWfQ6aZn15X7Wz_Yc/edit?hl=vi&tab=t.0
 */
function extractDocId(url: string): string | null {
  const trimmed = (url || "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch Google Doc as plain text via export URL.
 * Doc must be shared "Anyone with the link can view" (or public) for this to work without auth.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = typeof body?.url === "string" ? body.url : "";
    const docId = extractDocId(url);

    if (!docId) {
      return NextResponse.json(
        { error: "Invalid URL. Use a Google Docs link like: https://docs.google.com/document/d/.../edit" },
        { status: 400 }
      );
    }

    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const res = await fetch(exportUrl, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GeminiDocs/1.0)" },
      redirect: "follow",
    });

    if (!res.ok) {
      if (res.status === 403) {
        return NextResponse.json(
          { error: "Could not read document. Share the Google Doc with \"Anyone with the link\" (Viewer) access." },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: `Failed to load document: ${res.status} ${res.statusText}` },
        { status: res.status }
      );
    }

    const text = await res.text();
    if (!text || text.trim().length === 0) {
      return NextResponse.json(
        { error: "Document is empty or could not be exported." },
        { status: 422 }
      );
    }

    return NextResponse.json({ content: text });
  } catch (error: any) {
    console.error("fetch-google-doc error:", error);
    return NextResponse.json(
      { error: error.message || "Error loading Google Docs" },
      { status: 500 }
    );
  }
}
