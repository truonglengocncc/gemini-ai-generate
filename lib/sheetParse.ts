/**
 * Parse bulk job sheet: TSV/CSV with columns FILE, Prompt, Ratio, Variations, Resolution.
 * Each row = one generate job. Total images = Variations × (ratio expansion) × (prompt expansion).
 */
export type SheetRow = {
  file: string;
  prompt: string;
  imageRatio: string;
  variationsPerImage: number;
  resolution: string;
};

const COL_FILE = "file";
const COL_PROMPT = "prompt";
const COL_RATIO = "ratio";
const COL_VARIATIONS = "variations";
const COL_RESOLUTION = "resolution";

const HEADER_ALIASES: Record<string, string> = {
  file: COL_FILE,
  "gcs path": COL_FILE,
  "gcs": COL_FILE,
  prompt: COL_PROMPT,
  ratio: COL_RATIO,
  "aspect ratio": COL_RATIO,
  variations: COL_VARIATIONS,
  "variations per image": COL_VARIATIONS,
  resolution: COL_RESOLUTION,
};

const BOM = "\uFEFF";

function normalizeHeader(h: string): string {
  const key = h.replace(BOM, "").trim().toLowerCase().replace(/\s+/g, " ");
  return HEADER_ALIASES[key] ?? key;
}

/** Return true if the first row looks like column headers (not data). */
function isHeaderRow(cells: string[], normalized: string[]): boolean {
  if (cells.length < 2) return false;
  const known = [COL_FILE, COL_PROMPT, COL_RATIO, COL_VARIATIONS, COL_RESOLUTION];
  const hasKnown = normalized.some((k) => known.includes(k));
  if (!hasKnown) return false;
  const allShortAndNoPath = cells.every((c, i) => {
    const s = (c ?? "").replace(BOM, "").trim();
    if (s.length > 80) return false;
    if (s.startsWith("gs://")) return false;
    if (normalized[i] && known.includes(normalized[i])) return true;
    return s.length < 50;
  });
  return allShortAndNoPath;
}

/** Parse ratio column: "9:16", "{9:16, 4:5, 16:9}" -> use first ratio */
function parseRatio(value: string): string {
  const v = (value || "").trim();
  const match = v.match(/(\d+:\d+)/);
  if (match) return match[1];
  return v || "1:1";
}

function parseNumber(value: string, fallback: number): number {
  const n = parseInt(String(value || "").trim(), 10);
  return Number.isNaN(n) ? fallback : Math.max(1, n);
}

function parseResolution(value: string): string {
  const v = (value || "").trim().toUpperCase();
  if (/^[12]K$/i.test(v) || /^4K$/i.test(v)) return v.replace(/^([12])k$/i, "$1K").replace(/^4k$/i, "4K");
  return v || "2K";
}

/**
 * Split a CSV line into cells, respecting double-quoted fields (commas inside quotes stay).
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let cell = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          cell += line[i];
          i++;
        }
      }
      cells.push(cell.trim());
      if (line[i] === ",") i++;
    } else {
      const comma = line.indexOf(",", i);
      if (comma === -1) {
        cells.push(line.slice(i).trim());
        break;
      }
      cells.push(line.slice(i, comma).trim());
      i = comma + 1;
    }
  }
  return cells;
}

/**
 * Parse pasted sheet text (TSV or CSV). First row can be header.
 * Returns array of rows; invalid rows are skipped and reported in errors.
 */
export function parseSheet(text: string): { rows: SheetRow[]; errors: string[] } {
  const errors: string[] = [];
  const cleaned = text.replace(BOM, "").trim();
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], errors: ["Sheet is empty."] };

  const isTsv = lines[0].includes("\t");
  const rawRows = lines.map((line) => {
    if (isTsv) {
      return line.split("\t").map((cell) => cell.replace(/^["']|["']$/g, "").replace(BOM, "").trim());
    }
    return splitCsvLine(line).map((cell) => cell.replace(/^["']|["']$/g, "").replace(BOM, "").trim());
  });

  let startIndex = 0;
  const first = rawRows[0] ?? [];
  const normalizedFirst = first.map((c) => normalizeHeader(String(c)));
  const looksLikeHeader = isHeaderRow(first, normalizedFirst);

  const colIndex: Record<string, number> = {};
  if (looksLikeHeader) {
    normalizedFirst.forEach((key, i) => {
      const col = HEADER_ALIASES[key] ?? key;
      if ([COL_FILE, COL_PROMPT, COL_RATIO, COL_VARIATIONS, COL_RESOLUTION].includes(col)) {
        colIndex[col] = i;
      }
    });
    colIndex[COL_FILE] = colIndex[COL_FILE] ?? 0;
    colIndex[COL_PROMPT] = colIndex[COL_PROMPT] ?? 1;
    colIndex[COL_RATIO] = colIndex[COL_RATIO] ?? 2;
    colIndex[COL_VARIATIONS] = colIndex[COL_VARIATIONS] ?? 3;
    colIndex[COL_RESOLUTION] = colIndex[COL_RESOLUTION] ?? 4;
    startIndex = 1;
  } else {
    colIndex[COL_FILE] = 0;
    colIndex[COL_PROMPT] = 1;
    colIndex[COL_RATIO] = 2;
    colIndex[COL_VARIATIONS] = 3;
    colIndex[COL_RESOLUTION] = 4;
  }

  const rows: SheetRow[] = [];
  for (let i = startIndex; i < rawRows.length; i++) {
    const cells = rawRows[i] ?? [];
    const file = (cells[colIndex[COL_FILE]] ?? "").trim();
    const prompt = (cells[colIndex[COL_PROMPT]] ?? "").trim();
    if (!file || !prompt) {
      errors.push(`Row ${i + 1}: missing FILE or Prompt, skipped.`);
      continue;
    }
    rows.push({
      file,
      prompt,
      imageRatio: parseRatio(cells[colIndex[COL_RATIO]] ?? "1:1"),
      variationsPerImage: parseNumber(cells[colIndex[COL_VARIATIONS]], 1),
      resolution: parseResolution(cells[colIndex[COL_RESOLUTION]] ?? "2K"),
    });
  }

  if (rows.length === 0 && errors.length === 0) errors.push("No valid data rows (need FILE and Prompt per row).");
  return { rows, errors };
}
