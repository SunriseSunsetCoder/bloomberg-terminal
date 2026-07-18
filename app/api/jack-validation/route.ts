import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Type-only imports compile away — safe on Vercel where the DB layer never loads.
import type { SetupSeen, DecisionRow, InsertedDecisionId } from "@/lib/db/write";
// The concrete write functions are loaded lazily via require() inside persistRun()
// so better-sqlite3 is never required on Vercel (isPersistenceAvailable() === false).
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";

export const maxDuration = 120; // longer for parallel Tiingo enrichment
export const dynamic = "force-dynamic";

// ============================================================
// Configuration
// ============================================================

const DEFAULT_RISK_PER_TRADE = 2000;
const INDIVIDUAL_CAP_MULTIPLIER = 100;
const SESSION_CAP_MULTIPLIER = 400;

// VALIDATED FILTER (May 2026 winner-vs-loser test):
// Applied to BOTH sections — handles >15d underperform regardless of breakout status.
const MAX_HANDLE_DAYS = 15;

// Section caps
const MAX_LIVE_SETUPS = 30;     // session-cap math
const MAX_PENDING_SETUPS = 50;  // pending = watchlist, may fall off, larger cap

// Status classification
const LIVE_STATUSES = new Set(["just_fired", "recent_breakout"]);
const PENDING_STATUSES = new Set(["pending"]);

// Live section ordering (untested heuristic)
const LIVE_STATUS_PRIORITY: Record<string, number> = {
  just_fired: 0,
  recent_breakout: 1,
};

// Pending section ordering (untested heuristic until pending ranking test validates)
// Currently: sort by handle_low_date descending (freshest first)
// TODO v1.3: replace with validated ranking if pending test returns a winner

// Tiingo base URL (relative — calls our own proxy routes)
function tiingoBaseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/api/tiingo`;
}

// ============================================================
// Prompt template loading
// ============================================================

const PROMPT_PATH = join(process.cwd(), "prompts", "cup-handle-t05-validation.md");
let PROMPT_TEMPLATE: string | null = null;
function getPromptTemplate(): string {
  if (PROMPT_TEMPLATE === null) {
    PROMPT_TEMPLATE = readFileSync(PROMPT_PATH, "utf-8");
  }
  const tpl: string = PROMPT_TEMPLATE;
  return tpl;
}

// ============================================================
// Types
// ============================================================

interface ParsedSetup {
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
}

interface EnrichedSetup extends ParsedSetup {
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

interface SectionStats {
  inputCount: number;
  droppedHandleStale: number;
  droppedOverCap: number;
  finalCount: number;
}

interface FilterStats {
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
interface JackDecisionClient {
  decisionId: number | null;
  setupId: number | null;
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending";
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
}

interface JackValidationResponse {
  schemaVersion: "1.2";
  timestamp: string;
  strategy: string;
  riskPerTrade: number;
  markdown: string;
  model: string;
  inputRowCount: number;
  filterStats: FilterStats;
  tokens?: { input: number; output: number };
  degraded?: boolean;
  error?: string | null;
  // Session B: structured, DB-keyed decisions for the interactive table, plus a
  // flag so the UI knows whether row writes will land (VPS) or no-op (Vercel).
  decisions?: JackDecisionClient[];
  persistenceAvailable?: boolean;
}

// ============================================================
// Helpers
// ============================================================

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

// Bug B hardening: DAY-precision session context. Previously this embedded the
// clock time (minute) and the intra-day session phase (PREMARKET/REGULAR/...),
// both of which change through the day — so re-VALIDATE minutes later produced a
// different prompt even at temperature 0. Now it's stable for the whole calendar
// day: identical CSV re-validated later the same day → identical prompt text.
// `now` is injectable for deterministic testing.
export function buildSessionContext(now: Date = new Date()): string {
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(now);

  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
  }).format(now);
  const marketDay = day === "Sat" || day === "Sun" ? "market closed (weekend)" : "trading day";

  return `${dateStr} ET (${marketDay})`;
}

// ET calendar-day key (ISO YYYY-MM-DD) — used to scope the Tiingo enrichment
// cache so a re-VALIDATE the same market day reuses identical data.
export function etDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
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

function parseCsvRow(headerCols: string[], rowLine: string, today: Date, delim: string): ParsedSetup {
  const cols = splitByDelimiter(rowLine, delim);
  const get = (name: string): string | undefined => {
    const idx = headerCols.indexOf(name);
    if (idx === -1 || idx >= cols.length) return undefined;
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
  const cupDepthPct = getNum("cup_depth_pct", "cup_depth");
  const handleRetrPct = getNum("handle_retr_pct", "handle_retracement_pct");

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

  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.floor((today.getTime() - parsed.getTime()) / msPerDay);

  return {
    raw: rowLine, rowCols: cols, ticker, status,
    handleLowDate: handleLowDateRaw, daysSinceHandleLow: days,
    isValid: true,
    entry, stop, t05Target, breakoutLevel, cupDepthPct, handleRetrPct,
  };
}

// ============================================================
// Filter pipeline — split into Live + Pending sections
// ============================================================

interface SectionedSetups {
  live: ParsedSetup[];
  pending: ParsedSetup[];
  stats: FilterStats;
}

function applyFilters(rawCsv: string): { headerLine: string; sectioned: SectionedSetups } {
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

  // Parse all rows
  const parsed = lines.slice(1).map((line) => parseCsvRow(headerCols, line, today, delim));
  const inputRowCount = parsed.length;

  // Filter 1: validated handle-staleness — applied to all setups before sectioning
  const afterStaleness = parsed.filter((p) => !p.isValid || p.daysSinceHandleLow <= MAX_HANDLE_DAYS);
  const totalDroppedStale = parsed.length - afterStaleness.length;

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
// Tiingo enrichment — parallel fetches for surviving setups
// ============================================================

// Bug B hardening: cache Tiingo enrichment per (ticker, ET calendar-day). A
// re-VALIDATE the same market day reuses identical price/news data instead of
// re-fetching (the news endpoint especially can return new articles intraday,
// which would perturb the prompt). In-memory, per server process. Exported so
// tests can reset it; other-day entries are pruned in enrichAllSetups.
type TiingoData = EnrichedSetup["tiingo"];
export const enrichCache = new Map<string, TiingoData>();

async function enrichSetup(
  setup: ParsedSetup,
  tiingoBase: string
): Promise<EnrichedSetup> {
  const cacheKey = `${setup.ticker}|${etDayKey()}`;
  const cached = enrichCache.get(cacheKey);
  if (cached) {
    // Reuse today's external data; the setup's own parsed fields are current.
    return { ...setup, tiingo: cached };
  }

  const enriched: EnrichedSetup = { ...setup, tiingo: {} };

  // v1.2: only fetch EOD + news. Fundamentals removed — Tiingo's fundamentals
  // endpoint requires paid add-on ($10/mo); free tier returns 400. Earnings
  // validation deferred to manual EM check, or future Finnhub integration.
  const eodUrl = `${tiingoBase}/eod/${setup.ticker}?days=10`;
  const newsUrl = `${tiingoBase}/news/${setup.ticker}?days=7&limit=5`;

  // Fetch the raw Response (do NOT chain .json() here): a 404/500 from the
  // internal route returns non-JSON, and a blind .json() throws an opaque
  // SyntaxError that hides the real HTTP status. Capture status explicitly.
  const [eodRes, newsRes] = await Promise.allSettled([fetch(eodUrl), fetch(newsUrl)]);

  // --- EOD ---
  if (eodRes.status === "fulfilled") {
    const res = eodRes.value;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // TEMP LOGGING (jack-tiingo-eod-route-fix): surface the real failure per ticker.
      console.warn(`[jack-tiingo] EOD ${setup.ticker} HTTP ${res.status} <${eodUrl}> :: ${body.slice(0, 200)}`);
      enriched.tiingo.eodError = `HTTP ${res.status}`;
    } else {
      const d = (await res.json().catch(() => ({}))) as {
        latestClose?: number;
        latestDate?: string;
        error?: string;
      };
      enriched.tiingo.eodClose = d.latestClose;
      enriched.tiingo.eodDate = d.latestDate;
      if (d.error) {
        enriched.tiingo.eodError = d.error;
        console.warn(`[jack-tiingo] EOD ${setup.ticker} route error: ${d.error}`);
      }
    }
  } else {
    enriched.tiingo.eodError = String(eodRes.reason);
    // TEMP LOGGING (jack-tiingo-eod-route-fix)
    console.warn(`[jack-tiingo] EOD ${setup.ticker} fetch rejected: ${String(eodRes.reason)}`);
  }

  // --- News ---
  if (newsRes.status === "fulfilled") {
    const res = newsRes.value;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // TEMP LOGGING (jack-tiingo-eod-route-fix)
      console.warn(`[jack-tiingo] NEWS ${setup.ticker} HTTP ${res.status} <${newsUrl}> :: ${body.slice(0, 200)}`);
      enriched.tiingo.newsError = `HTTP ${res.status}`;
    } else {
      const d = (await res.json().catch(() => ({}))) as {
        articles?: Array<{ title: string; publishedDate: string }>;
        error?: string;
      };
      enriched.tiingo.newsHeadlines = (d.articles ?? []).slice(0, 5).map(
        (a) => `[${a.publishedDate.split("T")[0]}] ${a.title}`
      );
      if (d.error) {
        enriched.tiingo.newsError = d.error;
        console.warn(`[jack-tiingo] NEWS ${setup.ticker} route error: ${d.error}`);
      }
    }
  } else {
    enriched.tiingo.newsError = String(newsRes.reason);
    // TEMP LOGGING (jack-tiingo-eod-route-fix)
    console.warn(`[jack-tiingo] NEWS ${setup.ticker} fetch rejected: ${String(newsRes.reason)}`);
  }

  // Fundamentals intentionally skipped in v1.2 — see note above
  enriched.tiingo.earningsNote = "Fundamentals not fetched in v1.2 (Tiingo paid add-on required) — verify earnings on EM";

  // Cache today's external data for this ticker so a same-day re-VALIDATE reuses it.
  enrichCache.set(cacheKey, enriched.tiingo);

  return enriched;
}

export async function enrichAllSetups(
  setups: ParsedSetup[],
  tiingoBase: string
): Promise<{ enriched: EnrichedSetup[]; attempted: number; succeeded: number }> {
  // Prune enrichment-cache entries from previous calendar days (keep memory bounded
  // and never serve stale-day data).
  const today = etDayKey();
  for (const k of enrichCache.keys()) {
    if (!k.endsWith(`|${today}`)) enrichCache.delete(k);
  }

  let attempted = 0;
  let succeeded = 0;
  const results = await Promise.all(setups.map((s) => enrichSetup(s, tiingoBase)));
  for (const r of results) {
    attempted++;
    // v1.2: success = got EOD OR news. Fundamentals not attempted (Tiingo paid)
    const hasAnyData =
      r.tiingo.eodClose !== undefined ||
      (r.tiingo.newsHeadlines && r.tiingo.newsHeadlines.length > 0);
    if (hasAnyData) succeeded++;
  }
  return { enriched: results, attempted, succeeded };
}

// ============================================================
// JSON extraction from Claude's response (v1.3 persistence)
// ============================================================

interface ExtractedDecision {
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

interface ExtractedPayload {
  schema_version?: string;
  live_decisions?: ExtractedDecision[];
  pending_decisions?: ExtractedDecision[];
}

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
 * Normalize a date from Claude's JSON to ISO YYYY-MM-DD.
 * Accepts YYYY-MM-DD or M/D/YYYY. Returns null on unrecognized format.
 */
function normalizeIsoDate(input: string | undefined): string | null {
  if (!input) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(input);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Convert an extracted decision to a DecisionRow ready for DB insert.
 * Returns null if the row is unusable (missing ticker or handle_low_date).
 */
function extractedToDecisionRow(
  ed: ExtractedDecision,
  section: "live" | "pending"
): DecisionRow | null {
  const ticker = (ed.ticker ?? "").toUpperCase();
  const handleLowDate = normalizeIsoDate(ed.handle_low_date);
  if (!ticker || !handleLowDate) return null;

  return {
    ticker,
    handleLowDate,
    section,
    decision: ed.decision ?? "UNKNOWN",
    shares: typeof ed.shares === "number" ? ed.shares : undefined,
    notional: typeof ed.notional === "number" ? ed.notional : undefined,
    earningsFlag: ed.earnings_flag,
    liveCloseDeltaPct:
      typeof ed.live_close_delta_pct === "number" ? ed.live_close_delta_pct : undefined,
    pctToBreakout: typeof ed.pct_to_breakout === "number" ? ed.pct_to_breakout : undefined,
    newsClass: ed.news_class,
    sectorRs: ed.sector_rs,
    crossAsset: ed.cross_asset,
    notes: ed.notes,
  };
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
  userMarks: Map<number, import("@/lib/db/read").UserMark> = new Map()
): JackDecisionClient[] {
  const geo = new Map<
    string,
    { entry: number | null; stop: number | null; target: number | null; breakout: number | null; currentPrice: number | null }
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
    });
  };
  for (const ed of extracted?.live_decisions ?? []) push(ed, "live");
  for (const ed of extracted?.pending_decisions ?? []) push(ed, "pending");
  return out;
}

interface PersistResult {
  runId?: number;
  setupsUpserted: number;
  decisionsInserted: number;
  decisionsSkipped: number;
  jsonParseSuccess: boolean;
  decisionIds: InsertedDecisionId[];
  // Bug A: existing marks for the setups in this run, keyed by setup_id.
  userMarks: Map<number, import("@/lib/db/read").UserMark>;
  error?: string;
}

/**
 * Persist a completed validation run to SQLite. Non-fatal on DB errors.
 *
 * Vercel guard: if persistence is unavailable (Vercel serverless, or manual
 * override), return early WITHOUT require()ing the DB layer — this is what keeps
 * better-sqlite3 (a native module) off the Vercel deploy entirely. The write
 * module is loaded lazily via require() only when we actually intend to write.
 */
function persistRun(args: {
  timestamp: string;
  liveSetups: EnrichedSetup[];
  pendingSetups: EnrichedSetup[];
  stats: FilterStats;
  riskPerTrade: number;
  tokensInput?: number;
  tokensOutput?: number;
  model: string;
  rawMarkdown: string;
  extracted: ExtractedPayload | null;
  errorMsg?: string;
}): PersistResult {
  const result: PersistResult = {
    setupsUpserted: 0,
    decisionsInserted: 0,
    decisionsSkipped: 0,
    jsonParseSuccess: args.extracted !== null,
    decisionIds: [],
    userMarks: new Map(),
  };

  // Vercel guard — never touch the DB layer when persistence is off.
  if (!isPersistenceAvailable()) {
    result.error = persistenceUnavailableReason();
    return result;
  }

  try {
    // Lazy-load the write module so better-sqlite3 is only required on the VPS.
    const dbWrite = require("@/lib/db/write") as typeof import("@/lib/db/write");

    // 1. Upsert every setup we validated (both sections)
    const setupIdMap = new Map<string, number>(); // "TICKER|YYYY-MM-DD" -> setup_id

    const allSetups = [
      ...args.liveSetups.map((s) => ({ setup: s, section: "live" as const })),
      ...args.pendingSetups.map((s) => ({ setup: s, section: "pending" as const })),
    ];

    for (const { setup } of allSetups) {
      const handleLowDate = normalizeIsoDate(setup.handleLowDate);
      if (!handleLowDate) continue;

      const seen: SetupSeen = {
        ticker: setup.ticker,
        handleLowDate,
        status: setup.status,
        // v1.4 (Session B): persist geometry so the outcome replay can fire/exit
        // against real levels. Parsed from the scanner CSV; may be undefined if the
        // scanner omitted a column (then that setup just won't be replay-eligible).
        entry: setup.entry,
        stop: setup.stop,
        t05Target: setup.t05Target,
        breakoutLevel: setup.breakoutLevel,
        cupDepthPct: setup.cupDepthPct,
        handleRetrPct: setup.handleRetrPct,
      };
      const setupId = dbWrite.upsertSetup(seen, args.timestamp);
      setupIdMap.set(`${setup.ticker}|${handleLowDate}`, setupId);
      result.setupsUpserted++;
    }

    // 2. Insert the validation_runs row
    const runId = dbWrite.insertValidationRun({
      timestamp: args.timestamp,
      inputRowCount: args.stats.inputRowCount,
      totalFinalCount: args.stats.totalFinal,
      liveFinalCount: args.stats.live.finalCount,
      pendingFinalCount: args.stats.pending.finalCount,
      liveDroppedStale: args.stats.live.droppedHandleStale,
      pendingDroppedStale: args.stats.pending.droppedHandleStale,
      liveDroppedOverCap: args.stats.live.droppedOverCap,
      pendingDroppedOverCap: args.stats.pending.droppedOverCap,
      tiingoAttempted: args.stats.tiingoCallsAttempted,
      tiingoSucceeded: args.stats.tiingoCallsSucceeded,
      riskPerTrade: args.riskPerTrade,
      tokensInput: args.tokensInput,
      tokensOutput: args.tokensOutput,
      model: args.model,
      rawMarkdown: args.rawMarkdown,
      parseSuccess: args.extracted !== null,
      errorMsg: args.errorMsg,
    });
    result.runId = runId;

    // 3. Insert decisions if we successfully extracted JSON
    if (args.extracted !== null) {
      const decisionRows: DecisionRow[] = [];
      for (const ed of args.extracted.live_decisions ?? []) {
        const row = extractedToDecisionRow(ed, "live");
        if (row) decisionRows.push(row);
      }
      for (const ed of args.extracted.pending_decisions ?? []) {
        const row = extractedToDecisionRow(ed, "pending");
        if (row) decisionRows.push(row);
      }

      const { inserted, skipped, ids } = dbWrite.insertDecisions(decisionRows, runId, setupIdMap);
      result.decisionsInserted = inserted;
      result.decisionsSkipped = skipped;
      result.decisionIds = ids;
    }

    // 4. Bug A: load existing user marks for these setups so the interactive
    // table can re-hydrate them (this run's decision rows are freshly unmarked,
    // but prior runs' marks + the setup's outcomes fills still live in the DB).
    const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
    result.userMarks = dbRead.getUserMarksForSetups([...setupIdMap.values()]);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ============================================================
// Prompt building — embed enriched data as structured text
// ============================================================

function formatEnrichedSetup(s: EnrichedSetup): string {
  const lines: string[] = [];
  lines.push(`### ${s.ticker} (status: ${s.status})`);
  lines.push(`Scanner row: ${s.raw}`);
  lines.push(`Handle age: ${s.daysSinceHandleLow} days since handle_low_date ${s.handleLowDate}`);

  if (s.tiingo.eodClose !== undefined) {
    lines.push(`Tiingo latest close: $${s.tiingo.eodClose.toFixed(2)} (${s.tiingo.eodDate})`);
  } else if (s.tiingo.eodError) {
    lines.push(`Tiingo price: unavailable (${s.tiingo.eodError})`);
  } else {
    lines.push(`Tiingo price: unavailable`);
  }

  if (s.tiingo.nextEarningsDate) {
    lines.push(
      `Earnings: next est. ${s.tiingo.nextEarningsDate} (${s.tiingo.daysToNextEarnings} days)` +
        (s.tiingo.lastEarningsDate ? ` | last ${s.tiingo.lastEarningsDate} (${s.tiingo.daysSinceLastEarnings}d ago)` : "")
    );
    if (s.tiingo.earningsNote) lines.push(`  note: ${s.tiingo.earningsNote}`);
  } else {
    // v1.2 design: fundamentals not fetched (Tiingo paid add-on), no error to report
    lines.push(`Earnings: not fetched in v1.2 — verify on EM if critical (by design, not error)`);
  }

  if (s.tiingo.newsHeadlines && s.tiingo.newsHeadlines.length > 0) {
    lines.push(`Recent news headlines (last 7 days):`);
    for (const h of s.tiingo.newsHeadlines) {
      lines.push(`  - ${h}`);
    }
  } else if (s.tiingo.newsError) {
    lines.push(`News: unavailable (${s.tiingo.newsError})`);
  } else {
    lines.push(`News: no headlines in last 7 days`);
  }

  return lines.join("\n");
}

// Per-pass directives. The winner/loser + ranking research both returned NULL —
// NO setup-feature quality sort or priority heuristic. The only prescribed order
// is STATUS PRIORITY (live before pending), already applied upstream by the
// filter pipeline + Colab dedupe. This split is purely about output-token budget:
// large weeks (75+ setups) overrun a single call's cap, so LIVE gets a full pass
// and PENDING a compact pass, in separate calls.
const LIVE_PASS_DIRECTIVE = `

---
## THIS PASS: LIVE ONLY
Analyze and output ONLY the LIVE section, with full reasoning. Emit \`live_decisions\`
(one row per live setup) and Table 1. Set \`pending_decisions\` to \`[]\` and omit
Table 2 and the pending counts — a separate pass handles pending. All five checks,
the JSON schema, and the cluster/cap sections apply to the LIVE setups.`;

const PENDING_PASS_DIRECTIVE = `

---
## THIS PASS: PENDING ONLY — COMPACT (but keep the "why watch" signal)
Analyze and output ONLY the PENDING section. These are watchlist items, not
actionable today, so be TERSE — but "compact" means short PROSE, NOT
context-stripped. A pending row must still tell the trader WHY it is worth
preparing for.

- Emit \`pending_decisions\` (one row per pending setup) and a compact Table 2.
- Keep \`notes\` to ~1 sentence, but it MUST carry the contextual read — the
  news/catalyst classification and any sector context and the specific breakout
  trigger to watch — not just the R/R geometry.
- Still populate \`news_class\`, \`sector_rs\`, and \`cross_asset\` (when relevant)
  exactly as usual — those fields are cheap and are the signal Session C reads.
- What you DROP in compact mode is only the long multi-paragraph narrative and
  the per-setup restatement of the five checks — the classifications stay.
- Set \`live_decisions\` to \`[]\`; omit Table 1 and the live-only cluster/cap/notional
  sections. Still apply the pending decision rules (WATCH / WATCH-CAUTION / SKIP /
  ALREADY FIRED) and the ALREADY-FIRED reclassification check (Tiingo close already
  above breakout_level).`;

/**
 * Build the validation prompt. `mode` selects which section is analyzed:
 *  - "both"    : single-call legacy behaviour (small weeks / fallback).
 *  - "live"    : LIVE setups only, full reasoning (pass 1 of the split).
 *  - "pending" : PENDING setups only, compact (pass 2 of the split).
 * Splitting keeps each call's output under the token cap without any
 * setup-feature ranking (research: NULL) — only status-priority sectioning.
 */
export function buildSectionedPrompt(
  headerLine: string,
  liveSetups: EnrichedSetup[],
  pendingSetups: EnrichedSetup[],
  riskPerTrade: number,
  mode: "both" | "live" | "pending" = "both"
): string {
  const template = getPromptTemplate();
  const individualCap = riskPerTrade * INDIVIDUAL_CAP_MULTIPLIER;
  const sessionCap = riskPerTrade * SESSION_CAP_MULTIPLIER;
  const sessionContext = buildSessionContext(); // day-stable → deterministic across the day

  const liveBlock =
    liveSetups.length === 0
      ? "(no live setups after filtering)"
      : liveSetups.map(formatEnrichedSetup).join("\n\n");
  const pendingBlock =
    pendingSetups.length === 0
      ? "(no pending setups after filtering)"
      : pendingSetups.map(formatEnrichedSetup).join("\n\n");

  const liveSection = [
    `## LIVE SECTION (${liveSetups.length} setups — confirmed breakouts, immediate trading decisions)`,
    `CSV header: ${headerLine}`,
    "",
    mode === "pending" ? "(handled in a separate LIVE pass — ignore here)" : liveBlock,
  ];
  const pendingSection = [
    `## PENDING SECTION (${pendingSetups.length} setups — handle formed, awaiting breakout)`,
    `CSV header: ${headerLine}`,
    "",
    mode === "live" ? "(handled in a separate PENDING pass — ignore here)" : pendingBlock,
  ];
  const sectionedData = [...liveSection, "", ...pendingSection].join("\n");

  const directive = mode === "live" ? LIVE_PASS_DIRECTIVE : mode === "pending" ? PENDING_PASS_DIRECTIVE : "";

  return (
    template
      .replace(/\{\{RISK_PER_TRADE\}\}/g, String(riskPerTrade))
      .replace(/\{\{NOTIONAL_CAP_INDIVIDUAL\}\}/g, formatUsd(individualCap))
      .replace(/\{\{NOTIONAL_CAP_SESSION\}\}/g, formatUsd(sessionCap))
      .replace(/\{\{SESSION_CONTEXT\}\}/g, sessionContext)
      .replace(/\{\{CSV_INPUT\}\}/g, sectionedData)
      .replace(/\{\{LIVE_COUNT\}\}/g, String(liveSetups.length))
      .replace(/\{\{PENDING_COUNT\}\}/g, String(pendingSetups.length)) + directive
  );
}

// ============================================================
// POST handler
// ============================================================

interface JackValidationRequest {
  csv: string;
  riskPerTrade?: number;
}

export async function POST(req: NextRequest) {
  const timestamp = new Date().toISOString();
  const emptyStats: FilterStats = {
    inputRowCount: 0,
    live: { inputCount: 0, droppedHandleStale: 0, droppedOverCap: 0, finalCount: 0 },
    pending: { inputCount: 0, droppedHandleStale: 0, droppedOverCap: 0, finalCount: 0 },
    totalFinal: 0,
    tiingoCallsAttempted: 0,
    tiingoCallsSucceeded: 0,
  };

  let body: JackValidationRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json<JackValidationResponse>(
      {
        schemaVersion: "1.2", timestamp,
        strategy: "Cup with Handle t05", riskPerTrade: DEFAULT_RISK_PER_TRADE,
        markdown: "**Error:** Request body is not valid JSON.",
        model: "n/a", inputRowCount: 0, filterStats: emptyStats,
        error: "Invalid JSON",
      },
      { status: 400 }
    );
  }

  const rawCsv = (body.csv ?? "").trim();
  const riskPerTrade = body.riskPerTrade ?? DEFAULT_RISK_PER_TRADE;

  if (!rawCsv) {
    return NextResponse.json<JackValidationResponse>(
      {
        schemaVersion: "1.2", timestamp,
        strategy: "Cup with Handle t05", riskPerTrade,
        markdown: "**Error:** No CSV input provided.",
        model: "n/a", inputRowCount: 0, filterStats: emptyStats,
        error: "Empty CSV input",
      },
      { status: 400 }
    );
  }

  // 1. Parse + filter + section
  const { headerLine, sectioned } = applyFilters(rawCsv);
  const { live: liveSetups, pending: pendingSetups, stats } = sectioned;

  if (stats.totalFinal === 0) {
    return NextResponse.json<JackValidationResponse>(
      {
        schemaVersion: "1.2", timestamp,
        strategy: "Cup with Handle t05", riskPerTrade,
        markdown:
          `**No setups remain after filtering.**\n\n` +
          `Input: ${stats.inputRowCount} setups. ` +
          `All failed handle-staleness filter (>${MAX_HANDLE_DAYS} days) or had unparseable data.`,
        model: "n/a", inputRowCount: stats.inputRowCount,
        filterStats: stats, error: "All setups filtered out",
      },
      { status: 200 }
    );
  }

  // 2. Tiingo enrichment for survivors (parallel across both sections)
  const tiingoBase = tiingoBaseUrl(req);
  const allFinalSetups = [...liveSetups, ...pendingSetups];
  const { enriched, attempted, succeeded } = await enrichAllSetups(allFinalSetups, tiingoBase);
  stats.tiingoCallsAttempted = attempted;
  stats.tiingoCallsSucceeded = succeeded;

  const enrichedLive = enriched.slice(0, liveSetups.length);
  const enrichedPending = enriched.slice(liveSetups.length);

  // 3. Call Claude
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json<JackValidationResponse>(
      {
        schemaVersion: "1.2", timestamp,
        strategy: "Cup with Handle t05", riskPerTrade,
        markdown: "**Error:** ANTHROPIC_API_KEY not set.",
        model: "n/a", inputRowCount: stats.inputRowCount,
        filterStats: stats, error: "Missing ANTHROPIC_API_KEY",
      },
      { status: 500 }
    );
  }

  const client = new Anthropic({ apiKey });
  const model = "claude-sonnet-4-5";

  // Output-truncation handling, GATED ON SETUP COUNT. A single combined "both"
  // call produces ~FULL_TOKENS_PER_SETUP output tokens per setup. A normal week
  // (~42 setups) fits comfortably under an ~8k budget and keeps FULL analysis for
  // BOTH live and pending — so it stays a single call. Only when the week is large
  // enough that one call would approach the ceiling do we SPLIT into a full LIVE
  // pass + a compact PENDING pass (in parallel), confining the pending-compactness
  // tradeoff to the big weeks that force it. Determinism (temp 0 + day-stable
  // session context) holds in both modes. Status-priority sectioning ONLY — no
  // setup-feature ranking (winner/loser + ranking research both returned NULL).
  const FULL_TOKENS_PER_SETUP = 160;
  const SINGLE_CALL_OUTPUT_BUDGET = 8000; // comfortable single-call output ceiling
  const SPLIT_THRESHOLD = Math.floor((SINGLE_CALL_OUTPUT_BUDGET - 1000) / FULL_TOKENS_PER_SETUP); // ≈ 43 setups
  const shouldSplit = stats.totalFinal > SPLIT_THRESHOLD;

  const runSection = async (
    liveS: EnrichedSetup[],
    pendingS: EnrichedSetup[],
    mode: "both" | "live" | "pending",
    maxTokens: number
  ): Promise<{ text: string; inTok: number; outTok: number; truncated: boolean } | null> => {
    if (liveS.length === 0 && pendingS.length === 0) return null;
    const prompt = buildSectionedPrompt(headerLine, liveS, pendingS, riskPerTrade, mode);
    const c = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: 0, // reproducible validations (Bug B) — preserved in both modes
      messages: [{ role: "user", content: prompt }],
    });
    const text = c.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
    return { text, inTok: c.usage.input_tokens, outTok: c.usage.output_tokens, truncated: c.stop_reason === "max_tokens" };
  };

  try {
    let sectionResults: Array<{ text: string; inTok: number; outTok: number; truncated: boolean } | null>;
    if (shouldSplit) {
      // Big week: full LIVE pass + compact PENDING pass, in parallel.
      const liveMax = Math.min(20000, Math.max(4000, enrichedLive.length * FULL_TOKENS_PER_SETUP + 1500));
      const pendingMax = Math.min(16000, Math.max(3000, enrichedPending.length * 70 + 1000));
      sectionResults = await Promise.all([
        runSection(enrichedLive, [], "live", liveMax),
        runSection([], enrichedPending, "pending", pendingMax),
      ]);
    } else {
      // Normal week: ONE call, FULL analysis for live AND pending (no downgrade).
      const bothMax = Math.min(20000, Math.max(8000, stats.totalFinal * FULL_TOKENS_PER_SETUP + 1500));
      sectionResults = [await runSection(enrichedLive, enrichedPending, "both", bothMax)];
    }

    // Merge whatever passes ran into the SAME extracted shape the persistence +
    // client layers already consume (schema_version, live_decisions[],
    // pending_decisions[]). Works for one "both" payload (both arrays populated) or
    // two split payloads (each one array) — flatMap combines them either way.
    // JSON CONTRACT UNCHANGED — Session C reads the identical decision columns.
    const present = sectionResults.filter((r): r is NonNullable<typeof r> => !!r);
    const parsed = present.map((r) => extractJsonBlock(r.text)).filter((p): p is ExtractedPayload => !!p);
    const extracted: ExtractedPayload | null = parsed.length
      ? {
          schema_version: parsed[0].schema_version ?? "1.3",
          live_decisions: parsed.flatMap((p) => p.live_decisions ?? []),
          pending_decisions: parsed.flatMap((p) => p.pending_decisions ?? []),
        }
      : null;

    const stripJson = (t: string) => t.replace(/```json\s*\n[\s\S]*?\n```/g, "").trim();
    const markdownForClient = present.map((r) => stripJson(r.text)).filter(Boolean).join("\n\n---\n\n");
    const fullResponse = present.map((r) => r.text).join("\n\n---\n\n");
    const truncated = present.some((r) => r.truncated);
    const tokensInput = present.reduce((acc, r) => acc + r.inTok, 0);
    const tokensOutput = present.reduce((acc, r) => acc + r.outTok, 0);

    // Persist to SQLite — guarded (VPS only) and non-fatal (DB errors don't fail the HTTP response).
    const persistResult = persistRun({
      timestamp,
      liveSetups: enrichedLive,
      pendingSetups: enrichedPending,
      stats,
      riskPerTrade,
      tokensInput,
      tokensOutput,
      model,
      rawMarkdown: fullResponse,
      extracted,
      errorMsg: truncated ? `Output truncated (${shouldSplit ? "split live+pending" : "single both"} call hit cap)` : undefined,
    });

    const persistNote = !isPersistenceAvailable()
      ? `> **Persistence:** ${persistenceUnavailableReason()}\n`
      : persistResult.error
        ? `> ⚠ Persistence error: ${persistResult.error}\n`
        : `> **Persistence:** run #${persistResult.runId ?? "?"} · ${persistResult.setupsUpserted} setups tracked · ${persistResult.decisionsInserted} decisions recorded${persistResult.decisionsSkipped > 0 ? ` · ${persistResult.decisionsSkipped} skipped (unmatched)` : ""}${persistResult.jsonParseSuccess ? "" : " · ⚠ JSON parse failed, only run metadata stored"}\n`;

    const preface =
      `> **Filter pipeline:** ${stats.inputRowCount} input → ` +
      `Live: ${stats.live.finalCount} (dropped ${stats.live.droppedHandleStale} stale, ${stats.live.droppedOverCap} over cap) · ` +
      `Pending: ${stats.pending.finalCount} (dropped ${stats.pending.droppedHandleStale} stale, ${stats.pending.droppedOverCap} over cap)\n` +
      `> **Tiingo enrichment:** ${stats.tiingoCallsSucceeded}/${stats.tiingoCallsAttempted} setups with live data\n` +
      persistNote +
      `> Handle-staleness filter validated May 2026 (drop >${MAX_HANDLE_DAYS}d).\n\n`;

    // Structured decisions for the interactive table — from the JSON block,
    // enriched with geometry + DB ids. Renders even on Vercel (ids null, writes no-op).
    const clientDecisions = buildClientDecisions(
      extracted,
      enrichedLive,
      enrichedPending,
      persistResult.decisionIds,
      persistResult.userMarks
    );

    return NextResponse.json<JackValidationResponse>({
      schemaVersion: "1.2", timestamp,
      strategy: "Cup with Handle t05", riskPerTrade,
      markdown: preface + (markdownForClient || "**Warning:** Empty response."),
      model, inputRowCount: stats.inputRowCount,
      filterStats: stats,
      tokens: {
        input: tokensInput,
        output: tokensOutput,
      },
      degraded: !markdownForClient || truncated,
      error: truncated ? `Output truncated (${shouldSplit ? "split live+pending" : "single both"} call hit cap)` : null,
      decisions: clientDecisions,
      persistenceAvailable: isPersistenceAvailable(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<JackValidationResponse>(
      {
        schemaVersion: "1.2", timestamp,
        strategy: "Cup with Handle t05", riskPerTrade,
        markdown: `**Anthropic API error:** ${msg}`,
        model, inputRowCount: stats.inputRowCount,
        filterStats: stats, error: msg,
      },
      { status: 502 }
    );
  }
}
