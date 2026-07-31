// =============================================================================
// JACK backtest reference — FROZEN. The single source of truth for the numbers the
// live scorecard is measured against. Pure constants (no DB, no network).
//
// BASIS (read this before comparing anything):
//   · Source        : trades_t05_15yr.csv, the canonical validated t05 trade cache.
//   · Population    : Q3-Q5 TRADED setups (7,605 trades) — NOT the whole universe.
//     That matters: the scorecard's live arm is Q3-Q5 traded, so a whole-universe
//     win rate (the 63%/66% figures floating around) is the wrong bar.
//   · Metric        : RAW R — the same (exit - entry) / (entry - stop) the scorecard
//     computes on live realized R. Directly comparable.
//
// METHODOLOGY WARNING — the headline "PF 2.09 IS / 1.70 OOS" everyone quotes is a
// DIFFERENT computation: a capacity-simulated, dollar-based PF. It is NOT the raw-R
// PF (~2.90) and the two must never be compared to each other. Live realized R is
// compared against RAW_R_REFERENCE; CAPACITY_SIM_PF is displayed only as the labeled
// official strategy headline. The UI states this distinction on screen — do not
// collapse the two.
//
// These values SUPERSEDE the scattered per-quintile literals in lib/jack/analytics.ts
// and the Q3 numbers in the handle-score.ts comment: those are different, mutually
// inconsistent computations kept for the Session C record. Do not merge them.
// =============================================================================

export const REFERENCE_BASIS =
  "raw-R, Q3-5 traded, trades_t05_15yr.csv (7,605 trades)";

export interface RefStat {
  /** Win rate as a fraction 0..1. */
  winRate: number;
  avgR: number;
  pf: number;
}

export interface RawRReference {
  basis: string;
  /** Full-sample Q3-5 traded. */
  overall: RefStat;
  /** In-sample split. */
  is: RefStat;
  /** Out-of-sample split — the conservative bar. */
  oos: RefStat;
  /** Per-tier, OOS (the conservative bar), keyed by scanner tier. */
  byTier: Record<"Q3" | "Q4" | "Q5", RefStat>;
}

export const RAW_R_REFERENCE: RawRReference = {
  basis: REFERENCE_BASIS,
  overall: { winRate: 0.7, avgR: 0.56, pf: 2.9 },
  is: { winRate: 0.7, avgR: 0.59, pf: 3.0 },
  oos: { winRate: 0.7, avgR: 0.51, pf: 2.76 },
  byTier: {
    Q3: { winRate: 0.64, avgR: 0.33, pf: 1.93 },
    Q4: { winRate: 0.69, avgR: 0.47, pf: 2.54 },
    Q5: { winRate: 0.78, avgR: 0.75, pf: 4.54 },
  },
};

/**
 * The official strategy headline PF — CAPACITY-SIMULATED, DOLLAR-BASED. Displayed
 * for the record, never compared against live realized R (see the warning above).
 */
export const CAPACITY_SIM_PF = {
  is: 2.09,
  oos: 1.7,
  label: "official strategy PF (capacity sim, $-based)",
  note: "Different computation from raw-R PF — not comparable to the live realized-R numbers on this page.",
} as const;

export const TIER_ORDER = ["Q3", "Q4", "Q5"] as const;
export type Tier = (typeof TIER_ORDER)[number];

/** Normalize a stored tier string ("q5", " Q5 ") to a known tier, else null. */
export function normalizeTier(v: string | null | undefined): Tier | null {
  const t = (v ?? "").toUpperCase().trim();
  return t === "Q3" || t === "Q4" || t === "Q5" ? t : null;
}
