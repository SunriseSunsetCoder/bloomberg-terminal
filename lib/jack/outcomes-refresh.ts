/**
 * Scheduled JACK outcome tracker — runs the SAME replay as the "UPDATE OUTCOMES"
 * button once every 24h, so the theoretical outcome/analytics accrue without a
 * manual click.
 *
 * Registered AFTER the market-data refresh purely for LOAD-SPREADING: the
 * scheduler runs due tasks sequentially in registration order within one 60s tick,
 * so the two heavy jobs don't collide. (They hit DIFFERENT sources — market-data
 * is Alpha Vantage → Redis; this replay fetches Tiingo EOD per-ticker on demand —
 * so this is ordering, not a freshness dependency.)
 *
 * VPS-only: a no-op when persistence is off, and inherently a no-op for setups
 * younger than the resolution age gate (they defer). The manual button is unchanged.
 */
// Side-effect import FIRST so the market-data task always registers before this one,
// regardless of which route pulls this module in (guarantees the load-spread order).
import "@/lib/market-data-refresh";
import scheduler from "@/lib/scheduler";
import { isPersistenceAvailable } from "@/lib/db/env";
import { runOutcomeTracker, DEFAULT_RESOLUTION_DAYS } from "@/app/api/jack-outcomes/route";

// Import the button's window so job == button by construction (≥130 → covers the
// 120-day time stop). One source of truth, no drift.

// The scheduled job has no HTTP request, so it can't derive the internal Tiingo
// proxy base from req headers — read it from env (VPS-configured), default local.
function selfTiingoBase(): string {
  const base = process.env.JACK_SELF_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
  return `${base}/api/tiingo`;
}

export async function refreshOutcomes(): Promise<void> {
  if (!isPersistenceAvailable()) {
    console.log("JACK outcome tracker skipped — persistence off (VPS-only).");
    return;
  }
  try {
    const summary = await runOutcomeTracker({
      resolutionDays: DEFAULT_RESOLUTION_DAYS,
      tiingoBase: selfTiingoBase(),
    });
    console.log(`JACK outcome tracker (scheduled): ${summary.message}`);
  } catch (err) {
    console.error("JACK outcome tracker (scheduled) failed:", err);
    throw err; // let the scheduler log it too; lastRun already advanced
  }
}

// Register SECOND (after market-data-refresh, imported above) → load-spread order.
scheduler.register("jack-outcomes-refresh", "JACK Outcome Tracker", 24, refreshOutcomes);

export default refreshOutcomes;
