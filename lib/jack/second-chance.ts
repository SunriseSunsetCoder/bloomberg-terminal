// =============================================================================
// JACK "second chance" — recovery re-entry on a MISSED setup. PURE (no DB, no
// network, no Telegram) so the gate is unit-testable.
//
// A setup that FIRED but was never traded, then pulls back to its original entry while
// still live, is a chance to take the trade at the restored original R:R. Backtested
// full-universe (16,184 v2b fires): +0.32R / PF 1.83 overall, and +0.327R / WR 64.4% /
// PF 1.926 at this config (run-up >= 25% toward t05, 10-bar window).
//
// WHY THIS FIRES ON *ARMED*, NOT ON THE RETEST
//
// The alert reads DAILY bars at the 18:00 EOD pass. A "pulled back to entry today"
// trigger therefore lands the evening AFTER the intraday fill it is describing — too
// late to place the resting limit that produces the backtested fill. Useless.
//
// The run-up, by contrast, is a PERSISTENT state: max-high-since-entry only ever
// crosses the 25% threshold once and stays crossed, so it is reliably detectable at
// EOD. So the alert fires the evening a setup becomes ARMED — run-up banked, pullback
// still ahead — and the operator places a resting BUY limit at entry. That limit
// catches the intraday pullback at the entry price, which is the exact backtest fill.
//
// Same trades, same fills, same 0.25 / 10-bar config. Only the alert MOMENT moved,
// from after-the-fact to actionable.
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

/**
 * Run-up required to ARM the setup, as a fraction of the entry→t05 distance. Max-high-
 * since-entry only ever crosses this once and stays crossed, which is exactly why it is
 * safe to detect at EOD (see the header).
 */
export const RUNUP_FRAC = 0.25;

/**
 * How many trading bars after entry the recovery stays valid — doubles as the life of
 * the resting BUY limit the alert asks the operator to place.
 */
export const RETEST_WINDOW_BARS = 10;

export type SecondChanceReason =
  | "eligible"
  | "missing_geometry"
  | "not_fired"
  | "no_entry_bar"
  | "hit_target"
  | "stopped"
  /** Run-up has not reached RUNUP_FRAC toward t05 — nothing to recover yet. */
  | "not_armed"
  /** The pullback already came and went; the resting-limit window has passed. */
  | "already_retested"
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
  /** How far it has run toward t05 since entry, in percent (100% would BE t05). */
  runupPct: number | null;
  /** True once max-high-since-entry has crossed the run-up threshold. */
  armed: boolean;
  fireDate: string | null;
  entryDate: string | null;
  /** The last bar supplied — the evaluation date ("today"). */
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
  armed: false,
  fireDate: null,
  entryDate: null,
  todayDate: null,
  entryIndex: null,
  ...partial,
});

/**
 * Is this missed setup ARMED — run-up banked, pullback still ahead — as of the LAST bar
 * supplied?
 *
 * `bars` must run from at/after the handle low through today, ascending. The final bar
 * is "today".
 *
 * The gate, in order (first failure wins, so the reason code names the FIRST thing that
 * disqualified it):
 *   1. hit_target       — max high since entry reached t05. The trade already worked
 *                         without you; there is nothing left to recover.
 *   2. stopped          — min low since entry touched the stop. The setup is dead.
 *   3. not_armed        — it has not yet run >= runupFrac toward t05, so nothing has
 *                         decayed; it is just a setup sitting near its entry.
 *   4. already_retested — a bar AFTER the entry bar already traded down through entry.
 *                         The pullback has been and gone, so a resting limit placed now
 *                         is chasing an event that already happened. Note this checks
 *                         bars strictly after ei: the entry bar itself opens AT entry,
 *                         so its own low is almost always <= entry and must not count.
 *   5. stale            — the arming came too long after the fire; the sweep showed the
 *                         tightest window carries the best PF.
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
  const armed = reward > 0 && maxHigh >= entry + runupFrac * reward;

  // Did the pullback ALREADY happen? Strictly after the entry bar — the entry bar
  // opens at `entry`, so its low is nearly always <= entry and would disqualify every
  // setup if counted.
  let retestedAlready = false;
  for (let i = entryIndex + 1; i <= todayIdx; i++) {
    if (sorted[i].low <= entry) {
      retestedAlready = true;
      break;
    }
  }

  const base: Partial<SecondChanceResult> = {
    entry,
    stop,
    t05,
    rr: rr != null ? Math.round(rr * 100) / 100 : null,
    barsSinceEntry,
    runupPct: runupPct != null ? Math.round(runupPct * 10) / 10 : null,
    armed,
    fireDate: fire.fireDate,
    entryDate,
    todayDate: today.date,
    entryIndex,
  };

  if (reward <= 0 || risk <= 0) return notEligible("missing_geometry", base);

  // 1 + 2 — still live?
  if (maxHigh >= t05) return notEligible("hit_target", base);
  if (minLow <= stop) return notEligible("stopped", base);

  // 3 — has the run-up been banked yet?
  if (!armed) return notEligible("not_armed", base);

  // 4 — is the pullback still AHEAD of us? (This is the whole point: the operator
  // needs to place the resting limit BEFORE the retest, not learn about it after.)
  if (retestedAlready) return notEligible("already_retested", base);

  // 5 — still inside the window the backtest measured?
  if (barsSinceEntry > windowBars) return notEligible("stale", base);

  return { ...(base as SecondChanceResult), eligible: true, reason: "eligible" };
}
