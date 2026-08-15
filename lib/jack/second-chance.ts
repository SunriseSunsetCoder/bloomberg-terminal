// =============================================================================
// JACK "second chance" — recovery re-entry on a MISSED setup. PURE (no DB, no
// network, no Telegram) so the gate is unit-testable.
//
// A setup that FIRED but was never traded, then pulled back to its original entry
// while still live, is a chance to take the trade at the restored original R:R.
// Backtested full-universe (16,184 v2b fires): +0.32R / PF 1.83 overall, and
// +0.327R / WR 64.4% / PF 1.926 at the gate below (run-up >= 25% toward t05, 10-bar
// window).
//
// THIS IS A RECOVERY SIGNAL, NOT THE PRIMARY ENTRY. Waiting for a pullback as a
// replacement for the normal EOD entry is WORSE — it sheds the ~12% of setups that
// run straight to target and never look back. The message says so, and so does this
// comment, because the distinction is the whole point.
//
// Every price primitive is the SHARED one from outcome-tracker.ts (detectFire for the
// fire bar, the same next-open fill the entry alert uses). Nothing here re-derives the
// fire rule — that is what kept the paper arm and the alerts in agreement, and it has
// to keep holding here too.
// =============================================================================

import { detectFire, type Bar } from "@/lib/jack/outcome-tracker";

// ---- Tunable gate constants (named exports — one place to tune) -------------

/** Run-up required before the retest counts, as a fraction of the entry→t05 distance. */
export const RUNUP_FRAC = 0.25;

/** How many trading bars after entry the retest may still be considered fresh. */
export const RETEST_WINDOW_BARS = 10;

export type SecondChanceReason =
  | "eligible"
  | "missing_geometry"
  | "not_fired"
  | "no_entry_bar"
  | "hit_target"
  | "stopped"
  | "no_runup"
  | "no_retest"
  | "stale";

/** The geometry the gate needs. `target` IS the t05 target (setups.t05_target). */
export interface SecondChanceSetup {
  handleLowDate: string;
  breakout: number | null;
  stop: number | null;
  /**
   * t05 — the strategy's target (breakout + 0.5x cup depth), stored as
   * setups.t05_target. There is NO separate "full target" column in this schema, so
   * this value is used as t05 directly. Halving it again would move the target to a
   * quarter of the cup depth and silently mis-state every R:R below.
   */
  target: number | null;
}

export interface SecondChanceResult {
  eligible: boolean;
  reason: SecondChanceReason;
  /** The confirmed fill: next bar's OPEN after the confirming close. */
  entry: number | null;
  stop: number | null;
  t05: number | null;
  /** (t05 - entry) / (entry - stop) — the ORIGINAL R:R, restored by the pullback. */
  rr: number | null;
  /** Trading bars from the entry bar to today. */
  barsSinceEntry: number | null;
  /** How far it ran toward t05 before retesting, in percent (100% would BE t05). */
  runupPct: number | null;
  fireDate: string | null;
  entryDate: string | null;
  /** The bar the retest happened on — the last bar supplied. */
  todayDate: string | null;
  /** Index of the entry bar in the date-sorted bars, for callers that need to re-scan. */
  entryIndex: number | null;
}

export interface SecondChanceOptions {
  runupFrac?: number;
  windowBars?: number;
}

const notEligible = (reason: SecondChanceReason, partial: Partial<SecondChanceResult> = {}): SecondChanceResult => ({
  eligible: false,
  reason,
  entry: null,
  stop: null,
  t05: null,
  rr: null,
  barsSinceEntry: null,
  runupPct: null,
  fireDate: null,
  entryDate: null,
  todayDate: null,
  entryIndex: null,
  ...partial,
});

/**
 * Is this missed setup offering a recovery re-entry as of the LAST bar supplied?
 *
 * `bars` must run from at/after the handle low through today, ascending. The final bar
 * is "today" — the retest bar.
 *
 * The gate, in order (first failure wins, so the reason code is the FIRST thing that
 * disqualified it):
 *   1. hit_target — max high since entry reached t05. Opportunity gone; the trade
 *      already worked without you.
 *   2. stopped    — min low since entry touched the stop. The setup is dead.
 *   3. no_runup   — it never ran >= runupFrac toward t05, so nothing decayed and there
 *      is nothing to recover; it is just a setup sitting at its entry.
 *   4. no_retest  — today's low never reached entry, so a limit at entry would not fill.
 *   5. stale      — the retest came too long after the fire; the sweep showed the
 *      tightest window carries the best PF.
 */
export function evalSecondChance(
  setup: SecondChanceSetup,
  bars: Bar[],
  opts: SecondChanceOptions = {}
): SecondChanceResult {
  const runupFrac = opts.runupFrac ?? RUNUP_FRAC;
  const windowBars = opts.windowBars ?? RETEST_WINDOW_BARS;

  const { breakout, stop, target: t05 } = setup;
  if (breakout == null || stop == null || t05 == null) return notEligible("missing_geometry");
  if (bars.length === 0) return notEligible("not_fired");

  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));

  // SHARED fire rule — same function the paper replay and the entry alert use. The
  // fire is detected from the bars, never from a fired_at column: a validated-LIVE
  // setup never gets that column stamped, and gating on it would silently exclude the
  // majority of the board.
  const fire = detectFire(sorted, setup.handleLowDate, breakout);
  if (fire.status !== "fired") return notEligible("not_fired");

  // Entry = the NEXT bar's open after the confirming close — the exact derivation the
  // entry alert and replaySetup use, so the two can never quote different fills.
  const entryIndex = (fire.fireIndex as number) + 1;
  if (entryIndex >= sorted.length) return notEligible("no_entry_bar", { fireDate: fire.fireDate });
  const entry = sorted[entryIndex].open;
  const entryDate = sorted[entryIndex].date;

  const todayIdx = sorted.length - 1;
  const today = sorted[todayIdx];
  const barsSinceEntry = todayIdx - entryIndex;

  const risk = entry - stop;
  const reward = t05 - entry;
  const rr = risk > 0 ? reward / risk : null;

  // Scan from the entry bar through today inclusive. The entry bar itself can carry
  // the run-up, and today can be an outside day that both runs up and retests.
  let maxHigh = Number.NEGATIVE_INFINITY;
  let minLow = Number.POSITIVE_INFINITY;
  for (let i = entryIndex; i <= todayIdx; i++) {
    if (sorted[i].high > maxHigh) maxHigh = sorted[i].high;
    if (sorted[i].low < minLow) minLow = sorted[i].low;
  }

  const runupPct = reward > 0 ? ((maxHigh - entry) / reward) * 100 : null;
  const base: Partial<SecondChanceResult> = {
    entry,
    stop,
    t05,
    rr: rr != null ? Math.round(rr * 100) / 100 : null,
    barsSinceEntry,
    runupPct: runupPct != null ? Math.round(runupPct * 10) / 10 : null,
    fireDate: fire.fireDate,
    entryDate,
    todayDate: today.date,
    entryIndex,
  };

  if (reward <= 0 || risk <= 0) return notEligible("missing_geometry", base);

  // 1 + 2 — still live?
  if (maxHigh >= t05) return notEligible("hit_target", base);
  if (minLow <= stop) return notEligible("stopped", base);

  // 3 — did it run up before coming back?
  if (maxHigh < entry + runupFrac * reward) return notEligible("no_runup", base);

  // 4 — did a limit at the original entry fill TODAY?
  if (today.low > entry) return notEligible("no_retest", base);

  // 5 — is the retest still fresh?
  if (barsSinceEntry > windowBars) return notEligible("stale", base);

  return { ...(base as SecondChanceResult), eligible: true, reason: "eligible" };
}
