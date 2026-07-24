/**
 * Scheduled JACK price refresh — twice per trading day, America/New_York wall-clock
 * (DST-safe), weekends + NYSE holidays skipped:
 *   · 10:00 ET (30 min after open) → intraday (Tiingo IEX), display-only.
 *   · 18:00 ET (after the finalized EOD bar posts) → eod + outcome tracker.
 *
 * Extends the existing lib/scheduler (no second mechanism). The scheduler ticks
 * ~every 60s; this task registers on a ~1-min interval and gates on the ET clock,
 * with a per-slot Redis marker (= today's ET date) so each slot fires exactly once
 * per day and survives a restart. A 15-min window catches a slot even if a tick is
 * missed. VPS-only (needs the open book from SQLite).
 */
// Side-effect import FIRST so the market-data task always registers before this one
// (load-spread ordering), matching lib/jack/outcomes-refresh.ts.
import "@/lib/market-data-refresh";
import scheduler from "@/lib/scheduler";
import { redis } from "@/lib/redis";
import { isPersistenceAvailable } from "@/lib/db/env";
import { runPriceRefresh, type RefreshMode } from "./price-refresh";
import { isTradingDay, etParts, etDateISO } from "./market-hours";

const SLOTS: Array<{ mode: RefreshMode; hour: number; minute: number }> = [
  { mode: "intraday", hour: 10, minute: 0 },
  { mode: "eod", hour: 18, minute: 0 },
];
const WINDOW_MINUTES = 15;

function selfBase(): string {
  return process.env.JACK_SELF_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
}

export async function priceScheduleTick(): Promise<void> {
  if (!isPersistenceAvailable()) return; // VPS-only
  const now = new Date();
  if (!isTradingDay(now)) return; // weekend / NYSE holiday

  const { hour, minute } = etParts(now);
  const today = etDateISO(now);

  for (const slot of SLOTS) {
    const inWindow = hour === slot.hour && minute >= slot.minute && minute < slot.minute + WINDOW_MINUTES;
    if (!inWindow) continue;

    const markerKey = `jack:refresh:slot:${slot.mode}`;
    let already: unknown = null;
    try {
      already = await redis.get(markerKey);
    } catch {
      already = null;
    }
    if (already === today) continue; // this slot already ran today

    // Claim the slot BEFORE running so a slow eod run (outcome tracker) can't be
    // double-fired by the next 60s tick. A failed slot won't auto-retry today — the
    // 180s board refetch + the manual REFRESH PRICES button are the recovery paths.
    try {
      await redis.set(markerKey, today, { ex: 36 * 60 * 60 });
    } catch {
      // if the marker can't be written, still proceed (better a rare double-run,
      // which is idempotent, than skipping the slot entirely).
    }

    try {
      const r = await runPriceRefresh({ mode: slot.mode, selfBase: selfBase() });
      console.log(
        `JACK price refresh (scheduled ${slot.mode}): ${r.updated} tickers` +
          (r.iexUnavailable ? " · IEX unavailable → EOD fallback" : "") +
          (r.ranOutcomes ? ` · outcomes: ${r.outcomeSummary}` : "")
      );
    } catch (err) {
      console.error(`JACK price refresh (scheduled ${slot.mode}) failed:`, err);
    }
  }
}

// ~1-min interval → runs on each 60s scheduler tick; the ET gate does the rest.
scheduler.register("jack-price-refresh", "JACK Price Refresh (10:00/18:00 ET)", 1 / 60, priceScheduleTick);

export default priceScheduleTick;
