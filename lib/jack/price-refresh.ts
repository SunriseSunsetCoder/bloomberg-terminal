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

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// One IEX quote with tngoLast + prevClose kept SEPARATE (fetchIexBatch collapses to a
// single price; the intraday alert monitor needs the live print AND the prior close to
// evaluate approaching-stop/target, big moves, and same-day breakout crosses).
export interface IexQuote {
  ticker: string;
  tngoLast: number | null; // live/last print (the "NOW" price for alerts)
  last: number | null;
  prevClose: number | null;
  price: number | null; // pickIexPrice(q) — the board price (tngoLast→last→prevClose)
  // RUNNING SESSION RANGE — the only intraday source for TP/SL TOUCH detection
  // (lib/jack/alerts.ts). A touch that reverses before the close is invisible to any
  // last/close-based field, which is exactly the bug these two carry. Same free IEX
  // response as the fields above — NO new feed. Null when Tiingo omits them; the
  // touch evaluator then falls back to tngoLast/last.
  dayHigh: number | null;
  dayLow: number | null;
  // Print time, for the RTH gate (09:30–16:00 ET). IEX quotes can carry ext-hours
  // prints, which would fake a touch. Null when absent → the gate fails OPEN and logs.
  timestamp: string | null;
}

// Raw IEX batch (ONE request). Returns null on any permission/empty/malformed
// condition (whole-batch failure → caller falls back / fires a health alert).
export async function fetchIexQuotes(tickers: string[], token: string): Promise<IexQuote[] | null> {
  if (tickers.length === 0) return [];
  try {
    const url = `${TIINGO_IEX}/?tickers=${tickers.join(",")}&token=${token}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data) || data.length === 0) return null;
    return data
      .filter((q) => q?.ticker)
      .map((q) => ({
        ticker: String(q.ticker).toUpperCase(),
        tngoLast: numOrNull(q.tngoLast),
        last: numOrNull(q.last),
        prevClose: numOrNull(q.prevClose),
        price: pickIexPrice(q),
        dayHigh: numOrNull(q.high),
        dayLow: numOrNull(q.low),
        // Tiingo spells the sale time either way depending on endpoint version; take
        // whichever is a string, else null (the RTH gate fails open and logs).
        timestamp: strOrNull(q.timestamp) ?? strOrNull(q.lastSaleTimeStamp) ?? strOrNull(q.quoteTimestamp),
      }));
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

/**
 * Write the shared jack:prices store (read FIRST by the open-positions route). The
 * intraday alert monitor uses this to keep the board fresh from its own IEX fetch
 * without re-running the whole runPriceRefresh path. 24h TTL, non-fatal on failure.
 */
export async function persistPrices(store: StoredPrices): Promise<void> {
  await redis.set(PRICES_KEY, store, { ex: 24 * 60 * 60 }).catch(() => {
    // non-fatal — a failed board write just means the next refresh/read recovers
  });
}
