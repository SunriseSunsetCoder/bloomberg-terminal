/*
 * JACK rim backfill — recover setups.breakout_level from the weekly watchlist archive.
 *
 * The scanner computes breakout_level and it IS in the archived watchlist CSVs, but the
 * CSV pasted into JACK dropped that column, so setups.breakout_level is null for every
 * row except the 6 hand-backfilled ones. Without the rim the outcome replay bails
 * ("missing geometry") and the setup can never become a paper trade. This rescues the
 * rows that already carry their AI decision + entry/stop/target.
 *
 * DIRECT DB MIGRATION — deliberately NOT routed through /api/jack-validation, which
 * would spawn a validation run, become the current board, and retire everything not in
 * it. This only ever runs:
 *
 *     UPDATE setups SET breakout_level = ?
 *      WHERE TRIM(UPPER(ticker)) = ? AND handle_low_date = ? AND breakout_level IS NULL
 *
 * Nothing else on the row is touched — no last_seen_at bump, no decisions, no outcomes.
 * The `IS NULL` guard makes it idempotent and means it can never overwrite an existing
 * rim (including the 6 hand-backfilled ones).
 *
 * DRY RUN BY DEFAULT — opens the DB READONLY and writes nothing.
 *   npx tsx scripts/jack-backfill-rim-from-archive.ts
 *   npx tsx scripts/jack-backfill-rim-from-archive.ts --apply
 *   npx tsx scripts/jack-backfill-rim-from-archive.ts "D:\some\other\archive"
 *
 * This does NOT resolve anything now — every rescued setup is still pre-gate. They
 * mature from ~November onward, and the existing outcome tracker picks them up then.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeIsoDate } from "../lib/jack/reconcile";

const DEFAULT_ARCHIVE_DIR = "c:\\repos\\watchlist";
const APPLY = process.argv.includes("--apply");
const archiveDir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DEFAULT_ARCHIVE_DIR;

// ---------------------------------------------------------------------------
// Normalization — the SAME rules the ingest used, applied to BOTH sides so a
// formatting difference can never cause a silent miss.
// ---------------------------------------------------------------------------

/** Header key normalizer — mirrors parseCsvRow's normKey (BOM/quote/case/space/hyphen). */
const normKey = (s: string): string => {
  const t = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  return t.replace(/["']/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
};

/** Ticker normalizer — strip BOM + quotes, trim, uppercase (DB stores it this way). */
const normTicker = (s: string): string => {
  const t = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  return t.replace(/["']/g, "").trim().toUpperCase();
};

/** Numeric cell → finite positive number, or null. Tolerates $ , % and spaces. */
const normNum = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const cleaned = s.replace(/["']/g, "").replace(/[$,%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** CSV line splitter that respects double-quoted fields (pandas quotes on demand). */
function splitCsvLine(line: string, delim: string): string[] {
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

const detectDelim = (header: string): string =>
  header.split("\t").length > header.split(",").length ? "\t" : ",";

// ---------------------------------------------------------------------------
// Archive read
// ---------------------------------------------------------------------------

interface FileReport {
  file: string;
  rows: number;
  hasTicker: boolean;
  hasDate: boolean;
  hasRim: boolean;
  usableRims: number;
  badDates: number;
  badRims: number;
}

interface RimEntry {
  /** distinct parsed rim values → the files that carried each */
  values: Map<number, string[]>;
}

const RIM_ALIASES = ["breakout_level", "breakout", "cup_rim", "rim"];

function readArchive(dir: string): { rims: Map<string, RimEntry>; files: FileReport[] } {
  const rims = new Map<string, RimEntry>();
  const files: FileReport[] = [];

  const names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort();
  for (const name of names) {
    const text = readFileSync(join(dir, name), "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const report: FileReport = {
      file: name, rows: Math.max(0, lines.length - 1),
      hasTicker: false, hasDate: false, hasRim: false,
      usableRims: 0, badDates: 0, badRims: 0,
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
    report.hasRim = RIM_ALIASES.some((a) => idx.has(a));
    if (!report.hasTicker || !report.hasDate || !report.hasRim) { files.push(report); continue; }

    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line, delim);
      const ticker = normTicker(at(cols, "ticker") ?? "");
      const date = normalizeIsoDate((at(cols, "handle_low_date") ?? "").replace(/["']/g, "").trim());
      const rim = normNum(at(cols, ...RIM_ALIASES));
      if (!ticker) continue;
      if (!date) { report.badDates++; continue; }
      if (rim == null) { report.badRims++; continue; }

      const key = `${ticker}|${date}`;
      const entry = rims.get(key) ?? { values: new Map<number, string[]>() };
      const seenFiles = entry.values.get(rim) ?? [];
      if (!seenFiles.includes(name)) seenFiles.push(name);
      entry.values.set(rim, seenFiles);
      rims.set(key, entry);
      report.usableRims++;
    }
    files.push(report);
  }
  return { rims, files };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface DbRow {
  id: number;
  ticker: string;
  handle_low_date: string;
  breakout_level: number | null;
  stop: number | null;
  t05_target: number | null;
}

function main(): number {
  const dbPath = process.env.JACK_DB_PATH || join(process.cwd(), "data", "jack.db");

  console.log("\n=================================================================");
  console.log(` JACK rim backfill from archive — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  console.log("=================================================================");
  console.log(`archive : ${archiveDir}`);
  console.log(`database: ${dbPath}${APPLY ? "" : "   (opened READONLY)"}\n`);

  if (!existsSync(archiveDir)) {
    console.error(`ARCHIVE NOT FOUND: ${archiveDir}\nPass the directory as an argument, or place the weekly CSVs there.\n`);
    return 1;
  }
  if (!existsSync(dbPath)) {
    console.error(`DATABASE NOT FOUND: ${dbPath}\n`);
    return 1;
  }

  // ---- 1. archive schema ---------------------------------------------------
  const { rims, files } = readArchive(archiveDir);

  console.log("--- ARCHIVE FILES -----------------------------------------------");
  console.log(`  ${"FILE".padEnd(42)}${"ROWS".padStart(6)}${"RIMS".padStart(7)}  ticker date rim   notes`);
  for (const f of files) {
    const flags = `${f.hasTicker ? " yes " : " NO  "} ${f.hasDate ? "yes " : "NO  "} ${f.hasRim ? "yes" : "NO "}`;
    const notes: string[] = [];
    if (!f.hasRim) notes.push("NO breakout_level — older format, contributes nothing");
    if (!f.hasTicker || !f.hasDate) notes.push("missing key column");
    if (f.badDates) notes.push(`${f.badDates} unparseable date(s)`);
    if (f.badRims) notes.push(`${f.badRims} unusable rim value(s)`);
    console.log(`  ${f.file.padEnd(42)}${String(f.rows).padStart(6)}${String(f.usableRims).padStart(7)}  ${flags}   ${notes.join("; ")}`);
  }
  const noRimFiles = files.filter((f) => !f.hasRim);
  console.log(`\n  ${files.length} file(s) · ${files.filter((f) => f.hasRim).length} carry a rim column · ${noRimFiles.length} do not`);
  if (noRimFiles.length) console.log(`  without rim: ${noRimFiles.map((f) => f.file).join(", ")}`);
  console.log(`  distinct (ticker, handle_low_date) keys with a usable rim: ${rims.size}`);

  // ---- 2. conflicts --------------------------------------------------------
  const conflicts = [...rims.entries()].filter(([, e]) => e.values.size > 1);
  console.log("\n--- CONFLICTS (same key, different rim) -------------------------");
  if (conflicts.length === 0) {
    console.log("  none — every key carries a single stable rim");
  } else {
    console.log(`  ${conflicts.length} conflicting key(s) — EXCLUDED from the write, no guessing:`);
    for (const [key, e] of conflicts) {
      console.log(`    ${key}`);
      for (const [v, fs] of e.values) console.log(`      ${v}   from ${fs.join(", ")}`);
    }
  }
  const conflictKeys = new Set(conflicts.map(([k]) => k));

  // ---- 3. DB side ----------------------------------------------------------
  const db = new Database(dbPath, APPLY ? {} : { readonly: true, fileMustExist: true });
  const allRows = db
    .prepare(`SELECT id, ticker, handle_low_date, breakout_level, stop, t05_target FROM setups`)
    .all() as DbRow[];
  const byKey = new Map<string, DbRow>();
  for (const r of allRows) byKey.set(`${normTicker(r.ticker)}|${r.handle_low_date}`, r);

  const nullRim = allRows.filter((r) => r.breakout_level == null);

  // ---- 4. classify ---------------------------------------------------------
  const willFillReplayable: Array<{ row: DbRow; rim: number }> = [];
  const willFillIncomplete: Array<{ row: DbRow; rim: number; missing: string }> = [];
  const alreadyFilled: string[] = [];
  const noDbRow: string[] = [];

  for (const [key, entry] of rims) {
    if (conflictKeys.has(key)) continue;
    const rim = [...entry.values.keys()][0];
    const row = byKey.get(key);
    if (!row) { noDbRow.push(key); continue; }
    if (row.breakout_level != null) { alreadyFilled.push(key); continue; }
    if (row.stop != null && row.t05_target != null) willFillReplayable.push({ row, rim });
    else {
      const missing = [row.stop == null ? "stop" : null, row.t05_target == null ? "t05_target" : null]
        .filter(Boolean).join(" + ");
      willFillIncomplete.push({ row, rim, missing });
    }
  }

  const fillKeys = new Set([
    ...willFillReplayable.map(({ row }) => `${normTicker(row.ticker)}|${row.handle_low_date}`),
    ...willFillIncomplete.map(({ row }) => `${normTicker(row.ticker)}|${row.handle_low_date}`),
  ]);
  // "No archive coverage" must NOT swallow rows we deliberately skipped for a rim
  // conflict — those have coverage, we just refuse to guess. Reported separately.
  const keyOf = (r: DbRow) => `${normTicker(r.ticker)}|${r.handle_low_date}`;
  const stayNull = nullRim.filter((r) => !fillKeys.has(keyOf(r)) && !conflictKeys.has(keyOf(r)));
  const stayNullConflict = nullRim.filter((r) => conflictKeys.has(keyOf(r)));

  // ---- per-ticker detail ---------------------------------------------------
  console.log("\n--- WILL FILL ---------------------------------------------------");
  if (willFillReplayable.length + willFillIncomplete.length === 0) {
    console.log("  (nothing to fill)");
  } else {
    console.log(`  ${"TICKER".padEnd(8)}${"HANDLE_LOW".padEnd(13)}${"RIM".padStart(10)}   BECOMES`);
    for (const { row, rim } of willFillReplayable) {
      console.log(`  ${normTicker(row.ticker).padEnd(8)}${row.handle_low_date.padEnd(13)}${rim.toFixed(2).padStart(10)}   FULLY REPLAYABLE`);
    }
    for (const { row, rim, missing } of willFillIncomplete) {
      console.log(`  ${normTicker(row.ticker).padEnd(8)}${row.handle_low_date.padEnd(13)}${rim.toFixed(2).padStart(10)}   filled, still missing ${missing}`);
    }
  }

  // ---- summary -------------------------------------------------------------
  console.log("\n--- COVERAGE ----------------------------------------------------");
  console.log(`  setups with breakout_level NULL              : ${nullRim.length}`);
  console.log(`    → would fill AND become fully replayable   : ${willFillReplayable.length}`);
  console.log(`    → would fill but still missing stop/target : ${willFillIncomplete.length}`);
  console.log(`    → stay NULL (no archive coverage)          : ${stayNull.length}`);
  console.log(`    → stay NULL (skipped, conflicting rims)    : ${stayNullConflict.length}`);
  console.log(`  archive keys already filled in the DB (no-op): ${alreadyFilled.length}`);
  console.log(`  archive keys with NO matching DB row         : ${noDbRow.length}   (reported only — never inserted)`);
  console.log(`  archive keys skipped for conflicting rims    : ${conflictKeys.size}`);

  if (stayNull.length) {
    const sample = stayNull.slice(0, 15).map((r) => `${normTicker(r.ticker)}@${r.handle_low_date}`);
    console.log(`\n  no archive coverage (first ${sample.length} of ${stayNull.length}): ${sample.join("  ")}`);
    console.log("  (expect the pre-2026-07-15 cohort here — those rows have no geometry at all)");
  }
  if (stayNullConflict.length) {
    console.log(`\n  left NULL by a rim conflict: ${stayNullConflict.map((r) => `${normTicker(r.ticker)}@${r.handle_low_date}`).join("  ")}`);
  }
  if (noDbRow.length) {
    const sample = noDbRow.slice(0, 15);
    console.log(`\n  in the archive but never went through JACK (first ${sample.length} of ${noDbRow.length}):`);
    console.log(`  ${sample.join("  ")}`);
    console.log("  NOT inserted — they carry no AI decision and would pollute the overlay analysis.");
  }

  // ---- 5. apply ------------------------------------------------------------
  const toWrite = [...willFillReplayable, ...willFillIncomplete];
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. ${toWrite.length} row(s) would be updated.`);
    console.log("Re-run with --apply to write. Only setups.breakout_level is touched, only where NULL.\n");
    db.close();
    return 0;
  }
  if (toWrite.length === 0) {
    console.log("\nNothing to apply.\n");
    db.close();
    return 0;
  }

  const stmt = db.prepare(
    `UPDATE setups SET breakout_level = ?
      WHERE TRIM(UPPER(ticker)) = ? AND handle_low_date = ? AND breakout_level IS NULL`
  );
  let updated = 0;
  const tx = db.transaction(() => {
    for (const { row, rim } of toWrite) {
      updated += stmt.run(rim, normTicker(row.ticker), row.handle_low_date).changes;
    }
  });
  tx();

  const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM setups WHERE breakout_level IS NULL`).get() as { n: number }).n;
  const replayable = (
    db.prepare(
      `SELECT COUNT(*) AS n FROM setups
        WHERE breakout_level IS NOT NULL AND stop IS NOT NULL AND t05_target IS NOT NULL`
    ).get() as { n: number }
  ).n;

  console.log(`\nAPPLIED — ${updated} row(s) updated.`);
  console.log(`  setups still missing a rim : ${remaining}`);
  console.log(`  setups now fully replayable: ${replayable}`);
  console.log("  These are all pre-gate; the outcome tracker resolves them as they mature (~Nov onward).\n");
  db.close();
  return 0;
}

process.exit(main());

export {};
