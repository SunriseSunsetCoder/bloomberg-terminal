// =============================================================================
// JACK pending → LIVE promotion — THE single predicate. PURE (no DB, no network,
// no Redis, no Telegram) so it is unit-testable against real bars.
//
// WHY THIS EXISTS
//
// "This setup became tradeable" was being decided in two places with two different
// rules: the board writer rode detectFire (strict CLOSE > rim, inside the 15-bar
// confirm window), while the promotion ALERT rode `close >= entry` with no window at
// all. The looser rule is what let a sub-rim close announce a breakout, and the split
// is what let TTE alert while the board stayed pending. One predicate, two consumers,
// no room for them to disagree.
//
// THE RULE (locked):
//   promoted  ⟺  strict CLOSE > breakout_level, within CONFIRM_WINDOW_BARS (15) bars
//                of the handle low, on a TRADEABLE setup with a rim.
//
// Strict `>`, not `>=`: `jack-state.md` — "the first bar with a CLOSE **strictly**
// above the rim" — and the 2026-07-31 replay-parity fix. The comparison itself is NOT
// reimplemented here; it delegates to the SAME detectFire the paper replay and the
// entry alert use, which is what structurally prevents a third dialect of "fired".
//
// FAIL CLOSED. A missing rim is never substituted with `entry` (or anything else): the
// ~36 rimless setups cannot be window-validated at all, so they are never promoted,
// only counted. A stale fire whose setup no longer clears its CURRENT rim is likewise
// not promoted — callers re-derive against current geometry every run.
// =============================================================================

import { detectFire, findTouchExit, type Bar } from "@/lib/jack/outcome-tracker";
// The frozen SIZE_MAP: Q1/Q2 are never entered, so they are never promoted either.
import { isTradeableSetup } from "@/lib/jack/handle-score";

export type PromotionReason =
  | "promoted"
  /** No rim on the setup — cannot window-validate. NEVER falls back to entry. */
  | "no_rim"
  /** Q1/Q2 or an explicit skip bucket: never traded, so never promoted. */
  | "not_tradeable"
  | "no_bars"
  /** The confirm window elapsed with no close above the rim. Done. */
  | "not_fired"
  /** Window hasn't fully elapsed yet — may still fire on a later bar. */
  | "deferred"
  /** Fired, but the trade has already hit its stop or target. Not a live idea. */
  | "resolved";

/** The geometry the predicate needs. `breakout` is the rim (setups.breakout_level). */
export interface PromotionSetup {
  handleLowDate: string;
  breakout: number | null;
  stop?: number | null;
  target?: number | null;
  sizeBucket?: string | null;
  tier?: string | null;
}

export interface PromotionResult {
  /** True ⟹ the setup belongs in the LIVE display group right now. */
  promoted: boolean;
  reason: PromotionReason;
  /** The board's display status. Null unless a fire was detected. */
  firedStatus: "confirmed" | "late" | "resolved" | null;
  fireDate: string | null;
  fireClose: number | null;
  /** 1-based bar index within the confirm window. */
  fireBar: number | null;
}

const notPromoted = (reason: PromotionReason, over: Partial<PromotionResult> = {}): PromotionResult => ({
  promoted: false,
  reason,
  firedStatus: null,
  fireDate: null,
  fireClose: null,
  fireBar: null,
  ...over,
});

/**
 * Is this pending setup promoted to LIVE as of `etDate`, given its daily bars?
 *
 * `bars` must run from at/after the handle low through today (what fetchDailyBars
 * returns when passed handle_low_date). Order is irrelevant — detectFire sorts.
 *
 * A fire dated before today is `late` rather than `confirmed` — the same distinction
 * the entry alert draws — and a late fire whose trade has ALREADY resolved (stop or
 * target touched from the fill bar) is NOT promoted: it is history, not a live idea,
 * and `isFiredActionable` excludes 'resolved' for exactly that reason.
 */
export function isPromotedToLive(setup: PromotionSetup, bars: Bar[], etDate: string): PromotionResult {
  // 1. Rim required. FAIL CLOSED — never substitute entry.
  if (setup.breakout == null) return notPromoted("no_rim");

  // 2. Quintile gate (frozen SIZE_MAP). Also enforced downstream by
  //    isInLiveDisplayGroup / isBasketEligible — double-gated on purpose.
  if (!isTradeableSetup(setup)) return notPromoted("not_tradeable");

  if (bars.length === 0) return notPromoted("no_bars");

  // 3. THE comparison — delegated, never reimplemented. Strict close > rim, inside
  //    the 15-bar window anchored on the first bar dated after the handle low.
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const fire = detectFire(sorted, setup.handleLowDate, setup.breakout);
  if (fire.status !== "fired") {
    return notPromoted(fire.status === "deferred" ? "deferred" : "not_fired");
  }

  const fireDate = fire.fireDate as string;
  const fireClose = fire.fireClose as number;
  const fireBar = fire.fireBarIndex as number;
  const late = fireDate < etDate;

  // 4. Already played out? Only a LATE fire can have: a same-day fire's fill is the
  //    next session's open, which hasn't happened yet.
  if (late && setup.stop != null && setup.target != null) {
    const fillIdx = (fire.fireIndex as number) + 1;
    if (fillIdx < sorted.length) {
      const exit = findTouchExit(sorted, fillIdx, setup.stop, setup.target);
      if (exit) {
        return notPromoted("resolved", { firedStatus: "resolved", fireDate, fireClose, fireBar });
      }
    }
  }

  return {
    promoted: true,
    reason: "promoted",
    firedStatus: late ? "late" : "confirmed",
    fireDate,
    fireClose,
    fireBar,
  };
}
