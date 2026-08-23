/*
 * JACK daily pipeline, PHASE 3 — FRESH / AGING entry_status stamp.
 *
 * Post-processes the watchlist CSV the detector produced, adding four columns per
 * row so the alert can tell a breakout still at backtest parity from one that is
 * only enterable on a pullback:
 *
 *     confirmed_close_date   the bar whose CLOSE first cleared the rim
 *     days_since_confirm     calendar days since that close
 *     bars_since_confirm     TRADING bars since that close
 *     entry_status           FRESH | AGING | PENDING | UNKNOWN
 *
 * Run:
 *   npx tsx scripts/jack-stamp-entry-status.ts --watchlist <csv> --corpus <dir>
 *                                              [--date YYYY-MM-DD] [--dry-run]
 *
 * =========================================================================
 * WHY THIS IS TYPESCRIPT AND NOT PYTHON  (the load-bearing decision)
 * =========================================================================
 *
 * The rest of the pipeline is Python. This step is not, for exactly one reason:
 * PREDICATE PARITY.
 *
 * "This setup confirmed" already has ONE definition in this codebase —
 * `detectFire` in lib/jack/outcome-tracker.ts — and lib/jack/promotion.ts is
 * emphatic that there must never be a second:
 *
 *     "there is no second implementation of the rule anywhere in the codebase,
 *      and there must never be one. Re-implementing it is how the 2026-07-31
 *      parity bug (intraday-high fire, 130-bar search) got in."
 *
 * A Python port of detectFire would be that second implementation. It would pass
 * its tests on day one and drift on the day someone tunes CONFIRM_WINDOW_BARS or
 * the strict-`>` in one language and not the other — re-creating the alert-vs-board
 * divergence one layer up, which is the specific failure this phase was told to
 * avoid. So this step imports the SAME function the board-side promoter calls.
 * Not a copy of the rule. The rule.
 *
 *     isPromotedToLive()  ->  detectFire(sorted, handleLowDate, breakout)
 *     this stamper        ->  detectFire(sorted, handleLowDate, breakout)
 *
 * Same module, same constant, same comparison, same window, same rim source
 * (setups.breakout_level / the CSV's breakout_level column). Identical by
 * construction rather than by inspection.
 *
 * =========================================================================
 * THE STATUS RULES
 * =========================================================================
 *
 * The stamp answers exactly one question — HOW OLD IS THE CONFIRMATION? — and
 * it is driven by DAYS SINCE CONFIRM. It never compares current price to the
 * rim, to `entry`, or to anything else (see NO PRICE-VS-RIM LOGIC below).
 *
 *   FRESH   confirmed on the MOST RECENT close. The modeled fill — the next
 *           session's open — has not happened yet, so the trade is still
 *           available at backtest parity. The 2.24 book.
 *
 *   AGING   confirmed earlier: the modeled open has passed. Off-parity, so
 *           pullback-to-entry only, which restores the original R:R without
 *           improving it. The 1.83 book. FLAGGED, NEVER AUTO-SKIPPED — that
 *           call is the operator's, and there is no upper bound at which it
 *           stops being offered.
 *
 *   PENDING no confirming close yet. Not a fire, so it has no entry age. This
 *           covers BOTH detectFire outcomes that are not a fire — window still
 *           open ("deferred") and window elapsed unconfirmed ("never_fired").
 *
 *   UNKNOWN cannot be evaluated: no rim, or no bars for the ticker. FAIL CLOSED,
 *           mirroring promotion.ts — a missing rim is NEVER substituted with
 *           `entry` or anything else, it just is not judged.
 *
 * =========================================================================
 * WHY THERE IS NO "STALE"  (validated FALSE, 2026-08-22 backtest handoff)
 * =========================================================================
 *
 * An earlier revision of this file had a third label, STALE, covering a fire
 * whose entry window had elapsed. It has been REMOVED, not renamed, because the
 * premise under it was tested and did not hold:
 *
 *   Sub-rim fills are BETTER, not worse — below-rim PF 2.65 vs above-rim 2.21,
 *   monotone across the sweep and holding out-of-sample.
 *
 * An aged setup trading back under its rim is therefore not a degraded entry to
 * be skipped; it is the population the pullback book is built on. Expiring it
 * would have discarded the better half of the distribution. So AGING has no
 * upper bound and ENTRY_WINDOW_BARS is gone.
 *
 * NO PRICE-VS-RIM LOGIC ANYWHERE IN THIS FILE. The only close-vs-rim comparison
 * in the whole path lives inside detectFire, and it answers "was there ever a
 * confirming breakout?" — a historical fact about one past bar. Nothing here
 * asks where price is trading NOW relative to the rim, and nothing skips on it.
 *
 * PENDING EXPIRY IS NOT THIS FILE'S JOB EITHER. A setup that never confirmed is
 * governed upstream by the dsl<=15 staleness filter (MAX_HANDLE_DAYS in
 * lib/jack/validation-core.ts, and apply_staleness_filter in the weekly
 * notebook), which already drops the weak tail (dsl>15, PF 1.63). Adding a
 * second, join-window expiry here would double-filter the same population on a
 * rule nobody validated. So "never_fired" is PENDING, exactly like "deferred".
 *
 * FRESH depends on the corpus being current: "the most recent close" is the last
 * bar on disk. The Phase 1 Tiingo pull must have run before the detector, or
 * every fire looks a day older than it is. The summary warns when the corpus's
 * last bar predates the run date.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectFire, CONFIRM_WINDOW_BARS, type Bar } from "../lib/jack/outcome-tracker";
import { normKey, normNum, normPositive, normTicker, splitCsvLine, detectDelim } from "../lib/jack/archive-csv";

// ============================================================
// Configuration
// ============================================================

// There is deliberately NO entry-window constant here. AGING is unbounded: the
// 2026-08-22 handoff validated that sub-rim fills outperform (PF 2.65 vs 2.21),
// so an aged setup is never expired out of the pullback book. See WHY THERE IS
// NO "STALE" above. CONFIRM_WINDOW_BARS still governs whether a breakout counts
// as a confirmation at all, inside detectFire — that is a different question.

export type EntryStatus = "FRESH" | "AGING" | "PENDING" | "UNKNOWN";

export const STAMP_COLUMNS = [
  "confirmed_close_date",
  "days_since_confirm",
  "bars_since_confirm",
  "entry_status",
] as const;

// ============================================================
// Pure classification — unit-tested by jack-entry-status-selftest.ts
// ============================================================

export interface StampInput {
  handleLowDate: string;
  breakout: number | null;
  bars: Bar[];
  /** ET run date, YYYY-MM-DD. Used only for the calendar-day count. */
  today: string;
}

export interface Stamp {
  entryStatus: EntryStatus;
  confirmedCloseDate: string | null;
  daysSinceConfirm: number | null;
  barsSinceConfirm: number | null;
  /** Why, for the log. Never emitted to the CSV. */
  detail: string;
}

const UNKNOWN = (detail: string): Stamp => ({
  entryStatus: "UNKNOWN",
  confirmedCloseDate: null,
  daysSinceConfirm: null,
  barsSinceConfirm: null,
  detail,
});

/** Calendar days between two YYYY-MM-DD dates (UTC-anchored, DST-immune). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Classify one setup. The ONLY place entry_status is decided.
 *
 * Delegates the confirm test wholesale to detectFire — this function contributes
 * no opinion about what "confirmed" means, only about how old a confirmation is.
 */
export function classifyEntryStatus(input: StampInput): Stamp {
  // FAIL CLOSED on a missing rim, exactly as isPromotedToLive does.
  if (input.breakout == null || !Number.isFinite(input.breakout) || input.breakout <= 0) {
    return UNKNOWN("no rim — cannot window-validate (never substituted with entry)");
  }
  if (input.bars.length === 0) {
    return UNKNOWN("no bars for this ticker in the corpus");
  }

  const sorted = [...input.bars].sort((a, b) => a.date.localeCompare(b.date));
  const fire = detectFire(sorted, input.handleLowDate, input.breakout);

  if (fire.status === "deferred") {
    return {
      entryStatus: "PENDING",
      confirmedCloseDate: null,
      daysSinceConfirm: null,
      barsSinceConfirm: null,
      detail: fire.reason ?? `confirm window still open (${fire.barsInWindow}/${CONFIRM_WINDOW_BARS})`,
    };
  }

  if (fire.status === "never_fired") {
    // PENDING, not a third label. No confirmation means no entry age to report.
    // Whether this setup should still be on the watchlist at all is the dsl<=15
    // filter's call, upstream — not this file's.
    return {
      entryStatus: "PENDING",
      confirmedCloseDate: null,
      daysSinceConfirm: null,
      barsSinceConfirm: null,
      detail: `confirm window elapsed (${CONFIRM_WINDOW_BARS} bars) with no close above the rim`,
    };
  }

  const fireDate = fire.fireDate as string;
  const fireIndex = fire.fireIndex as number;
  const barsSince = sorted.length - 1 - fireIndex;
  const daysSince = calendarDaysBetween(fireDate, input.today);

  // A two-state split on TIME SINCE CONFIRM, with no upper bound. Note that at
  // the only threshold that exists — zero — "days since" and "bars since" are
  // the same statement: the confirming close either IS the most recent close or
  // it is not. So the bars/calendar-days distinction cannot change a verdict.
  const entryStatus: EntryStatus = barsSince === 0 ? "FRESH" : "AGING";
  const detail =
    barsSince === 0
      ? // The confirming close IS the latest close, so the modeled fill (the next
        // session's open) has not happened yet. Backtest parity intact.
        "confirmed on the most recent close — next open is takeable (2.24 book)"
      : `modeled next-open passed ${barsSince} session(s) ago — pullback-to-entry only (1.83 book)`;

  return {
    entryStatus,
    confirmedCloseDate: fireDate,
    daysSinceConfirm: daysSince,
    barsSinceConfirm: barsSince,
    detail,
  };
}

// ============================================================
// Corpus bars
// ============================================================

/** Read one <TICKER>.csv from the Phase 1 corpus into Bars. Null when absent. */
export function readCorpusBars(corpusDir: string, ticker: string): Bar[] | null {
  const path = join(corpusDir, `${ticker}.csv`);
  if (!existsSync(path)) return null;

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const delim = detectDelim(lines[0]);
  const header = splitCsvLine(lines[0], delim).map(normKey);
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("date");
  const iOpen = idx("open");
  const iHigh = idx("high");
  const iLow = idx("low");
  const iClose = idx("close");
  const iVol = idx("volume");
  if (iDate < 0 || iClose < 0) return null;

  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delim);
    const date = (cells[iDate] ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const close = normNum(cells[iClose]);
    if (close == null) continue;
    bars.push({
      date,
      open: normNum(cells[iOpen] ?? "") ?? close,
      high: normNum(cells[iHigh] ?? "") ?? close,
      low: normNum(cells[iLow] ?? "") ?? close,
      close,
      volume: (iVol >= 0 ? normNum(cells[iVol] ?? "") : null) ?? 0,
    });
  }
  return bars.length > 0 ? bars : null;
}

// ============================================================
// CSV stamping
// ============================================================

export interface StampReport {
  rows: number;
  counts: Record<EntryStatus, number>;
  corpusLastBar: string | null;
  missingCorpus: string[];
  rimless: string[];
}

function emptyCounts(): Record<EntryStatus, number> {
  return { FRESH: 0, AGING: 0, PENDING: 0, UNKNOWN: 0 };
}

export function stampCsv(
  csvText: string,
  corpusDir: string,
  today: string
): { text: string; report: StampReport } {
  const report: StampReport = {
    rows: 0,
    counts: emptyCounts(),
    corpusLastBar: null,
    missingCorpus: [],
    rimless: [],
  };

  const lines = csvText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length < 1) return { text: csvText, report };

  const delim = detectDelim(lines[0]);
  const headerCells = splitCsvLine(lines[0], delim);
  const normHeader = headerCells.map(normKey);

  const col = (...names: string[]) => {
    for (const n of names) {
      const i = normHeader.indexOf(normKey(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iTicker = col("ticker");
  const iHandle = col("handle_low_date");
  const iRim = col("breakout_level", "breakout", "cup_rim", "rim");

  if (iTicker < 0 || iHandle < 0) {
    throw new Error(
      `watchlist is missing ticker and/or handle_low_date (header: ${headerCells.join(",")})`
    );
  }

  // Idempotent: re-stamping a stamped file replaces the columns rather than
  // appending a second copy.
  const keep = normHeader
    .map((h, i) => (STAMP_COLUMNS.includes(h as (typeof STAMP_COLUMNS)[number]) ? -1 : i))
    .filter((i) => i >= 0);

  const out: string[] = [
    [...keep.map((i) => headerCells[i]), ...STAMP_COLUMNS].join(","),
  ];

  const barCache = new Map<string, Bar[] | null>();

  for (let li = 1; li < lines.length; li++) {
    if (lines[li].trim() === "") continue;
    const cells = splitCsvLine(lines[li], delim);
    report.rows++;

    const ticker = normTicker(cells[iTicker] ?? "");
    const handleLowDate = (cells[iHandle] ?? "").trim().slice(0, 10);
    const rim = iRim >= 0 ? normPositive(cells[iRim]) : null;

    if (!barCache.has(ticker)) barCache.set(ticker, readCorpusBars(corpusDir, ticker));
    const bars = barCache.get(ticker) ?? null;

    if (bars && bars.length) {
      const last = bars[bars.length - 1].date;
      if (report.corpusLastBar === null || last > report.corpusLastBar) report.corpusLastBar = last;
    }

    const stamp = classifyEntryStatus({
      handleLowDate,
      breakout: rim,
      bars: bars ?? [],
      today,
    });

    if (stamp.entryStatus === "UNKNOWN") {
      if (rim == null) report.rimless.push(ticker);
      else if (!bars) report.missingCorpus.push(ticker);
    }
    report.counts[stamp.entryStatus]++;

    out.push(
      [
        ...keep.map((i) => cells[i] ?? ""),
        stamp.confirmedCloseDate ?? "",
        stamp.daysSinceConfirm ?? "",
        stamp.barsSinceConfirm ?? "",
        stamp.entryStatus,
      ].join(",")
    );
  }

  return { text: out.join("\n") + "\n", report };
}

// ============================================================
// CLI
// ============================================================

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function main(): number {
  const watchlist = arg("watchlist");
  const corpus = arg("corpus");
  const dryRun = process.argv.includes("--dry-run");
  const today = arg("date") ?? new Date().toISOString().slice(0, 10);

  if (!watchlist || !corpus) {
    console.error(
      "usage: npx tsx scripts/jack-stamp-entry-status.ts --watchlist <csv> --corpus <dir> [--date YYYY-MM-DD] [--dry-run]"
    );
    return 2;
  }
  if (!existsSync(watchlist)) {
    console.error(`watchlist not found: ${watchlist}`);
    return 2;
  }
  if (!existsSync(corpus)) {
    console.error(`corpus directory not found: ${corpus}`);
    return 2;
  }

  let result;
  try {
    result = stampCsv(readFileSync(watchlist, "utf-8"), corpus, today);
  } catch (err) {
    console.error(`stamp failed: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  const { text, report } = result;

  if (!dryRun) {
    // Write-then-rename so a crash cannot leave a half-written watchlist.
    const tmp = `${watchlist}.stamping`;
    writeFileSync(tmp, text, "utf-8");
    renameSync(tmp, watchlist);
  }

  const c = report.counts;
  console.log(
    `entry_status: ${report.rows} rows · FRESH ${c.FRESH} · AGING ${c.AGING} · ` +
      `PENDING ${c.PENDING} · UNKNOWN ${c.UNKNOWN}` +
      (dryRun ? "  (DRY RUN — not written)" : "")
  );
  if (report.rimless.length) {
    console.log(`  rimless (fail closed, never judged): ${report.rimless.slice(0, 10).join(", ")}` +
      (report.rimless.length > 10 ? ` … +${report.rimless.length - 10}` : ""));
  }
  if (report.missingCorpus.length) {
    console.log(`  no corpus file: ${report.missingCorpus.slice(0, 10).join(", ")}` +
      (report.missingCorpus.length > 10 ? ` … +${report.missingCorpus.length - 10}` : ""));
  }
  if (report.corpusLastBar && report.corpusLastBar < today) {
    console.log(
      `  ⚠ corpus last bar is ${report.corpusLastBar}, run date is ${today} — ` +
        `"most recent close" is stale, so FRESH may be under-reported. Did the Tiingo pull run?`
    );
  }

  // Machine-readable last line for pipeline/run_detector.py.
  console.log(`STAMP_JSON ${JSON.stringify(report)}`);
  return 0;
}

if (process.argv[1] && process.argv[1].includes("jack-stamp-entry-status")) {
  process.exit(main());
}
