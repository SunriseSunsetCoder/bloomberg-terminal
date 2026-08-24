// =============================================================================
// JACK validation core — the PURE layer of the scan-validation pipeline: CSV
// parsing, section filtering, JSON extraction, and interactive-row building. No
// fs, no network, no NextRequest — deterministic + unit-testable.
//
// Lives in lib/ (NOT the route) because Next route files may ONLY export handlers
// + config; applyFilters / buildClientDecisions are imported by selftests, so they
// can't be exported from the route module. The route imports this layer and keeps
// only the I/O (prompt fs-load, Tiingo enrichment, the Anthropic call, persistence,
// and the POST handler).
// =============================================================================
import {
  bucketForScore,
  normalizeDepthPct,
  computeSizing,
  recommendedSizing,
  type SizeBucket,
} from "@/lib/jack/handle-score";
import { normalizeIsoDate } from "@/lib/jack/reconcile";
// Type-only imports compile away — safe on Vercel where the DB layer never loads.
import type { InsertedDecisionId } from "@/lib/db/write";
import type { UserMark } from "@/lib/db/read";

// ============================================================
// Configuration (shared with the route)
// ============================================================
export const DEFAULT_RISK_PER_TRADE = 2000;

// VALIDATED FILTER (May 2026 winner-vs-loser test):
// Applied to BOTH sections — handles >15d underperform regardless of breakout status.
export const MAX_HANDLE_DAYS = 15;

// Section caps
const MAX_LIVE_SETUPS = 30; // session-cap math
const MAX_PENDING_SETUPS = 50; // pending = watchlist, may fall off, larger cap

// Status classification
const LIVE_STATUSES = new Set(["just_fired", "recent_breakout"]);
const PENDING_STATUSES = new Set(["pending"]);

// Live section ordering (untested heuristic)
const LIVE_STATUS_PRIORITY: Record<string, number> = {
  just_fired: 0,
  recent_breakout: 1,
};

// ============================================================
// Types
// ============================================================

export interface ParsedSetup {
  raw: string;
  rowCols: string[];
  ticker: string;
  status: string;
  handleLowDate: string;
  daysSinceHandleLow: number;
  isValid: boolean;
  invalidReason?: string;
  // Geometry parsed from the scanner CSV (when present). Stored on the setups row
  // so the Session B outcome replay can fire/exit against real price levels.
  entry?: number;
  stop?: number;
  t05Target?: number;
  breakoutLevel?: number;
  cupDepthPct?: number;
  handleRetrPct?: number;
  // handle_score signal — read straight from the weekly watchlist CSV (primary).
  // sizeBucket falls back to bucketForScore(handleScore) if the CSV omits it.
  handleScore?: number;
  sizeBucket?: SizeBucket;
  // Scanner classification columns (additive; parsed by-name, position-agnostic).
  sector?: string; // GICS sector name ("Financials" / "Industrials" / "Unknown")
  tier?: string; // handle quintile "Q3" / "Q4" / "Q5"
  priority?: number; // scanner rank, higher = take first (drives the LIVE sort)
  // ---- Phase 3 entry-freshness stamp (daily pipeline only) -------------------
  // Written onto the watchlist CSV by scripts/jack-stamp-entry-status.ts. A
  // manually pasted (unstamped) CSV simply omits them and they parse as
  // undefined — which CLEARS the stored stamp rather than preserving a stale
  // one. See upsertSetup for why that is the safe direction.
  entryStatus?: EntryStatus;
  confirmedCloseDate?: string;
  daysSinceConfirm?: number;
}

/**
 * The entry-freshness labels the pipeline emits. FRESH/AGING describe how old a
 * CONFIRMED breakout is; PENDING means no confirming close (window open OR
 * elapsed unconfirmed); UNKNOWN means it could not be judged (no rim / no bars).
 *
 * There is deliberately no STALE — sub-rim fills validated better, so an aged
 * fire is never expired. Kept in lockstep with EntryStatus in
 * scripts/jack-stamp-entry-status.ts; anything outside this set is dropped on
 * ingest rather than written.
 */
export type EntryStatus = "FRESH" | "AGING" | "PENDING" | "UNKNOWN";

/**
 * Phase 4 ingest mode.
 *   "required"    — the UI default. A missing ANTHROPIC_API_KEY or a failed call
 *                   is a hard error, exactly as before Phase 4.
 *   "best_effort" — the nightly pipeline. The analysis is garnish: if it cannot
 *                   be produced, the board is still built from the detector
 *                   output and the rows land as UNREVIEWED.
 *
 * Lives here rather than in the route because route.ts may export ONLY handlers
 * and config (Next 16) — and because pipeline/ingest.py's selftest imports it.
 */
export type AnalysisMode = "required" | "best_effort";

/**
 * The nightly floor guard's threshold: a run carrying under half the prior
 * board's setups is treated as a broken scan, not a real shrink.
 */
export const FLOOR_GUARD_MIN_FRACTION = 0.5;

/**
 * The placeholder verdict for a row the analysis never graded.
 *
 * PINNED, and the token is load-bearing: classifyVerdict() in lib/jack/verdict.ts
 * is a SUBSTRING match, so anything containing TRADE / SKIP / AVOID / PASS /
 * WATCH / FIRED / EXTENDED classifies as that verdict. "NOT PASSED" would read as
 * SKIP and render the row vetoed. "UNREVIEWED" matches none and falls to "other".
 */
export const UNREVIEWED_DECISION = "UNREVIEWED";

const ENTRY_STATUSES = new Set<string>(["FRESH", "AGING", "PENDING", "UNKNOWN"]);

export interface EnrichedSetup extends ParsedSetup {
  tiingo: {
    eodClose?: number;
    eodDate?: string;
    eodError?: string;
    newsHeadlines?: string[];
    newsError?: string;
    nextEarningsDate?: string;
    daysToNextEarnings?: number;
    lastEarningsDate?: string;
    daysSinceLastEarnings?: number;
    earningsError?: string;
    earningsNote?: string;
  };
}

export type TiingoData = EnrichedSetup["tiingo"];

export interface SectionStats {
  inputCount: number;
  droppedHandleStale: number;
  droppedOverCap: number;
  finalCount: number;
}

export interface FilterStats {
  inputRowCount: number;
  live: SectionStats;
  pending: SectionStats;
  totalFinal: number;
  tiingoCallsAttempted: number;
  tiingoCallsSucceeded: number;
}

// One row for the interactive decision table (Session B). Bound to the parsed
// JSON decisions block, enriched with DB ids (null when persistence is off, e.g.
// on Vercel) and the setup geometry the user_R display needs.
export interface JackDecisionClient {
  decisionId: number | null;
  setupId: number | null;
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending" | "open";
  decision: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  // v2 expandable-row content, plumbed from the already-parsed JSON decision +
  // enriched Tiingo data (presentation only — no new fetch or logic).
  shares: number | null;
  breakout: number | null;
  currentPrice: number | null;
  note: string | null;
  newsClass: string | null;
  sectorRs: string | null;
  crossAsset: string | null;
  earningsFlag: string | null;
  pctToBreakout: number | null;
  // Bug A re-hydration: existing user marks for this setup (from prior runs),
  // so re-VALIDATE re-displays them instead of rendering blank. Read-only;
  // new writes still target the current run's decision row.
  userAction: "TRADED" | "PASSED" | "WATCHED" | null;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
  // Frozen decision-time context (present only on marked rows): JACK's verdict +
  // shares as they were when the user marked. `decision`/`shares` above stay LIVE
  // (current re-assessment); these hold the mark-time snapshot.
  jackDecisionAtMark: string | null;
  sharesAtMark: number | null;
  // Close-confirmed FIRE flag (display status). Set by the 18:00 EOD entry pass;
  // `section` is NOT changed by a fire — Phase 2 re-sections for display only.
  firedAt?: string | null;
  fireClose?: number | null;
  fireBar?: number | null;
  firedStatus?: "confirmed" | "late" | "resolved" | null;
  /** The DB section BEFORE any DISPLAY re-sectioning (set only when a row moves). */
  dbSection?: "live" | "pending" | null;
  // handle_score signal (recommendation — the user decides and sizes).
  handleScore: number | null;
  sizeBucket: SizeBucket | null; // FULL / HALF / SKIP directive
  // Scanner classification columns (setup-level facts, joined like sizeBucket).
  sector: string | null; // GICS sector name
  tier: string | null; // handle quintile Q3/Q4/Q5
  priority: number | null; // scanner rank, higher = take first
  // Handle/cup geometry (parsed; fed handle_score) — surfaced for the expand's
  // SETUP GEOMETRY line so the pattern shape is readable, not just its score.
  cupDepthPct: number | null; // cup depth %
  handleRetrPct: number | null; // handle retracement %
  daysSinceHandleLow: number | null; // calendar days since the handle low, as the detector measured it
  // ---- Phase 3 entry freshness ----------------------------------------------
  // FRESH (next open takeable, 2.24 book) / AGING (pullback-to-entry only, 1.83
  // book) / PENDING / UNKNOWN. Carried by BOTH render paths on purpose: a live
  // VALIDATE fills these from the parsed CSV, GET /api/jack-board fills them from
  // setups. If only one path carried them the terminal would show a different
  // board depending on how it was loaded.
  entryStatus: string | null;
  confirmedCloseDate: string | null;
  daysSinceConfirm: number | null;
  // Concrete shares/notional at each size, from risk/trade ÷ stop distance. The
  // user sees "FULL — 340 sh / $47,600" and makes the call. Null if geometry is
  // missing or stop >= entry.
  fullShares: number | null;
  fullNotional: number | null;
  halfShares: number | null;
  halfNotional: number | null;
  // The recommended-bucket cut of the above (null for SKIP) — what the headline shows.
  recShares: number | null;
  recNotional: number | null;
}

// ============================================================================
// THE SHARED EXIT — every render path leaves through finalizeClientDecisions.
//
// There are two ways a board reaches the terminal: a live VALIDATE
// (buildClientDecisions) and a page load (GET /api/jack-board, via
// buildHydratedDecisions). They start from different sources — parsed LLM output
// + enriched setups on one side, a SQLite row join + a Redis price store on the
// other — and every time they have been allowed to finish independently they have
// drifted:
//
//   · entry_status was emitted by one and not the other (dc94942)
//   · currentPrice arrived as {price,source,asOf} from the price store while the
//     client type promised number, so the price ladder called .toFixed on an
//     object and the row crashed on expand
//   · LIVE came out priority-sorted from VALIDATE and alphabetical from
//     hydration, because the sort lived at the tail of buildClientDecisions
//
// Same class of bug three times: the divergence is possible, so eventually it
// happens. This function is the fix for the class, not the instances. Both paths
// end with `return finalizeClientDecisions(rows)`, so type and order are settled
// in ONE place and a new path cannot get them wrong by omission.
//
// scripts/jack-render-path-parity-selftest.ts holds this contract to runtime
// typeof + ticker-sequence equality on both paths.
// ============================================================================

/**
 * Every numeric field of JackDecisionClient, enumerated ONCE.
 *
 * Two things must agree about this list: finalizeClientDecisions (which coerces
 * them) and the parity selftest (which asserts their runtime typeof). The
 * selftest also checks the list has not gone stale — any key that arrives as a
 * number on either path but is absent here is a coercion hole, and it fails.
 */
export const NUMERIC_DECISION_FIELDS = [
  "decisionId", "setupId", "entry", "stop", "target", "shares", "breakout",
  "currentPrice", "pctToBreakout", "userEntryPrice", "userExitPrice",
  "sharesAtMark", "fireClose", "fireBar", "handleScore", "priority",
  "cupDepthPct", "handleRetrPct", "daysSinceHandleLow", "daysSinceConfirm",
  "fullShares", "fullNotional", "halfShares", "halfNotional",
  "recShares", "recNotional",
] as const;

/**
 * Anything → a finite number, or null. The last gate before a numeric field
 * reaches the client.
 *
 * The UNWRAP is deliberate and narrow. The Redis price store holds
 * `{ price, source, asOf }` per ticker (StoredPrices in lib/jack/price-refresh),
 * and a reader that forgets `.price` hands the whole object to a field the client
 * type says is a number. Coercing that with Number() yields NaN — which is
 * strictly WORSE than the crash it replaces, because NaN passes every `!= null`
 * guard and silently renders a blank ladder instead of throwing somewhere a
 * stack trace can be read. So the wrapper is unwrapped by name, and everything
 * that is not a finite number after that becomes null.
 *
 * Numeric strings are accepted too — a JSON round-trip or a TEXT-affinity column
 * can hand back "101.5", and null is a worse answer than the number it plainly is.
 */
export function toFiniteNumber(v: unknown): number | null {
  if (v == null) return null;
  // Explicit unwrap of the price-store wrapper. Named shape only — this is not a
  // general "pull a number out of any object", which would hide real shape bugs.
  if (typeof v === "object" && !Array.isArray(v)) {
    const inner = (v as { price?: unknown }).price;
    return typeof inner === "number" && Number.isFinite(inner) ? inner : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const BUCKET_SORT_RANK: Record<string, number> = { full: 0, half: 1, skip: 2 };

/**
 * Within-section ordering: priority DESC (nulls last, LIVE only) → size_bucket
 * (full → half → skip) → handle_score DESC → ticker ASC → handleLowDate ASC.
 *
 * The final tiebreak is DATA, not arrival index. It used to be `a.i - b.i`, which
 * reads as "stable" but silently means "whatever order the caller happened to
 * build the array in" — LLM emit order on the VALIDATE path, `ORDER BY s.ticker`
 * on the hydration path. Two paths cannot agree on an order defined by how they
 * were called, so exact ties now break alphabetically and the board's order is
 * reproducible from the rows alone.
 */
function sortWithinSection(list: JackDecisionClient[], usePriority: boolean): JackDecisionClient[] {
  return [...list].sort((a, b) => {
    if (usePriority && (a.priority ?? null) !== (b.priority ?? null)) {
      if (a.priority == null) return 1; // nulls last
      if (b.priority == null) return -1;
      return b.priority - a.priority; // higher priority first
    }
    const ba = a.sizeBucket ? BUCKET_SORT_RANK[a.sizeBucket] ?? 3 : 3;
    const bb = b.sizeBucket ? BUCKET_SORT_RANK[b.sizeBucket] ?? 3 : 3;
    if (ba !== bb) return ba - bb;
    const sa = a.handleScore ?? Number.NEGATIVE_INFINITY;
    const sb = b.handleScore ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    const t = a.ticker.localeCompare(b.ticker);
    if (t !== 0) return t;
    return a.handleLowDate.localeCompare(b.handleLowDate);
  });
}

/**
 * Coerce every numeric field, then order both sections. The single exit both
 * render paths return through — see the block comment above.
 *
 * Rows whose section is neither live nor pending (a client-side "open" row) are
 * passed through untouched at the end rather than dropped; no server path emits
 * them today, and silently losing a row is not a thing a normalizer should do.
 */
export function finalizeClientDecisions(rows: JackDecisionClient[]): JackDecisionClient[] {
  const coerced = rows.map((d) => {
    const out: Record<string, unknown> = { ...d };
    for (const f of NUMERIC_DECISION_FIELDS) {
      if (f in out) out[f] = toFiniteNumber(out[f]);
    }
    return out as unknown as JackDecisionClient;
  });
  return [
    ...sortWithinSection(coerced.filter((d) => d.section === "live"), true),
    ...sortWithinSection(coerced.filter((d) => d.section === "pending"), false),
    ...coerced.filter((d) => d.section !== "live" && d.section !== "pending"),
  ];
}

export interface SectionedSetups {
  live: ParsedSetup[];
  pending: ParsedSetup[];
  stats: FilterStats;
}

export interface ExtractedDecision {
  ticker?: string;
  handle_low_date?: string;
  decision?: string;
  shares?: number;
  notional?: number;
  earnings_flag?: string;
  live_close_delta_pct?: number;
  pct_to_breakout?: number;
  news_class?: string;
  sector_rs?: string;
  cross_asset?: string;
  notes?: string;
}

export interface ExtractedPayload {
  schema_version?: string;
  live_decisions?: ExtractedDecision[];
  pending_decisions?: ExtractedDecision[];
}

// ============================================================
// CSV parsing — auto-detects comma, tab, or multi-space delimiter
// ============================================================

function detectDelimiter(headerLine: string): string {
  if (headerLine.includes("\t")) return "\t";
  if (headerLine.includes(",")) return ",";
  if (/\s{2,}/.test(headerLine)) return "MULTI_SPACE";
  return ",";
}

function splitByDelimiter(line: string, delim: string): string[] {
  if (delim === "MULTI_SPACE") {
    return line.split(/\s+/).filter((s) => s.length > 0);
  }
  return line.split(delim).map((c) => c.trim());
}

/**
 * One-shot guard so the wall-clock-fallback warning fires ONCE per applyFilters
 * run rather than once per row. Reset at the top of applyFilters.
 */
let warnedStalenessFallback = false;

function parseCsvRow(headerCols: string[], rowLine: string, today: Date, delim: string): ParsedSetup {
  const cols = splitByDelimiter(rowLine, delim);
  // Match columns by a NORMALIZED header name, not exact indexOf. The scanner's
  // size_bucket / handle_score weren't being read even though they're in the CSV —
  // an exact-string match is brittle to a UTF-8 BOM on the first field, surrounding
  // quotes ("handle_score"), header casing, or space/hyphen instead of underscore.
  // Normalizing both sides makes the by-name lookup resilient. This does NOT touch
  // the raw CSV line handed to the LLM (s.raw) — determinism unchanged.
  const normKey = (s: string) => {
    const t = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; // strip a leading UTF-8 BOM
    return t.replace(/["']/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  };
  const headerIndex = new Map<string, number>();
  headerCols.forEach((h, i) => {
    const k = normKey(h);
    if (k && !headerIndex.has(k)) headerIndex.set(k, i);
  });
  const get = (name: string): string | undefined => {
    const idx = headerIndex.get(normKey(name));
    if (idx === undefined || idx >= cols.length) return undefined;
    return cols[idx];
  };

  const ticker = (get("ticker") ?? "").toUpperCase();
  const status = (get("status") ?? "").toLowerCase();
  const handleLowDateRaw = get("handle_low_date") ?? "";

  // Geometry columns — optional, best-effort numeric parse. Accepts a few header
  // aliases the scanner has used across versions.
  const getNum = (...names: string[]): number | undefined => {
    for (const n of names) {
      const v = get(n);
      if (v === undefined || v === "") continue;
      const num = Number(v.replace(/[$,%\s]/g, ""));
      if (Number.isFinite(num)) return num;
    }
    return undefined;
  };
  const entry = getNum("entry", "entry_price");
  const stop = getNum("stop", "stop_price", "stop_loss");
  const t05Target = getNum("t05_target", "target", "t05");
  const breakoutLevel = getNum("breakout_level", "breakout", "cup_rim", "rim");
  // UNIT MISMATCH FIX: cup_depth_pct / handle_retr_pct arrive as FRACTIONS (0.15)
  // on recent_breakout rows but PERCENTS (14.5) on just_fired/pending. Normalize to
  // percent on ingest so the stored value + any depth display is coherent. Does NOT
  // feed handle_score, and does NOT touch the raw CSV line the LLM sees (determinism
  // preserved) — only the parsed numeric that lands in the DB.
  const cupDepthPct = normalizeDepthPct(getNum("cup_depth_pct", "cup_depth")) ?? undefined;
  const handleRetrPct = normalizeDepthPct(getNum("handle_retr_pct", "handle_retracement_pct")) ?? undefined;

  // handle_score signal — PRIMARY path: read score + bucket straight from the CSV
  // (the scanner now emits them). FALLBACK: derive the bucket from the score via the
  // frozen edges if the CSV carried a score but no bucket.
  const handleScore = getNum("handle_score", "hscore", "handle_quality_score");
  const bucketRaw = (get("size_bucket") ?? get("bucket") ?? "").toLowerCase().trim();
  let sizeBucket: SizeBucket | undefined =
    bucketRaw === "full" || bucketRaw === "half" || bucketRaw === "skip" ? bucketRaw : undefined;
  if (sizeBucket === undefined && handleScore !== undefined) {
    sizeBucket = bucketForScore(handleScore) ?? undefined;
  }

  // Scanner classification columns (by-name lookup — order-agnostic; a missing
  // column just yields undefined, never an error). sector/tier are pass-through
  // strings; priority is a float rank.
  const sector = (get("sector") ?? "").trim() || undefined;
  const tier = (get("tier") ?? "").trim() || undefined;
  const priority = getNum("priority", "prio");

  // Phase 3 freshness stamp. entry_status is validated against the closed label
  // set — an unrecognised token is DROPPED, never written, so a typo or a future
  // label from a newer stamper cannot land junk in the column. bars_since_confirm
  // is deliberately not read: it is the stamper's decision variable, already
  // reflected in entry_status, and derivable from confirmed_close_date.
  const entryStatusRaw = (get("entry_status") ?? "").trim().toUpperCase();
  const entryStatus = ENTRY_STATUSES.has(entryStatusRaw)
    ? (entryStatusRaw as EntryStatus)
    : undefined;
  const confirmedCloseDate = normalizeIsoDate(get("confirmed_close_date") ?? "") ?? undefined;
  const daysSinceConfirmRaw = getNum("days_since_confirm");
  const daysSinceConfirm =
    daysSinceConfirmRaw !== undefined && Number.isFinite(daysSinceConfirmRaw)
      ? Math.round(daysSinceConfirmRaw)
      : undefined;

  if (!ticker || !handleLowDateRaw) {
    return {
      raw: rowLine, rowCols: cols, ticker, status,
      handleLowDate: handleLowDateRaw, daysSinceHandleLow: NaN,
      isValid: false, invalidReason: "missing ticker or handle_low_date",
    };
  }

  let parsed: Date | null = null;
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(handleLowDateRaw);
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(handleLowDateRaw);
  if (isoMatch) {
    parsed = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  } else if (usMatch) {
    parsed = new Date(parseInt(usMatch[3]), parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
  }

  if (!parsed || isNaN(parsed.getTime())) {
    return {
      raw: rowLine, rowCols: cols, ticker, status,
      handleLowDate: handleLowDateRaw, daysSinceHandleLow: NaN,
      isValid: false, invalidReason: `unparseable handle_low_date: ${handleLowDateRaw}`,
    };
  }

  // PREFER the CSV's own days_since_handle_low.
  //
  // The detector anchors it to the data's LAST BAR (ASOF_DATE in
  // cup_handle_weekly.ipynb), which makes it deterministic — re-running the same
  // scan yields the same number. Recomputing it here would re-anchor to JACK's
  // wall clock and re-introduce exactly the drift the notebook fix removed: the
  // two disagree whenever ingest and the last bar fall on different days, i.e.
  // corpus lag, a retried run, or a weekend/holiday gap. Reading the column
  // instead makes the CSV authoritative and the terminal agree with the file.
  //
  // The subtraction survives only as a fallback for a CSV that predates the fix
  // or was hand-built without the column — and it warns when it fires, because
  // silently substituting a different definition of staleness is precisely the
  // kind of quiet degradation this codebase keeps paying for.
  const csvDays = getNum("days_since_handle_low", "dsl");
  const msPerDay = 1000 * 60 * 60 * 24;
  let days: number;
  if (csvDays !== undefined && Number.isFinite(csvDays)) {
    days = Math.round(csvDays);
  } else {
    days = Math.floor((today.getTime() - parsed.getTime()) / msPerDay);
    if (!warnedStalenessFallback) {
      warnedStalenessFallback = true;
      console.warn(
        "[jack-validation] days_since_handle_low absent — falling back to a wall-clock " +
          "recompute. Staleness values will NOT match the deterministic pipeline output " +
          "(the detector anchors them to the data's last bar, ASOF_DATE), so the filter " +
          "and the terminal may disagree with the CSV. Likely a hand-pasted pre-fix CSV; " +
          "the nightly pipeline always emits the column."
      );
    }
  }

  return {
    raw: rowLine, rowCols: cols, ticker, status,
    handleLowDate: handleLowDateRaw, daysSinceHandleLow: days,
    isValid: true,
    entry, stop, t05Target, breakoutLevel, cupDepthPct, handleRetrPct,
    handleScore, sizeBucket,
    sector, tier, priority,
    entryStatus, confirmedCloseDate, daysSinceConfirm,
  };
}

// ============================================================
// Filter pipeline — split into Live + Pending sections
// ============================================================

export function applyFilters(rawCsv: string): { headerLine: string; sectioned: SectionedSetups } {
  const lines = rawCsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const emptyStats: SectionStats = { inputCount: 0, droppedHandleStale: 0, droppedOverCap: 0, finalCount: 0 };

  if (lines.length < 2) {
    return {
      headerLine: lines[0] ?? "",
      sectioned: {
        live: [], pending: [],
        stats: {
          inputRowCount: 0,
          live: emptyStats,
          pending: emptyStats,
          totalFinal: 0,
          tiingoCallsAttempted: 0,
          tiingoCallsSucceeded: 0,
        },
      },
    };
  }

  const headerLine = lines[0];
  const delim = detectDelimiter(headerLine);
  const headerCols = splitByDelimiter(headerLine, delim);
  const today = new Date();
  warnedStalenessFallback = false; // one warning per run, not per row

  // Parse all rows
  const parsed = lines.slice(1).map((line) => parseCsvRow(headerCols, line, today, delim));
  const inputRowCount = parsed.length;

  // Filter 1: validated handle-staleness — applied to all setups before sectioning
  const afterStaleness = parsed.filter((p) => !p.isValid || p.daysSinceHandleLow <= MAX_HANDLE_DAYS);

  // Section split
  const liveSetups = afterStaleness.filter((p) => LIVE_STATUSES.has(p.status));
  const pendingSetups = afterStaleness.filter((p) => PENDING_STATUSES.has(p.status));

  // Per-section staleness counts (proportional split)
  const liveInput = parsed.filter((p) => LIVE_STATUSES.has(p.status)).length;
  const pendingInput = parsed.filter((p) => PENDING_STATUSES.has(p.status)).length;
  const liveStaleDropped = liveInput - liveSetups.length;
  const pendingStaleDropped = pendingInput - pendingSetups.length;

  // Sort live by status priority
  liveSetups.sort((a, b) => {
    const pa = LIVE_STATUS_PRIORITY[a.status] ?? 99;
    const pb = LIVE_STATUS_PRIORITY[b.status] ?? 99;
    return pa - pb;
  });

  // Sort pending by handle_low_date descending (freshest first)
  // TODO v1.3: replace with validated ranking criterion if pending test passes
  pendingSetups.sort((a, b) => b.handleLowDate.localeCompare(a.handleLowDate));

  // Cap each section
  const liveFinal = liveSetups.slice(0, MAX_LIVE_SETUPS);
  const pendingFinal = pendingSetups.slice(0, MAX_PENDING_SETUPS);
  const liveOverCap = liveSetups.length - liveFinal.length;
  const pendingOverCap = pendingSetups.length - pendingFinal.length;

  return {
    headerLine,
    sectioned: {
      live: liveFinal,
      pending: pendingFinal,
      stats: {
        inputRowCount,
        live: {
          inputCount: liveInput,
          droppedHandleStale: liveStaleDropped,
          droppedOverCap: liveOverCap,
          finalCount: liveFinal.length,
        },
        pending: {
          inputCount: pendingInput,
          droppedHandleStale: pendingStaleDropped,
          droppedOverCap: pendingOverCap,
          finalCount: pendingFinal.length,
        },
        totalFinal: liveFinal.length + pendingFinal.length,
        tiingoCallsAttempted: 0,
        tiingoCallsSucceeded: 0,
      },
    },
  };
}

// ============================================================
// JSON extraction from Claude's response (v1.3 persistence)
// ============================================================

/**
 * Pull the ```json ... ``` fenced block from the response text.
 * Returns null if not found or parse fails. Non-fatal — parse failure just
 * means no structured writes for this run, markdown still gets stored.
 */
export function extractJsonBlock(text: string): ExtractedPayload | null {
  const fenceMatch = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!fenceMatch) return null;

  const jsonStr = fenceMatch[1].trim();
  try {
    return JSON.parse(jsonStr) as ExtractedPayload;
  } catch {
    return null;
  }
}

/**
 * Build the interactive-table rows from the parsed JSON decisions (NOT the
 * markdown). Enriches each with the setup geometry (from the scanner CSV) and the
 * DB decision_id/setup_id (from the persist step; null when persistence is off).
 */
export function buildClientDecisions(
  extracted: ExtractedPayload | null,
  enrichedLive: EnrichedSetup[],
  enrichedPending: EnrichedSetup[],
  decisionIds: InsertedDecisionId[],
  // Bug A: existing user marks keyed by setup_id (empty when persistence off).
  userMarks: Map<number, UserMark> = new Map(),
  // Risk/trade — needed to turn the sizing directive into concrete share counts.
  riskPerTrade: number = DEFAULT_RISK_PER_TRADE
): JackDecisionClient[] {
  const geo = new Map<
    string,
    {
      entry: number | null; stop: number | null; target: number | null; breakout: number | null;
      currentPrice: number | null; handleScore: number | null; sizeBucket: SizeBucket | null;
      sector: string | null; tier: string | null; priority: number | null;
      cupDepthPct: number | null; handleRetrPct: number | null; daysSinceHandleLow: number | null;
      entryStatus: string | null; confirmedCloseDate: string | null; daysSinceConfirm: number | null;
    }
  >();
  for (const s of [...enrichedLive, ...enrichedPending]) {
    const hld = normalizeIsoDate(s.handleLowDate);
    if (!hld) continue;
    geo.set(`${s.ticker}|${hld}`, {
      entry: s.entry ?? null,
      stop: s.stop ?? null,
      target: s.t05Target ?? null,
      breakout: s.breakoutLevel ?? null,
      currentPrice: s.tiingo.eodClose ?? null,
      handleScore: s.handleScore ?? null,
      sizeBucket: s.sizeBucket ?? null,
      sector: s.sector ?? null,
      tier: s.tier ?? null,
      priority: s.priority ?? null,
      cupDepthPct: s.cupDepthPct ?? null,
      handleRetrPct: s.handleRetrPct ?? null,
      daysSinceHandleLow: Number.isFinite(s.daysSinceHandleLow) ? s.daysSinceHandleLow : null,
      entryStatus: s.entryStatus ?? null,
      confirmedCloseDate: s.confirmedCloseDate ?? null,
      daysSinceConfirm: s.daysSinceConfirm ?? null,
    });
  }

  const idMap = new Map<string, { decisionId: number; setupId: number }>();
  for (const d of decisionIds) {
    idMap.set(`${d.ticker}|${d.handleLowDate}`, { decisionId: d.decisionId, setupId: d.setupId });
  }

  const out: JackDecisionClient[] = [];
  const push = (ed: ExtractedDecision, section: "live" | "pending") => {
    const ticker = (ed.ticker ?? "").toUpperCase();
    const hld = normalizeIsoDate(ed.handle_low_date);
    if (!ticker || !hld) return;
    const key = `${ticker}|${hld}`;
    const g = geo.get(key);
    const ids = idMap.get(key);
    const mark = ids ? userMarks.get(ids.setupId) : undefined;
    const handleScore = g?.handleScore ?? null;
    const sizeBucket = g?.sizeBucket ?? null;
    const sizing = computeSizing(riskPerTrade, g?.entry ?? null, g?.stop ?? null);
    const rec = recommendedSizing(sizeBucket, sizing);
    out.push({
      decisionId: ids?.decisionId ?? null,
      setupId: ids?.setupId ?? null,
      ticker,
      handleLowDate: hld,
      section,
      decision: ed.decision ?? "UNKNOWN",
      entry: g?.entry ?? null,
      stop: g?.stop ?? null,
      target: g?.target ?? null,
      shares: typeof ed.shares === "number" ? ed.shares : null,
      breakout: g?.breakout ?? null,
      currentPrice: g?.currentPrice ?? null,
      note: ed.notes ?? null,
      newsClass: ed.news_class ?? null,
      sectorRs: ed.sector_rs ?? null,
      crossAsset: ed.cross_asset ?? null,
      earningsFlag: ed.earnings_flag ?? null,
      pctToBreakout: typeof ed.pct_to_breakout === "number" ? ed.pct_to_breakout : null,
      userAction: mark?.userAction ?? null,
      userEntryPrice: mark?.userEntryPrice ?? null,
      userEntryDate: mark?.userEntryDate ?? null,
      userExitPrice: mark?.userExitPrice ?? null,
      userExitDate: mark?.userExitDate ?? null,
      jackDecisionAtMark: mark?.jackDecisionAtMark ?? null,
      sharesAtMark: mark?.sharesAtMark ?? null,
      handleScore,
      sizeBucket,
      sector: g?.sector ?? null,
      tier: g?.tier ?? null,
      priority: g?.priority ?? null,
      cupDepthPct: g?.cupDepthPct ?? null,
      handleRetrPct: g?.handleRetrPct ?? null,
      daysSinceHandleLow: g?.daysSinceHandleLow ?? null,
      entryStatus: g?.entryStatus ?? null,
      confirmedCloseDate: g?.confirmedCloseDate ?? null,
      daysSinceConfirm: g?.daysSinceConfirm ?? null,
      fullShares: sizing.fullShares,
      fullNotional: sizing.fullNotional,
      halfShares: sizing.halfShares,
      halfNotional: sizing.halfNotional,
      recShares: rec.shares,
      recNotional: rec.notional,
    });
  };
  for (const ed of extracted?.live_decisions ?? []) push(ed, "live");
  for (const ed of extracted?.pending_decisions ?? []) push(ed, "pending");

  // DEFAULT SORT (spec Part C) + numeric coercion now live in
  // finalizeClientDecisions, the shared exit both render paths return through.
  // This used to be a private sort at the tail of THIS function, which is exactly
  // why the hydrated board came out alphabetical: the ordering was a property of
  // the VALIDATE path rather than of the board. Same keys as before (priority DESC
  // nulls-last on LIVE → bucket → score), with the arrival-index tiebreak replaced
  // by ticker ASC so both paths can produce the same order.
  return finalizeClientDecisions(out);
}
