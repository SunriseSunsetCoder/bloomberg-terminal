/**
 * Scheduled JACK price refresh + alerts — America/New_York wall-clock (DST-safe),
 * weekends + NYSE holidays skipped. Extends the existing lib/scheduler (60s tick):
 *
 *   · INTRADAY MONITOR — every ~30 min while the market is open (09:30–16:00 ET).
 *     Raw IEX fetch for the open book + pending setups → refresh jack:prices (keeps
 *     the board fresh, superseding the old standalone 10:00 slot) → evaluate HEADS-UP
 *     alerts. A per-30-min-bucket Redis marker makes each bucket fire once/day.
 *   · EOD PASS — 18:00 ET (unchanged): eod refresh + runOutcomeTracker, then evaluate
 *     the close-based SYSTEM alerts. Per-slot Redis marker (= today's ET date).
 *
 * Refresh failures / whole-batch IEX failures push OPERATIONAL health alerts. VPS-only
 * (needs the open book from SQLite). Alerts self-disable gracefully when their envs are
 * unset — the board still refreshes.
 */
// Side-effect import FIRST so the market-data task always registers before this one
// (load-spread ordering), matching lib/jack/outcomes-refresh.ts.
import "@/lib/market-data-refresh";
import scheduler from "@/lib/scheduler";
import { redis } from "@/lib/redis";
import { isPersistenceAvailable } from "@/lib/db/env";
import { runPriceRefresh, fetchIexQuotes, persistPrices, type StoredPrices } from "./price-refresh";
import { isTradingDay, isMarketOpen, etParts, etDateISO } from "./market-hours";
import { evaluateIntradayAlerts, evaluateEodAlerts, fireHealth } from "./alerts";

const EOD_SLOT = { hour: 18, minute: 0 };
const WINDOW_MINUTES = 15;

function selfBase(): string {
  return process.env.JACK_SELF_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
}

/**
 * Intraday monitor: one raw IEX batch for the open book + pending tickers, refresh
 * jack:prices with what we got (missing tickers EOD-fall-back at board-read time), then
 * evaluate heads-up alerts. Whole-batch IEX failure → health alert + skip (never wipes
 * the store). Throws propagate to the caller, which fires an intraday_refresh health alert.
 */
async function runIntradayMonitor(now: Date): Promise<void> {
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
  const open = dbRead.getOpenPositions();
  const pending = dbRead.getPendingSetups();
  const tickers = Array.from(
    new Set([...open.map((p) => p.ticker), ...pending.map((s) => s.ticker)].map((t) => t.toUpperCase()))
  );
  if (tickers.length === 0) return;

  const etDate = etDateISO(now);
  const token = process.env.TIINGO_API_KEY;
  const quotes = token ? await fetchIexQuotes(tickers, token) : null;
  if (!quotes) {
    // whole-batch IEX failure (or no token) → health alert; don't overwrite the store.
    await fireHealth("iex_batch", "intraday IEX batch returned no data", etDate);
    return;
  }

  // Refresh the board from the IEX prices we got (only tickers with a usable price;
  // any missing ticker EOD-falls-back when the open-positions route reads the store).
  const prices: StoredPrices["prices"] = {};
  const asOf = now.toISOString();
  for (const q of quotes) if (q.price != null) prices[q.ticker] = { price: q.price, source: "iex", asOf };
  await persistPrices({ asOf, mode: "intraday", iexUnavailable: false, prices });

  await evaluateIntradayAlerts(quotes, now);
}

export async function priceScheduleTick(): Promise<void> {
  if (!isPersistenceAvailable()) return; // VPS-only
  const now = new Date();
  if (!isTradingDay(now)) return; // weekend / NYSE holiday

  const { hour, minute } = etParts(now);
  const today = etDateISO(now);

  // --- INTRADAY MONITOR: every ~30 min during market hours ---
  if (isMarketOpen(now)) {
    const bucket = minute < 30 ? "00" : "30";
    const markerKey = `jack:monitor:slot:${today}:${hour}:${bucket}`;
    let already: unknown = null;
    try {
      already = await redis.get(markerKey);
    } catch {
      already = null;
    }
    if (already == null) {
      // Claim the bucket BEFORE running so a slow monitor can't be double-fired by the
      // next 60s tick (24h TTL — the ET-date in the key re-arms buckets each day).
      try {
        await redis.set(markerKey, "1", { ex: 24 * 60 * 60 });
      } catch {
        // proceed anyway — a rare double-run is idempotent (dedup is per alert)
      }
      try {
        await runIntradayMonitor(now);
      } catch (err) {
        console.error("JACK intraday monitor failed:", err);
        try {
          await fireHealth("intraday_refresh", err instanceof Error ? err.message : String(err), today);
        } catch {
          /* health alert best-effort */
        }
      }
    }
  }

  // --- EOD PASS: 18:00 ET (refresh + outcomes, then close-based SYSTEM alerts) ---
  const inEodWindow =
    hour === EOD_SLOT.hour && minute >= EOD_SLOT.minute && minute < EOD_SLOT.minute + WINDOW_MINUTES;
  if (inEodWindow) {
    const markerKey = `jack:refresh:slot:eod`;
    let already: unknown = null;
    try {
      already = await redis.get(markerKey);
    } catch {
      already = null;
    }
    if (already !== today) {
      try {
        await redis.set(markerKey, today, { ex: 36 * 60 * 60 });
      } catch {
        // proceed — the outcome tracker + alert dedup are idempotent
      }
      try {
        const r = await runPriceRefresh({ mode: "eod", selfBase: selfBase() });
        console.log(
          `JACK price refresh (scheduled eod): ${r.updated} tickers` +
            (r.iexUnavailable ? " · IEX unavailable → EOD fallback" : "") +
            (r.ranOutcomes ? ` · outcomes: ${r.outcomeSummary}` : "")
        );
        // Close-based SYSTEM alerts, evaluated AFTER the eod refresh wrote jack:prices.
        await evaluateEodAlerts(now);
      } catch (err) {
        console.error("JACK price refresh (scheduled eod) failed:", err);
        try {
          await fireHealth("eod_refresh", err instanceof Error ? err.message : String(err), today);
        } catch {
          /* health alert best-effort */
        }
      }
    }
  }
}

// ~1-min interval → runs on each 60s scheduler tick; the ET gates do the rest.
scheduler.register(
  "jack-price-refresh",
  "JACK Price Refresh + Alerts (30m intraday / 18:00 ET eod)",
  1 / 60,
  priceScheduleTick
);

export default priceScheduleTick;
