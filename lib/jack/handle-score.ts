// =============================================================================
// JACK handle_score signal (Cup-with-Handle) — DISPLAY + RANK + LOG-FOR-FORWARD.
//
// This is JACK's one VALIDATED equity edge. Ablation proved the handle carries it
// (PF 1.95 → 1.21 without it); a composite handle_score sorts setups into size
// buckets whose PF is monotonic and OOS-stable. This module is the single source
// of truth for the FROZEN thresholds and the bucket mapping.
//
// IMPORTANT — the edges are FROZEN from the 1,780-trade validated t05 cache. Do
// NOT re-derive them from live data. Only a re-validation `handle_score_freeze`
// re-issues them. Everything here is pure (no DB, no network) → unit-testable and
// safe to import from both the DB layer (init.ts) and the API routes.
// =============================================================================

// Frozen constants from THIS validation (spec §"Frozen constants").
export const HSCORE_EDGES = [0.036, 0.333, 0.456, 0.548, 0.657, 0.89] as const;

export type SizeBucket = "full" | "half" | "skip";

// Quintile → sizing directive. Q5,Q4,Q3 → full · Q1,Q2 → skip.
// Index is the quintile 0..4 (0 = Q1 lowest score, 4 = Q5 highest).
// Q3 promoted half→full 2026-07-20: a 15-year backtest showed Q3 profitable in all
// 16 years (PF 2.24, avg +0.42R, no bear-year weakness). The "half" bucket remains a
// valid directive for CSV-provided / legacy rows; no quintile maps to it now.
export const SIZE_MAP: Record<number, SizeBucket> = {
  4: "full",
  3: "full",
  2: "full",
  1: "skip",
  0: "skip",
};

// The 3 handle features the score is built from — all "lower is better".
export const HANDLE_FEATURES = [
  "days_since_handle_low",
  "handle_dur_days",
  "handle_depth_atr",
] as const;
export type HandleFeature = (typeof HANDLE_FEATURES)[number];

/**
 * numpy searchsorted(..., 'right'): count of elements <= v (equal elements sort to
 * the LEFT of the insertion point). Assumes `sorted` is ascending.
 */
export function searchsortedRight(sorted: readonly number[], v: number): number {
  let i = 0;
  while (i < sorted.length && sorted[i] <= v) i++;
  return i;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map a handle_score (0..1) to its quintile 0..4 against the frozen edges. This is
 * exactly the spec formula: clamp(searchsorted(edges, score, 'right') - 1, 0, 4).
 */
export function quintileForScore(score: number): number {
  return clamp(searchsortedRight(HSCORE_EDGES, score) - 1, 0, 4);
}

/**
 * The headline sizing directive for a handle_score. FULL / HALF / SKIP.
 *
 * Recommendation ONLY — the user decides and sizes. The bucket recommends.
 * Sanity (from the 2026-07-18 run): HOMB 0.452 → skip (just below the 0.456 Q3
 * line), AHR 0.658 → full (just above the 0.657 line).
 */
export function bucketForScore(score: number | null | undefined): SizeBucket | null {
  if (score == null || !Number.isFinite(score)) return null;
  return SIZE_MAP[quintileForScore(score)];
}

/** Normalize an arbitrary stored/CSV bucket string to a known directive, else null. */
export function normalizeSizeBucket(v: string | null | undefined): SizeBucket | null {
  const s = (v ?? "").toLowerCase().trim();
  if (s === "full" || s === "half" || s === "skip") return s;
  return null;
}

// -----------------------------------------------------------------------------
// Unit-mismatch fix (spec "Data-hygiene caveats"): cup_depth_pct / handle_retr_pct
// arrive as FRACTIONS (0.15) on recent_breakout rows but PERCENTS (14.5) on
// just_fired / pending. Normalize to ONE unit (percent) on ingest. In this domain
// a depth/retrace value < 1.0 is unambiguously a fraction (real cup depths cluster
// 10–40%, handle retraces 20–50%), so detect < 1.0 → ×100. Does NOT feed
// handle_score (not an input) but corrupts any depth-based display/gate, so fix it.
// -----------------------------------------------------------------------------
export function normalizeDepthPct(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  if (abs > 0 && abs < 1.0) return v * 100;
  return v;
}

// -----------------------------------------------------------------------------
// Fallback scorer (spec option b): recompute handle_score from the frozen
// historical feature distributions when JACK scores a setup itself (i.e. the
// weekly CSV didn't carry handle_score). Ranks a live feature vs HISTORY, not vs
// the weekly batch. Missing feature → neutral contrib 0.5.
// -----------------------------------------------------------------------------
export interface HandleScoreThresholds {
  // 1,780 historical values per feature, ascending or not (we sort defensively).
  feature_hist: Partial<Record<HandleFeature, number[]>>;
  hscore_edges?: number[];
}

/**
 * Percentile-vs-history composite. For each feature: pct = searchsorted(hist,
 * value, 'right') / len(hist); contrib = 1 - pct (lower feature → higher contrib);
 * handle_score = mean of the 3 contribs. A missing/undefined feature contributes
 * the neutral 0.5. Returns null if the thresholds carry no usable history.
 */
export function computeHandleScore(
  features: Partial<Record<HandleFeature, number | null | undefined>>,
  thresholds: HandleScoreThresholds
): number | null {
  const contribs: number[] = [];
  let anyHistory = false;
  for (const f of HANDLE_FEATURES) {
    const value = features[f];
    const histRaw = thresholds.feature_hist?.[f];
    if (histRaw && histRaw.length > 0) anyHistory = true;
    if (value == null || !Number.isFinite(value) || !histRaw || histRaw.length === 0) {
      contribs.push(0.5); // neutral for a missing feature/history
      continue;
    }
    const hist = [...histRaw].sort((a, b) => a - b);
    const pct = searchsortedRight(hist, value) / hist.length;
    contribs.push(1 - pct);
  }
  if (!anyHistory) return null;
  return contribs.reduce((a, b) => a + b, 0) / contribs.length;
}

// -----------------------------------------------------------------------------
// Concrete position sizing (spec Part C): the user sees the SHARE COUNT + notional
// they would trade at the recommended bucket, computed from Risk/trade and the
// setup's stop distance — then makes the call. Recommendation, not auto-applied.
//   full_shares = risk_per_trade / (entry − stop)   (whole shares, floored)
//   half_shares = full_shares × 0.5
// -----------------------------------------------------------------------------
export interface SizingResult {
  fullShares: number | null;
  fullNotional: number | null;
  halfShares: number | null;
  halfNotional: number | null;
}

export function computeSizing(
  riskPerTrade: number,
  entry: number | null | undefined,
  stop: number | null | undefined
): SizingResult {
  const empty: SizingResult = { fullShares: null, fullNotional: null, halfShares: null, halfNotional: null };
  if (entry == null || stop == null || !Number.isFinite(entry) || !Number.isFinite(stop)) return empty;
  const riskPerShare = entry - stop;
  if (riskPerShare <= 0) return empty; // stop must be below entry for a long setup
  const fullShares = Math.floor(riskPerTrade / riskPerShare);
  const halfShares = Math.floor(fullShares * 0.5);
  return {
    fullShares,
    fullNotional: fullShares * entry,
    halfShares,
    halfNotional: halfShares * entry,
  };
}

/** The recommended-bucket shares/notional for a row (null for SKIP or bad geometry). */
export function recommendedSizing(bucket: SizeBucket | null, sizing: SizingResult): {
  shares: number | null;
  notional: number | null;
} {
  if (bucket === "full") return { shares: sizing.fullShares, notional: sizing.fullNotional };
  if (bucket === "half") return { shares: sizing.halfShares, notional: sizing.halfNotional };
  return { shares: null, notional: null };
}

// -----------------------------------------------------------------------------
// Auditable reference payload — stored as a validation_runs reference row so the
// exact thresholds behind any sizing decision can be queried from the DB alone.
// This is the DB-persisted mirror of the frozen constants above.
// -----------------------------------------------------------------------------
export const HANDLE_SCORE_REFERENCE_KIND = "hscore_edges";

export interface HandleScoreReference {
  version: string;
  frozen: true;
  source: string;
  hscore_edges: number[];
  size_map: { Q5: SizeBucket; Q4: SizeBucket; Q3: SizeBucket; Q2: SizeBucket; Q1: SizeBucket };
  features: HandleFeature[];
  note: string;
}

export function handleScoreReference(): HandleScoreReference {
  return {
    version: "1.0",
    frozen: true,
    source: "1,780-trade validated t05 cache (PF 1.933 ≈ validated 1.91)",
    hscore_edges: [...HSCORE_EDGES],
    size_map: { Q5: "full", Q4: "full", Q3: "full", Q2: "skip", Q1: "skip" },
    features: [...HANDLE_FEATURES],
    note: "Edges FROZEN from the validated cache — re-issued only by handle_score_freeze on re-validation. Do NOT re-derive from live data.",
  };
}

export function handleScoreReferenceJson(): string {
  return JSON.stringify(handleScoreReference());
}
