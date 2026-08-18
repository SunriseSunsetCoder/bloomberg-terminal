// =============================================================================
// FILL SANITY GUARD — "check the decimal" (PURE: no React, no DB, no network)
//
// Why this exists: a UMBF fill was logged as 15.00 against a ~150 setup — a dropped
// decimal / missing digit. Nothing rejected it, so the position carried a 10×-wrong
// cost basis into unrealized %, the rules flag, and user_R_realized for weeks.
//
// The guard compares an entered fill against two independent references:
//   1. SETUP GEOMETRY — entry (the planned fill), else the breakout rim, else the
//      stop/target midpoint. A real fill sits near the level you planned to trade;
//      more than GEOMETRY_TOL away is a typo until proven otherwise.
//   2. LATEST CLOSE — the price the terminal last saw. More than CLOSE_TOL away
//      implies a same-day move no liquid name makes.
//
// It is a CONFIRMATION gate, not a hard block: the trader can still be right (a gap,
// a wide stop, a deliberate correction). Callers must surface `reason` and require an
// explicit second action before writing. Strategy logic is untouched — this never
// changes a level, a size, or a verdict.
// =============================================================================

/** Fraction away from the setup's own geometry that trips the guard. */
export const FILL_GUARD_GEOMETRY_TOL = 0.4; // 40%
/** Fraction away from the latest close that trips the guard (implied same-day move). */
export const FILL_GUARD_CLOSE_TOL = 0.5; // 50%

export interface FillGuardSetup {
  /** Planned entry — the primary reference. */
  entry?: number | null;
  /** Breakout rim — reference when there is no entry. */
  breakout?: number | null;
  stop?: number | null;
  target?: number | null;
  /** Latest close the terminal has (NOW price), if any. */
  currentPrice?: number | null;
}

export interface FillGuardVerdict {
  /** false → the caller must ask for confirmation before writing. */
  ok: boolean;
  /** Human message for the UI / CLI. null when ok. */
  reason: string | null;
  /** What the fill was measured against, and how far off it was. */
  refPrice: number | null;
  deviationPct: number | null;
  /** 10 / 100 / 0.1 / 0.01 when the fill looks like a clean decimal shift. */
  decimalFactor: number | null;
}

const OK: FillGuardVerdict = { ok: true, reason: null, refPrice: null, deviationPct: null, decimalFactor: null };

/**
 * The reference the fill is judged against: the planned entry, else the breakout rim,
 * else the stop/target midpoint. Null when the setup carries no usable geometry (older
 * CSVs) — the guard then falls back to the latest close alone, and passes if there is
 * neither.
 */
export function geometryReference(s: FillGuardSetup): number | null {
  if (s.entry != null && s.entry > 0) return s.entry;
  if (s.breakout != null && s.breakout > 0) return s.breakout;
  if (s.stop != null && s.stop > 0 && s.target != null && s.target > 0) return (s.stop + s.target) / 2;
  return null;
}

/** A clean ×10 / ×100 / ÷10 / ÷100 slip (within 5%) — the classic dropped decimal. */
function decimalSlip(price: number, ref: number): number | null {
  if (ref <= 0 || price <= 0) return null;
  const ratio = price / ref;
  for (const f of [100, 10, 0.1, 0.01]) {
    if (Math.abs(ratio - f) / f <= 0.05) return f;
  }
  return null;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Judge ONE fill price against the setup. Returns ok:true when the price is plausible
 * (or when there is nothing to compare it to). A non-ok verdict is a "check the
 * decimal" warning the caller must have confirmed before it writes.
 */
export function checkFillPrice(
  kind: "entry" | "exit",
  price: number | null | undefined,
  setup: FillGuardSetup
): FillGuardVerdict {
  if (price == null || !Number.isFinite(price)) return OK;
  if (price <= 0) {
    return { ok: false, reason: `${kind} fill ${usd(price)} is not a positive price.`, refPrice: null, deviationPct: null, decimalFactor: null };
  }

  const ref = geometryReference(setup);
  if (ref != null) {
    const dev = Math.abs(price - ref) / ref;
    if (dev > FILL_GUARD_GEOMETRY_TOL) {
      const factor = decimalSlip(price, ref);
      const slip = factor != null ? ` That is a clean ${factor >= 1 ? `${factor}×` : `1/${Math.round(1 / factor)}`} of the setup — check the decimal.` : "";
      return {
        ok: false,
        reason:
          `${kind === "entry" ? "Entry" : "Exit"} fill ${usd(price)} is ${pct(dev)} away from this setup's ` +
          `${setup.entry != null ? "entry" : setup.breakout != null ? "rim" : "level"} ${usd(ref)} ` +
          `(guard: ${pct(FILL_GUARD_GEOMETRY_TOL)}).${slip}`,
        refPrice: ref,
        deviationPct: dev,
        decimalFactor: factor,
      };
    }
  }

  const close = setup.currentPrice;
  if (close != null && close > 0) {
    const dev = Math.abs(price - close) / close;
    if (dev > FILL_GUARD_CLOSE_TOL) {
      const factor = decimalSlip(price, close);
      const slip = factor != null ? ` That is a clean ${factor >= 1 ? `${factor}×` : `1/${Math.round(1 / factor)}`} of the last close — check the decimal.` : "";
      return {
        ok: false,
        reason:
          `${kind === "entry" ? "Entry" : "Exit"} fill ${usd(price)} implies a ${pct(dev)} move vs the last close ` +
          `${usd(close)} (guard: ${pct(FILL_GUARD_CLOSE_TOL)}).${slip}`,
        refPrice: close,
        deviationPct: dev,
        decimalFactor: factor,
      };
    }
  }

  return OK;
}

/**
 * Judge a whole fill submission (entry + exit). Returns the FIRST failing verdict so
 * the UI shows one clear message; ok when both sides pass.
 */
export function checkFills(
  fills: { entry?: number | null; exit?: number | null },
  setup: FillGuardSetup
): FillGuardVerdict {
  const e = checkFillPrice("entry", fills.entry, setup);
  if (!e.ok) return e;
  return checkFillPrice("exit", fills.exit, setup);
}
