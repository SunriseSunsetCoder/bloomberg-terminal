/**
 * JACK outcome tracker entry point — runs the SAME replay as the "UPDATE OUTCOMES"
 * button.
 *
 * NO LONGER SELF-REGISTERS with the in-Next scheduler (removed 2026-08-25 — see the
 * note at the bottom of this file). The nightly replay is now an explicit stage in
 * pipeline/run_daily.py, which POSTs /api/jack-outcomes. This module remains the
 * shared implementation for that route and for any direct caller.
 *
 * VPS-only: a no-op when persistence is off, and inherently a no-op for setups that
 * are not yet resolvable (they defer). The manual button is unchanged.
 */
// Side-effect import KEPT: other routes rely on pulling this module to register the
// market-data task. It no longer has anything to do with ordering here, since this
// module registers nothing of its own.
import "@/lib/market-data-refresh";
import { isPersistenceAvailable } from "@/lib/db/env";
import { runOutcomeTracker, DEFAULT_RESOLUTION_DAYS } from "@/lib/jack/outcome-tracker";

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

// SCHEDULER REGISTRATION REMOVED 2026-08-25 — the outcome replay is now an explicit
// stage in pipeline/run_daily.py (POST /api/jack-outcomes, stage 5/5).
//
// Why it had to go rather than stay as a backstop: this registration was a SIDE
// EFFECT of an HTTP route being imported (init-scheduler / market-data). Next loads
// route modules lazily, so a freshly restarted server that nobody had poked had no
// outcome task registered at all — the scheduler ticked over an empty list and
// outcomes silently never accrued. A restart disarmed it invisibly, which is exactly
// how JANLY ended up starved.
//
// Keeping both would also mean two writers racing the same table and duplicated
// Tiingo fetches on any night both fired. One source of truth instead.
//
// refreshOutcomes stays exported: the manual UPDATE OUTCOMES button and any direct
// caller are unchanged, and re-registering is a one-line revert if ever wanted.

export default refreshOutcomes;
