import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";
import type { OpenPositionRow } from "@/lib/db/read";
import {
  buildPositionMgmtPrompt,
  parsePositionReads,
  computeUnrealizedPct,
  computeDaysHeld,
  computeRulesFlag,
  positionEtDay,
  positionKey,
  type PositionInput,
  type PositionReadResult,
} from "@/lib/jack/position-mgmt";
import { computeSizing, recommendedSizing, normalizeSizeBucket } from "@/lib/jack/handle-score";

// Risk/trade for turning an open position's directive into concrete share counts.
// Matches the validation route default; open positions carry no per-run override.
const OPEN_RISK_PER_TRADE = 2000;

export const maxDuration = 60; // Tiingo price fetches + one Claude position-mgmt call
export const dynamic = "force-dynamic";

// ============================================================
// Open positions — every setup marked TRADED with an entry but no exit yet,
// REGARDLESS of the current run. Three layers per position:
//   A. FROZEN THESIS — jack_analysis_at_mark, the immutable "why I entered".
//   B. CURRENT PRICE — Tiingo latest EOD close → unrealized %, days held, a fast
//      rules-based flag (near stop / near target / underwater / past time stop).
//   C. LIVE RE-READ — a NEW position-management LLM call (HOLD/EXIT/REDUCE + why),
//      always-on per run. This is a DIFFERENT prompt than the scan validation.
//
// Returned as JackDecisionClient rows (section "open") so the JACK table renders
// them as fully-editable TRADED rows at the top of the working view; the exit-fill
// write still goes through updateUserFills via /api/jack-decisions. READ-ONLY here
// — the re-read is display-only and NEVER overwrites the frozen thesis or outcome.
// Vercel-guarded (localhost SQLite only).
// ============================================================

interface OpenPositionsResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  positions: JackDecisionClient[];
  reReadAvailable?: boolean; // false if ANTHROPIC_API_KEY missing (frozen + rules still shown)
  reason?: string;
  error?: string;
}

const MODEL = "claude-sonnet-4-5";
const READ_BATCH = 10; // batch the LLM re-read if the book ever exceeds this

// Current-price cache, per (ticker, ET day) — the latest EOD close is stable
// within a market day, so a re-fetch the same day reuses it. In-memory per process.
const priceCache = new Map<string, number | null>();

// Position re-read cache, per (ET day + book signature). Determinism is day-stable
// and depends on current price, so the signature captures both. Same book, same
// prices, same day → reuse (no extra Claude call). In-memory per process.
const reReadCache = new Map<string, Map<string, PositionReadResult>>();

function tiingoBaseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/api/tiingo`;
}

async function fetchCurrentPrice(ticker: string, tiingoBase: string, day: string): Promise<number | null> {
  const cacheKey = `${ticker.toUpperCase()}|${day}`;
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey) ?? null;
  let price: number | null = null;
  try {
    const res = await fetch(`${tiingoBase}/eod/${ticker}?days=7`);
    if (res.ok) {
      const d = (await res.json().catch(() => ({}))) as { latestClose?: number };
      price = typeof d.latestClose === "number" ? d.latestClose : null;
    }
  } catch {
    price = null;
  }
  priceCache.set(cacheKey, price);
  return price;
}

function toPositionInput(r: OpenPositionRow): PositionInput {
  return {
    ticker: r.ticker,
    handleLowDate: r.handleLowDate,
    entry: r.entry,
    stop: r.stop,
    target: r.target,
    breakout: r.breakout,
    jackDecisionAtMark: r.jackDecisionAtMark,
    jackAnalysisAtMark: r.jackAnalysisAtMark,
    userEntryPrice: r.userEntryPrice,
    userEntryDate: r.userEntryDate,
  };
}

/**
 * Run (or reuse cached) the position-management re-read for the whole open book.
 * temp 0 + day-stable context = deterministic within a day; cached by day + book
 * signature so repeated GETs the same day don't re-call Claude. Batches at
 * READ_BATCH. Returns a map positionKey → read; empty map if no API key (degrade).
 */
async function runReReads(
  client: Anthropic,
  positions: PositionInput[],
  currentPrices: Map<string, number | null>,
  now: Date
): Promise<Map<string, PositionReadResult>> {
  const day = positionEtDay(now);
  const signature = positions
    .map((p) => `${positionKey(p.ticker, p.handleLowDate)}:${currentPrices.get(positionKey(p.ticker, p.handleLowDate)) ?? "?"}`)
    .sort()
    .join(",");
  const cacheKey = `${day}|${signature}`;
  const cached = reReadCache.get(cacheKey);
  if (cached) return cached;

  const out = new Map<string, PositionReadResult>();
  const batches: PositionInput[][] = [];
  for (let i = 0; i < positions.length; i += READ_BATCH) batches.push(positions.slice(i, i + READ_BATCH));

  const results = await Promise.all(
    batches.map(async (batch) => {
      const prompt = buildPositionMgmtPrompt(batch, currentPrices, now);
      const c = await client.messages.create({
        model: MODEL,
        max_tokens: Math.min(8000, batch.length * 400 + 1000),
        temperature: 0, // deterministic — same guarantee as the scan pipeline
        messages: [{ role: "user", content: prompt }],
      });
      const text = c.content
        .filter((bl) => bl.type === "text")
        .map((bl) => (bl as { type: "text"; text: string }).text)
        .join("\n");
      return parsePositionReads(text);
    })
  );

  for (const reads of results) {
    for (const r of reads) out.set(positionKey(r.ticker, r.handleLowDate), r);
  }
  reReadCache.set(cacheKey, out);
  return out;
}

export async function GET(req: NextRequest) {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<OpenPositionsResponse>({
      ok: false,
      persistenceAvailable: false,
      positions: [],
      reason: persistenceUnavailableReason(),
    });
  }
  try {
    const { getOpenPositions } = require("@/lib/db/read") as typeof import("@/lib/db/read");
    const rows = getOpenPositions();

    if (rows.length === 0) {
      return NextResponse.json<OpenPositionsResponse>({ ok: true, persistenceAvailable: true, positions: [], reReadAvailable: true });
    }

    const now = new Date();
    const day = positionEtDay(now);
    const tiingoBase = tiingoBaseUrl(req);

    // Part B — current price per open ticker (parallel, cached per day).
    const priceEntries = await Promise.all(
      rows.map(async (r) => [positionKey(r.ticker, r.handleLowDate), await fetchCurrentPrice(r.ticker, tiingoBase, day)] as const)
    );
    const currentPrices = new Map<string, number | null>(priceEntries);

    // Part C — live LLM re-read (always-on). Degrades to rules-only if no key.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const reReadAvailable = !!apiKey;
    let reads = new Map<string, PositionReadResult>();
    if (apiKey) {
      try {
        const client = new Anthropic({ apiKey });
        reads = await runReReads(client, rows.map(toPositionInput), currentPrices, now);
      } catch {
        reads = new Map(); // non-fatal — frozen thesis + rules still render
      }
    }

    const positions: JackDecisionClient[] = rows.map((r) => {
      const key = positionKey(r.ticker, r.handleLowDate);
      const current = currentPrices.get(key) ?? null;
      const entryPrice = r.userEntryPrice ?? r.entry ?? null;
      const daysHeld = computeDaysHeld(r.userEntryDate, now);
      const unrealizedPct = computeUnrealizedPct(entryPrice, current);
      const flag = computeRulesFlag({ entryPrice, stop: r.stop, target: r.target, current, daysHeld });
      const read = reads.get(key);
      const sizeBucket = normalizeSizeBucket(r.sizeBucket);
      const sizing = computeSizing(OPEN_RISK_PER_TRADE, r.entry, r.stop);
      const rec = recommendedSizing(sizeBucket, sizing);
      return {
        decisionId: r.decisionId,
        setupId: r.setupId,
        ticker: r.ticker,
        handleLowDate: r.handleLowDate,
        section: "open",
        decision: r.jackDecisionAtMark ?? "TRADED",
        entry: r.entry,
        stop: r.stop,
        target: r.target,
        shares: r.shares,
        breakout: r.breakout,
        currentPrice: current, // Part B — "NOW" on the price ladder
        note: null,
        newsClass: null,
        sectorRs: null,
        crossAsset: null,
        earningsFlag: null,
        pctToBreakout: null,
        userAction: "TRADED",
        userEntryPrice: r.userEntryPrice,
        userEntryDate: r.userEntryDate,
        userExitPrice: r.userExitPrice, // null (open) — field the user fills to close
        userExitDate: r.userExitDate,
        jackDecisionAtMark: r.jackDecisionAtMark,
        sharesAtMark: r.shares,
        // handle_score signal — informational on an already-held position.
        handleScore: r.handleScore,
        sizeBucket,
        fullShares: sizing.fullShares,
        fullNotional: sizing.fullNotional,
        halfShares: sizing.halfShares,
        halfNotional: sizing.halfNotional,
        recShares: rec.shares,
        recNotional: rec.notional,
        // Part A — frozen entry thesis (immutable).
        jackAnalysisAtMark: r.jackAnalysisAtMark,
        // Part B — fast rules layer.
        unrealizedPct,
        daysHeld,
        rulesFlag: flag?.label ?? null,
        rulesTone: flag?.tone ?? null,
        // Part C — live re-read (updates each run).
        liveReadVerdict: read?.verdict ?? null,
        liveReadThesisStatus: read?.thesisStatus ?? null,
        liveReadReasoning: read?.reasoning ?? null,
      };
    });

    return NextResponse.json<OpenPositionsResponse>({ ok: true, persistenceAvailable: true, positions, reReadAvailable });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<OpenPositionsResponse>(
      { ok: false, persistenceAvailable: true, positions: [], error: msg },
      { status: 500 }
    );
  }
}
