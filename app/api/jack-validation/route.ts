import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  const [eodRes, newsRes] = await Promise.allSettled([
    fetch(`${tiingoBase}/eod/${setup.ticker}?days=10`).then((r) => r.json()),
    fetch(`${tiingoBase}/news/${setup.ticker}?days=7&limit=5`).then((r) => r.json()),
  ]);

  if (eodRes.status === "fulfilled") {
    const d = eodRes.value as { latestClose?: number; latestDate?: string; error?: string };
    enriched.tiingo.eodClose = d.latestClose;
    enriched.tiingo.eodDate = d.latestDate;
    if (d.error) enriched.tiingo.eodError = d.error;
  } else {
    enriched.tiingo.eodError = String(eodRes.reason);
  }

  if (newsRes.status === "fulfilled") {
    const d = newsRes.value as {
      articles?: Array<{ title: string; publishedDate: string }>;
      error?: string;
    };
    enriched.tiingo.newsHeadlines = (d.articles ?? []).slice(0, 5).map(
      (a) => `[${a.publishedDate.split("T")[0]}] ${a.title}`
    );
    if (d.error) enriched.tiingo.newsError = d.error;
  } else {
    enriched.tiingo.newsError = String(newsRes.reason);
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
    const maxTokens = Math.min(20000, Math.max(4000, stats.totalFinal * 120 + 1000));

    const completion = await client.messages.create({
      model, max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const markdown = completion.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");

    const truncated = completion.stop_reason === "max_tokens";

    const preface =
      `> **Filter pipeline:** ${stats.inputRowCount} input → ` +
      `Live: ${stats.live.finalCount} (dropped ${stats.live.droppedHandleStale} stale, ${stats.live.droppedOverCap} over cap) · ` +
      `Pending: ${stats.pending.finalCount} (dropped ${stats.pending.droppedHandleStale} stale, ${stats.pending.droppedOverCap} over cap)\n` +
      `> **Tiingo enrichment:** ${stats.tiingoCallsSucceeded}/${stats.tiingoCallsAttempted} setups with live data\n` +
      `> Handle-staleness filter validated May 2026 (drop >${MAX_HANDLE_DAYS}d).\n\n`;

    return NextResponse.json<JackValidationResponse>({
      schemaVersion: "1.2", timestamp,
      strategy: "Cup with Handle t05", riskPerTrade,
      markdown: preface + (markdown || "**Warning:** Empty response."),
      model, inputRowCount: stats.inputRowCount,
      filterStats: stats,
      tokens: {
        input: completion.usage.input_tokens,
        output: completion.usage.output_tokens,
      },
      degraded: !markdown || truncated,
      error: truncated ? `Output truncated at ${maxTokens} tokens` : null,
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
