import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Type-only imports compile away — safe on Vercel where the DB layer never loads.
import type { SetupSeen, DecisionRow, InsertedDecisionId } from "@/lib/db/write";
// The concrete write functions are loaded lazily via require() inside persistRun()
// so better-sqlite3 is never required on Vercel (isPersistenceAvailable() === false).
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
import {
  normalizeIsoDate,
  buildDecidedKeys,
  incompleteForSetups,
  isDegraded,
} from "@/lib/jack/reconcile";
// Pure validation layer (CSV parse / filter / JSON extract / row build) lives in
// lib/ so selftests can import applyFilters + buildClientDecisions — Next route
// files may only export handlers + config, so these can't be exported from here.
import {
  applyFilters,
  extractJsonBlock,
  buildClientDecisions,
  DEFAULT_RISK_PER_TRADE,
  MAX_HANDLE_DAYS,
  type ParsedSetup,
  type EnrichedSetup,
  type TiingoData,
  type FilterStats,
  type SectionedSetups,
  type JackDecisionClient,
  type ExtractedPayload,
  type ExtractedDecision,
} from "@/lib/jack/validation-core";

export const maxDuration = 120; // longer for parallel Tiingo enrichment
export const dynamic = "force-dynamic";

// ============================================================
// Configuration
// ============================================================

const INDIVIDUAL_CAP_MULTIPLIER = 100;
const SESSION_CAP_MULTIPLIER = 400;
// DEFAULT_RISK_PER_TRADE, MAX_HANDLE_DAYS, the section caps, and status
// classification live in @/lib/jack/validation-core (imported above) alongside the
// pure filter/parse logic that uses them.

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
// Types — ParsedSetup / EnrichedSetup / SectionStats / FilterStats /
// JackDecisionClient / SectionedSetups / ExtractedPayload / ExtractedDecision
// live in @/lib/jack/validation-core (imported above) with the pure logic.
// ============================================================

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

// Split an array into fixed-size chunks (for sub-batching Claude calls so no
// single call carries enough setups to hit its output-token cap). Local, NOT
// exported — Next route modules may only export handlers + allowed config.
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Bug B hardening: DAY-precision session context. Previously this embedded the
// clock time (minute) and the intra-day session phase (PREMARKET/REGULAR/...),
// both of which change through the day — so re-VALIDATE minutes later produced a
// different prompt even at temperature 0. Now it's stable for the whole calendar
// day: identical CSV re-validated later the same day → identical prompt text.
// `now` is injectable for deterministic testing.
function buildSessionContext(now: Date = new Date()): string {
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
function etDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

// ============================================================
// Tiingo enrichment — parallel fetches for surviving setups
// (CSV parsing + the Live/Pending filter pipeline are in
//  @/lib/jack/validation-core — applyFilters, imported above.)
// ============================================================

// Bug B hardening: cache Tiingo enrichment per (ticker, ET calendar-day). A
// re-VALIDATE the same market day reuses identical price/news data instead of
// re-fetching (the news endpoint especially can return new articles intraday,
// which would perturb the prompt). In-memory, per server process. Exported so
// tests can reset it; other-day entries are pruned in enrichAllSetups.
const enrichCache = new Map<string, TiingoData>();

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

async function enrichAllSetups(
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
// JSON extraction — ExtractedPayload / ExtractedDecision / extractJsonBlock live
// in @/lib/jack/validation-core (imported above). normalizeIsoDate is in
// @/lib/jack/reconcile.
// ============================================================

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

interface PersistResult {
  runId?: number;
  setupsUpserted: number;
  decisionsInserted: number;
  decisionsSkipped: number;
  jsonParseSuccess: boolean;
  decisionIds: InsertedDecisionId[];
  // Bug A: existing marks for the setups in this run, keyed by setup_id.
  userMarks: Map<number, import("@/lib/db/read").UserMark>;
  // Watchlist retirement counts for this ingest (see retireSupersededSetups).
  retired: number;
  unretired: number;
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
    retired: 0,
    unretired: 0,
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
        // handle_score signal — persisted on the setup so the ranking, display,
        // and forward-test all read one canonical value.
        handleScore: setup.handleScore,
        sizeBucket: setup.sizeBucket,
        // Scanner classification columns (persisted like size_bucket).
        sector: setup.sector,
        tier: setup.tier,
        priority: setup.priority,
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

      // 3b. Retire prior watchlist ideas this scan no longer carries, so the pending
      // set (and the alerts riding on it) stays equal to what the board displays
      // instead of accumulating stale setups run after run. Only for a run that
      // actually produced decisions — a parse-failed run is not the board (see
      // getCurrentRunId), so it must not retire anything. Writes to `setups` only:
      // TRADED / exited state is never touched, and an ever-TRADED setup is never
      // retired at all. Non-fatal: wrapped by the outer try/catch like the rest of
      // persistence.
      if (inserted > 0) {
        const r = dbWrite.retireSupersededSetups(
          [...setupIdMap.values()],
          runId,
          args.timestamp
        );
        result.retired = r.retired;
        result.unretired = r.unretired;
      }
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
function buildSectionedPrompt(
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

  // Output-token handling. A live 75-setup run truncated a 30-setup LIVE pass at
  // ~6.3k out-tokens (real need >210/setup — the old 160 budget was far too low),
  // which garbles the tail of the output. Two-layer fix:
  //  (1) budgets sized for the ACTUAL worst case with headroom, and
  //  (2) SUB-BATCHING — each pass is chunked so no single Claude call carries
  //      enough setups to approach its cap, making truncation effectively
  //      impossible regardless of week size. All chunks run in parallel.
  // A normal week (<= SPLIT_THRESHOLD) is one full "both" call (no pending-compact
  // downgrade); larger weeks split into a full LIVE pass + compact PENDING pass,
  // each sub-batched. Determinism (temp 0 + day-stable context) and the JSON
  // contract are unchanged. Status-priority sectioning ONLY — no setup-feature
  // ranking (winner/loser + ranking research both returned NULL).
  // Cap-harden (2026-07-20): budgets sized for the WORST case (verbose news →
  // long notes), batches shrunk, and every ceiling kept UNDER the ~16k
  // non-streaming line (Anthropic guidance: stream above ~16k or risk SDK HTTP
  // timeouts — this path is deliberately non-streaming). sonnet-4-5's own output
  // ceiling (~64k) is NOT the constraint; the per-batch max_tokens WE set is.
  const LIVE_TOKENS_PER_SETUP = 700; // full reasoning + JSON row + 14-col table row (worst case)
  const PENDING_TOKENS_PER_SETUP = 260; // compact but context-preserving
  const BOTH_TOKENS_PER_SETUP = 480;
  const LIVE_BATCH = 10; // <= 10 live/call → budget ~10k, realistic ~7-8k: deep headroom
  const PENDING_BATCH = 24; // <= 24 pending/call → budget ~8k
  const HARD_CAP = 15000; // initial-budget ceiling — stays under the ~16k non-streaming line
  const RETRY_MAX_TOKENS = 16000; // absolute retry ceiling — still non-streaming-safe
  const SPLIT_THRESHOLD = 24; // <= 24 setups: single "both" call (also stays small); larger: split + sub-batch
  const shouldSplit = stats.totalFinal > SPLIT_THRESHOLD;

  type Batch = { liveS: EnrichedSetup[]; pendingS: EnrichedSetup[]; mode: "both" | "live" | "pending"; maxTokens: number };
  const jobs: Batch[] = [];
  if (shouldSplit) {
    for (const g of chunk(enrichedLive, LIVE_BATCH))
      jobs.push({ liveS: g, pendingS: [], mode: "live", maxTokens: Math.min(HARD_CAP, g.length * LIVE_TOKENS_PER_SETUP + 3000) });
    for (const g of chunk(enrichedPending, PENDING_BATCH))
      jobs.push({ liveS: [], pendingS: g, mode: "pending", maxTokens: Math.min(HARD_CAP, g.length * PENDING_TOKENS_PER_SETUP + 2000) });
  } else {
    jobs.push({
      liveS: enrichedLive,
      pendingS: enrichedPending,
      mode: "both",
      maxTokens: Math.min(HARD_CAP, Math.max(8000, stats.totalFinal * BOTH_TOKENS_PER_SETUP + 3000)),
    });
  }

  const runBatch = async (
    b: Batch
  ): Promise<{ text: string; inTok: number; outTok: number; truncated: boolean } | null> => {
    if (b.liveS.length === 0 && b.pendingS.length === 0) return null;
    const prompt = buildSectionedPrompt(headerLine, b.liveS, b.pendingS, riskPerTrade, b.mode);
    const callOnce = async (maxTokens: number) => {
      const c = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: 0, // reproducible validations (Bug B) — preserved
        messages: [{ role: "user", content: prompt }],
      });
      const text = c.content
        .filter((bl) => bl.type === "text")
        .map((bl) => (bl as { type: "text"; text: string }).text)
        .join("\n");
      return { text, inTok: c.usage.input_tokens, outTok: c.usage.output_tokens, truncated: c.stop_reason === "max_tokens" };
    };
    let res = await callOnce(b.maxTokens);
    // SINGLE generous retry-on-truncation (handoff decision 2). temp 0 makes the
    // retry reproduce the same prefix; only the cap grows. Accumulate BOTH attempts'
    // tokens so cost accounting is honest (the prompt is re-sent, so input bills twice).
    // TODO(cap-harden): if the RETRY still truncates, split this batch in half and
    // re-run each half — NOT built. A single retry to ~16k suffices given the
    // per-batch headroom (LIVE_BATCH=10 → ~7-8k realistic vs 16k retry ceiling).
    if (res.truncated) {
      const retryTokens = Math.min(RETRY_MAX_TOKENS, b.maxTokens * 2);
      if (retryTokens > b.maxTokens) {
        const retry = await callOnce(retryTokens);
        res = { ...retry, inTok: res.inTok + retry.inTok, outTok: res.outTok + retry.outTok };
      }
    }
    return res;
  };

  try {
    const results = (await Promise.all(jobs.map(runBatch))).filter((r): r is NonNullable<typeof r> => !!r);
    const parsed = results.map((r) => extractJsonBlock(r.text)).filter((p): p is ExtractedPayload => !!p);
    const truncated = results.some((r) => r.truncated);

    // Because the JSON block is emitted FIRST, a truncation normally cuts the
    // trailing markdown, not the decisions. But defend against ANY dropped/cut
    // setup: every input setup with no returned decision gets an explicit
    // INCOMPLETE placeholder — never a silent drop, never a confident-but-wrong
    // verdict emitted as if valid (the reported "SIZE DOWN 50% at R/R 2.83" was a
    // legitimate check-driven verdict, not a truncation artifact — see report).
    const liveDecisions: ExtractedDecision[] = parsed.flatMap((p) => p.live_decisions ?? []);
    const pendingDecisions: ExtractedDecision[] = parsed.flatMap((p) => p.pending_decisions ?? []);
    // Reconcile via the pure helper (unit-tested in jack-analysis-cap-selftest):
    // every input setup with no returned decision gets an explicit INCOMPLETE
    // placeholder. incompleteCount = REAL decision loss (drives degraded, below).
    const decidedKeys = buildDecidedKeys([...liveDecisions, ...pendingDecisions]);
    const liveIncomplete = incompleteForSetups(enrichedLive, decidedKeys, truncated);
    const pendingIncomplete = incompleteForSetups(enrichedPending, decidedKeys, truncated);
    liveDecisions.push(...liveIncomplete);
    pendingDecisions.push(...pendingIncomplete);
    const incompleteCount = liveIncomplete.length + pendingIncomplete.length;
    // Error/degrade fire on REAL loss (INCOMPLETE setups), not raw stop_reason.
    // A truncation that cut only trailing markdown (all decisions parsed) →
    // incompleteCount 0 → NOT degraded. Kills the false-degrade churn.
    const incompleteError =
      incompleteCount > 0
        ? `${incompleteCount} setup${incompleteCount === 1 ? "" : "s"} INCOMPLETE — re-run${truncated ? " (output hit the token cap)" : ""}`
        : null;

    // Merge into the SAME extracted shape persistence + client already consume.
    // JSON CONTRACT UNCHANGED — Session C reads the identical decision columns.
    const extracted: ExtractedPayload | null =
      liveDecisions.length || pendingDecisions.length
        ? { schema_version: parsed[0]?.schema_version ?? "1.3", live_decisions: liveDecisions, pending_decisions: pendingDecisions }
        : null;

    const stripJson = (t: string) => t.replace(/```json\s*\n[\s\S]*?\n```/g, "").trim();
    const markdownForClient = results.map((r) => stripJson(r.text)).filter(Boolean).join("\n\n---\n\n");
    const fullResponse = results.map((r) => r.text).join("\n\n---\n\n");
    const tokensInput = results.reduce((acc, r) => acc + r.inTok, 0);
    const tokensOutput = results.reduce((acc, r) => acc + r.outTok, 0);

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
      errorMsg: incompleteError ?? undefined,
    });

    const persistNote = !isPersistenceAvailable()
      ? `> **Persistence:** ${persistenceUnavailableReason()}\n`
      : persistResult.error
        ? `> ⚠ Persistence error: ${persistResult.error}\n`
        : `> **Persistence:** run #${persistResult.runId ?? "?"} · ${persistResult.setupsUpserted} setups tracked · ${persistResult.decisionsInserted} decisions recorded${persistResult.decisionsSkipped > 0 ? ` · ${persistResult.decisionsSkipped} skipped (unmatched)` : ""}${persistResult.retired > 0 ? ` · ${persistResult.retired} stale setups retired` : ""}${persistResult.unretired > 0 ? ` · ${persistResult.unretired} returned to the watchlist` : ""}${persistResult.jsonParseSuccess ? "" : " · ⚠ JSON parse failed, only run metadata stored"}\n`;

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
      persistResult.userMarks,
      riskPerTrade
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
      degraded: isDegraded(!!markdownForClient, incompleteCount),
      error: incompleteError,
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
