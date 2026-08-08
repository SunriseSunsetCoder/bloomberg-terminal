// =============================================================================
// Weekly watchlist ARCHIVE reader — the ONE parser/matcher for the archived scanner
// CSVs (c:\repos\watchlist).
//
// Extracted from scripts/jack-backfill-rim-from-archive.ts so every tool that matches
// archive rows to DB setups uses identical normalization. Two tools disagreeing about
// what "the same setup" means is exactly how a diagnostic ends up lying to you.
//
// Normalization mirrors the INGEST (lib/jack/validation-core.ts parseCsvRow):
//   · header keys  — BOM/quote/case/space/hyphen tolerant (normKey)
//   · ticker       — BOM + quotes stripped, trimmed, UPPERCASED (the DB stores it so)
//   · handle date  — normalizeIsoDate, the SAME helper the ingest used (ISO or M/D/YYYY)
//   · numbers      — $ , % and whitespace stripped
//
// Pure: no DB, no network.
// =============================================================================

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeIsoDate } from "@/lib/jack/reconcile";

/** Header key normalizer — mirrors parseCsvRow's normKey. */
export const normKey = (s: string): string => {
  const t = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  return t.replace(/["']/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
};

/** Ticker normalizer — strip BOM + quotes, trim, uppercase (matches the DB). */
export const normTicker = (s: string): string => {
  const t = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  return t.replace(/["']/g, "").trim().toUpperCase();
};

/** Numeric cell → finite number, or null. Tolerates $ , % and spaces. */
export const normNum = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const cleaned = s.replace(/["']/g, "").replace(/[$,%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/** Positive-only variant (a price level of 0 or less is not a usable rim). */
export const normPositive = (s: string | undefined): number | null => {
  const n = normNum(s);
  return n != null && n > 0 ? n : null;
};

/** CSV line splitter that respects double-quoted fields (pandas quotes on demand). */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export const detectDelim = (header: string): string =>
  header.split("\t").length > header.split(",").length ? "\t" : ",";

/** THE match key. Both sides must build it through this function. */
export const archiveKey = (ticker: string, handleLowDate: string): string =>
  `${normTicker(ticker)}|${handleLowDate.trim()}`;

export const RIM_ALIASES = ["breakout_level", "breakout", "cup_rim", "rim"];
export const PRIORITY_ALIASES = ["priority", "prio"];

export interface ArchiveRow {
  ticker: string; // normalized
  handleLowDate: string; // normalized ISO
  key: string;
  priority: number | null;
  tier: string | null;
  sizeBucket: string | null;
  breakout: number | null;
  /** File this row came from (archive filenames sort chronologically). */
  file: string;
}

export interface ArchiveFileReport {
  file: string;
  rows: number;
  hasTicker: boolean;
  hasDate: boolean;
  hasRim: boolean;
  hasPriority: boolean;
  parsed: number;
  badDates: number;
}

/**
 * Read every *.csv in `dir`, in filename order (which is chronological for
 * watchlist_archive_YYYY-MM-DD.csv). Rows missing a ticker or an unparseable
 * handle_low_date are counted and skipped — never guessed at.
 */
export function readArchiveCsvs(dir: string): { rows: ArchiveRow[]; files: ArchiveFileReport[] } {
  const rows: ArchiveRow[] = [];
  const files: ArchiveFileReport[] = [];

  for (const name of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort()) {
    const text = readFileSync(join(dir, name), "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const report: ArchiveFileReport = {
      file: name, rows: Math.max(0, lines.length - 1),
      hasTicker: false, hasDate: false, hasRim: false, hasPriority: false,
      parsed: 0, badDates: 0,
    };
    if (lines.length < 2) { files.push(report); continue; }

    const delim = detectDelim(lines[0]);
    const header = splitCsvLine(lines[0], delim);
    const idx = new Map<string, number>();
    header.forEach((h, i) => {
      const k = normKey(h);
      if (k && !idx.has(k)) idx.set(k, i);
    });
    const at = (cols: string[], ...aliases: string[]): string | undefined => {
      for (const a of aliases) {
        const i = idx.get(normKey(a));
        if (i !== undefined && i < cols.length) return cols[i];
      }
      return undefined;
    };

    report.hasTicker = idx.has("ticker");
    report.hasDate = idx.has("handle_low_date");
    report.hasRim = RIM_ALIASES.some((a) => idx.has(normKey(a)));
    report.hasPriority = PRIORITY_ALIASES.some((a) => idx.has(normKey(a)));
    if (!report.hasTicker || !report.hasDate) { files.push(report); continue; }

    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line, delim);
      const ticker = normTicker(at(cols, "ticker") ?? "");
      const date = normalizeIsoDate((at(cols, "handle_low_date") ?? "").replace(/["']/g, "").trim());
      if (!ticker) continue;
      if (!date) { report.badDates++; continue; }

      const tierRaw = (at(cols, "tier") ?? "").replace(/["']/g, "").trim();
      const bucketRaw = (at(cols, "size_bucket", "bucket") ?? "").replace(/["']/g, "").trim();
      rows.push({
        ticker,
        handleLowDate: date,
        key: archiveKey(ticker, date),
        priority: normNum(at(cols, ...PRIORITY_ALIASES)),
        tier: tierRaw || null,
        sizeBucket: bucketRaw || null,
        breakout: normPositive(at(cols, ...RIM_ALIASES)),
        file: name,
      });
      report.parsed++;
    }
    files.push(report);
  }
  return { rows, files };
}

/**
 * Collapse to one row per (ticker, handle_low_date) — LATEST WINS. Files are read in
 * filename order, so the last occurrence is the most recent weekly export.
 */
export function dedupeLatest(rows: ArchiveRow[]): Map<string, ArchiveRow> {
  const out = new Map<string, ArchiveRow>();
  for (const r of rows) out.set(r.key, r); // later file overwrites earlier
  return out;
}
