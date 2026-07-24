// =============================================================================
// JACK price refresh — updates NOW price (+ downstream unrealized P&L) for the
// open-position board WITHOUT the LLM thesis re-read.
//   · intraday → Tiingo IEX batch (tngoLast → last → prevClose), DISPLAY-ONLY.
//   · eod      → Tiingo EOD close per ticker + runOutcomeTracker (close-based).
// Writes a Redis price store (jack:prices) that the open-positions route reads
// FIRST (before its in-memory EOD map). Defensive: any IEX failure falls back to
// EOD prices for that refresh and flags iexUnavailable — never throws on IEX.
//
// The pure pickers (pickIexPrice / mapIexBatch) are unit-tested; runPriceRefresh is
// I/O (Tiingo + Redis + DB) and verified by the endpoint/scheduler + the VPS reach test.
// =============================================================================
import { redis } from "@/lib/redis";
import { runOutcomeTracker, DEFAULT_RESOLUTION_DAYS } from "@/lib/jack/outcome-tracker";

export const PRICES_KEY = "jack:prices";
const TIINGO_IEX = "https://api.tiingo.com/iex";

export type RefreshMode = "intraday" | "eod";

export interface StoredPrices {
  asOf: string; // ISO — the ET-day freshness is derived from this by the reader
  mode: RefreshMode;
  iexUnavailable: boolean;
  prices: Record<string, { price: number; source: "iex" | "eod"; asOf: string }>;
}

export interface RefreshResult {
  ok: boolean;
  mode: RefreshMode;
  updated: number; // tickers written with a price
  iexUnavailable: boolean;
  ranOutcomes: boolean;
  outcomeSummary?: string;
  asOf: string;
  error?: string;
}

// One IEX quote → a usable price. tngoLast is the live/last print (populated even
// after hours, when `last` is null); prevClose is the final defensive rung.
export function pickIexPrice(q: {
  tngoLast?: number | null;
  last?: number | null;
  prevClose?: number | null;
}): number | null {
  for (const v of [q.tngoLast, q.last, q.prevClose]) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// IEX batch array → { TICKER: price } (only entries with a usable price).
export function mapIexBatch(
  arr: Array<{ ticker?: string; tngoLast?: number | null; last?: number | null; prevClose?: number | null }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of arr) {
    if (!q?.ticker) continue;
    const p = pickIexPrice(q);
    if (p != null) out[q.ticker.toUpperCase()] = p;
  }
  return out;
}

// Batch IEX call for all open tickers (ONE request). Returns null on any
// permission/empty/malformed condition so the caller falls back to EOD.
async function fetchIexBatch(tickers: string[], token: string): Promise<Record<string, number> | null> {
  if (tickers.length === 0) return {};
  try {
    const url = `${TIINGO_IEX}/?tickers=${tickers.join(",")}&token=${token}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null; // 401/403/etc → defensive fallback
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data) || data.length === 0) return null; // empty/malformed
    return mapIexBatch(data);
  } catch {
    return null;
  }
}

// Latest finalized EOD close via the existing internal proxy (its own 8h cache).
async function fetchEodClose(tiingoApiBase: string, ticker: string): Promise<number | null> {
  try {
    const res = await fetch(`${tiingoApiBase}/eod/${ticker}?days=7`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = (await res.json().catch(() => ({}))) as { latestClose?: number };
    return typeof d.latestClose === "number" ? d.latestClose : null;
  } catch {
    return null;
  }
}

/**
 * Run a price refresh for the current open book. `selfBase` is the app origin
 * (e.g. http://localhost:3000); the internal Tiingo proxy is `${selfBase}/api/tiingo`.
 * Assumes persistence is available (callers guard).
 */
export async function runPriceRefresh(opts: { mode: RefreshMode; selfBase: string }): Promise<RefreshResult> {
  const { mode } = opts;
  const selfBase = opts.selfBase.replace(/\/$/, "");
  const tiingoApiBase = `${selfBase}/api/tiingo`;
  const asOf = new Date().toISOString();

  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
  const rows = dbRead.getOpenPositions();
  const tickers = Array.from(new Set(rows.map((r) => r.ticker.toUpperCase())));

  const prices: StoredPrices["prices"] = {};
  let iexUnavailable = false;

  if (mode === "intraday") {
    const token = process.env.TIINGO_API_KEY;
    const iex = token ? await fetchIexBatch(tickers, token) : null;
    if (!iex) iexUnavailable = true; // whole-batch failure → EOD fallback below
    for (const t of tickers) {
      let price = iex?.[t] ?? null;
      let source: "iex" | "eod" = "iex";
      if (price == null) {
        // per-ticker fallback (missing from IEX, or whole batch failed)
        price = await fetchEodClose(tiingoApiBase, t);
        source = "eod";
      }
      if (price != null) prices[t] = { price, source, asOf };
    }
  } else {
    // eod: finalized close for every ticker.
    for (const t of tickers) {
      const price = await fetchEodClose(tiingoApiBase, t);
      if (price != null) prices[t] = { price, source: "eod", asOf };
    }
  }

  const store: StoredPrices = { asOf, mode, iexUnavailable, prices };
  await redis.set(PRICES_KEY, store, { ex: 24 * 60 * 60 }).catch(() => {
    // non-fatal — the endpoint still reports what it computed
  });

  // Outcomes ONLY on the eod path — the strategy is close-based, so a midday
  // intraday move must never finalize a target/stop hit.
  let ranOutcomes = false;
  let outcomeSummary: string | undefined;
  if (mode === "eod") {
    try {
      const summary = await runOutcomeTracker({ resolutionDays: DEFAULT_RESOLUTION_DAYS, tiingoBase: tiingoApiBase });
      ranOutcomes = true;
      outcomeSummary = summary.message;
    } catch (err) {
      outcomeSummary = `outcome tracker failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { ok: true, mode, updated: Object.keys(prices).length, iexUnavailable, ranOutcomes, outcomeSummary, asOf };
}
