import { NextRequest, NextResponse } from "next/server";

/**
 * Extract Google Spreadsheet ID and optional gid (sheet tab) from URL.
 * e.g. https://docs.google.com/spreadsheets/d/1UsIIKoopa0KYiKiPd78OzvOPo0x49ZVJBR06WjJf-P8/edit?gid=0#gid=0
 */
function extractSheetParams(url: string): { spreadsheetId: string; gid: string } | null {
  const trimmed = (url || "").trim();
  if (!trimmed) return null;
  const idMatch = trimmed.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) return null;
  const spreadsheetId = idMatch[1];
  const gidMatch = trimmed.match(/[?&#]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return { spreadsheetId, gid };
}

/**
 * Fetch Google Sheet as CSV via export URL.
 * Sheet must be shared "Anyone with the link can view" (or public) for this to work without auth.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = typeof body?.url === "string" ? body.url : "";
    const params = extractSheetParams(url);

    if (!params) {
      return NextResponse.json(
        { error: "Invalid URL. Use a Google Sheets link like: https://docs.google.com/spreadsheets/d/.../edit" },
        { status: 400 }
      );
    }

    const exportUrl = `https://docs.google.com/spreadsheets/d/${params.spreadsheetId}/export?format=csv&gid=${params.gid}`;
    const res = await fetch(exportUrl, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GeminiSheets/1.0)" },
      redirect: "follow",
    });

    if (!res.ok) {
      if (res.status === 403) {
        return NextResponse.json(
          { error: 'Could not read sheet. Share the Google Sheet with "Anyone with the link" (Viewer) access.' },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: `Failed to load sheet: ${res.status} ${res.statusText}` },
        { status: res.status }
      );
    }

    const text = await res.text();
    if (!text || text.trim().length === 0) {
      return NextResponse.json(
        { error: "Sheet is empty or could not be exported." },
        { status: 422 }
      );
    }

    return NextResponse.json({ content: text });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("fetch-sheet error:", err);
    return NextResponse.json(
      { error: err.message || "Error loading Google Sheet" },
      { status: 500 }
    );
  }
}
