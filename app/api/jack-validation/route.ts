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

function buildSessionContext(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const dateStr = fmt.format(now);

  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  });
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
  });
  const hour = parseInt(hourFmt.format(now), 10);
  const day = dayFmt.format(now);

  let session: string;
  if (day === "Sat" || day === "Sun") session = "WEEKEND";
  else if (hour < 4) session = "AFTER-HOURS (previous session)";
  else if (hour < 9 || (hour === 9 && now.getMinutes() < 30)) session = "PREMARKET";
  else if (hour < 16) session = "REGULAR HOURS";
  else if (hour < 20) session = "AFTER-HOURS";
  else session = "AFTER-HOURS (late)";

  return `${dateStr} ET (${session})`;
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

async function enrichSetup(
  setup: ParsedSetup,
  tiingoBase: string
): Promise<EnrichedSetup> {
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

  return enriched;
}

async function enrichAllSetups(
  setups: ParsedSetup[],
  tiingoBase: string
): Promise<{ enriched: EnrichedSetup[]; attempted: number; succeeded: number }> {
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
function extractJsonBlock(text: string): ExtractedPayload | null {
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
function buildClientDecisions(
  extracted: ExtractedPayload | null,
  enrichedLive: EnrichedSetup[],
  enrichedPending: EnrichedSetup[],
  decisionIds: InsertedDecisionId[]
): JackDecisionClient[] {
  const geo = new Map<string, { entry: number | null; stop: number | null; target: number | null }>();
  for (const s of [...enrichedLive, ...enrichedPending]) {
    const hld = normalizeIsoDate(s.handleLowDate);
    if (!hld) continue;
    geo.set(`${s.ticker}|${hld}`, {
      entry: s.entry ?? null,
      stop: s.stop ?? null,
      target: s.t05Target ?? null,
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

function buildSectionedPrompt(
  headerLine: string,
  liveSetups: EnrichedSetup[],
  pendingSetups: EnrichedSetup[],
  riskPerTrade: number
): string {
  const template = getPromptTemplate();
  const individualCap = riskPerTrade * INDIVIDUAL_CAP_MULTIPLIER;
  const sessionCap = riskPerTrade * SESSION_CAP_MULTIPLIER;
  const sessionContext = buildSessionContext();

  // Build the sectioned data block
  const liveBlock =
    liveSetups.length === 0
      ? "(no live setups after filtering)"
      : liveSetups.map(formatEnrichedSetup).join("\n\n");
  const pendingBlock =
    pendingSetups.length === 0
      ? "(no pending setups after filtering)"
      : pendingSetups.map(formatEnrichedSetup).join("\n\n");

  const sectionedData = [
    `## LIVE SECTION (${liveSetups.length} setups — confirmed breakouts, immediate trading decisions)`,
    `CSV header: ${headerLine}`,
    "",
    liveBlock,
    "",
    `## PENDING SECTION (${pendingSetups.length} setups — handle formed, awaiting breakout)`,
    `CSV header: ${headerLine}`,
    "",
    pendingBlock,
  ].join("\n");

  return template
    .replace(/\{\{RISK_PER_TRADE\}\}/g, String(riskPerTrade))
    .replace(/\{\{NOTIONAL_CAP_INDIVIDUAL\}\}/g, formatUsd(individualCap))
    .replace(/\{\{NOTIONAL_CAP_SESSION\}\}/g, formatUsd(sessionCap))
    .replace(/\{\{SESSION_CONTEXT\}\}/g, sessionContext)
    .replace(/\{\{CSV_INPUT\}\}/g, sectionedData)
    .replace(/\{\{LIVE_COUNT\}\}/g, String(liveSetups.length))
    .replace(/\{\{PENDING_COUNT\}\}/g, String(pendingSetups.length));
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
  const prompt = buildSectionedPrompt(headerLine, enrichedLive, enrichedPending, riskPerTrade);

  try {
    // Floor raised 4000 -> 8000 (Jul 2026): an 18-setup batch computed 3160 and
    // floored to 4000, truncating output mid-response. The JSON decisions block is
    // now emitted first (see prompt), but keep generous headroom so both the JSON
    // and the full markdown fit under the cap.
    const maxTokens = Math.min(20000, Math.max(8000, stats.totalFinal * 120 + 1000));

    const completion = await client.messages.create({
      model, max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const fullResponse = completion.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    const truncated = completion.stop_reason === "max_tokens";

    // Extract the structured JSON block for persistence, then strip it from the
    // markdown that goes to the client (they only need the rendered tables).
    const extracted = extractJsonBlock(fullResponse);
    const markdownForClient = fullResponse.replace(/```json\s*\n[\s\S]*?\n```/g, "").trim();

    // Persist to SQLite — guarded (VPS only) and non-fatal (DB errors don't fail the HTTP response).
    const persistResult = persistRun({
      timestamp,
      liveSetups: enrichedLive,
      pendingSetups: enrichedPending,
      stats,
      riskPerTrade,
      tokensInput: completion.usage.input_tokens,
      tokensOutput: completion.usage.output_tokens,
      model,
      rawMarkdown: fullResponse,
      extracted,
      errorMsg: truncated ? `Output truncated at ${maxTokens} tokens` : undefined,
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
      persistResult.decisionIds
    );

    return NextResponse.json<JackValidationResponse>({
      schemaVersion: "1.2", timestamp,
      strategy: "Cup with Handle t05", riskPerTrade,
      markdown: preface + (markdownForClient || "**Warning:** Empty response."),
      model, inputRowCount: stats.inputRowCount,
      filterStats: stats,
      tokens: {
        input: completion.usage.input_tokens,
        output: completion.usage.output_tokens,
      },
      degraded: !markdownForClient || truncated,
      error: truncated ? `Output truncated at ${maxTokens} tokens` : null,
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
