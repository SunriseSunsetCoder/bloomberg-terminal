// =============================================================================
// JACK Performance Scorecard — PURE computation (no DB, no React → unit-testable).
//
// Answers two questions and nothing else:
//   (A) LIVE REALIZED — is the realized edge on trades actually taken tracking the
//       validated backtest? Equity curve + WR / avg R / PF / expectancy / drawdown,
//       each beside the frozen reference, cut by tier and by P-rank.
//   (B) AI OVERLAY  — are the AI's SKIP / SIZE-DOWN calls adding value or deleting
//       good trades? Compares the PAPER outcome (the theoretical replay that already
//       runs for every resolvable setup, traded or not) across what the AI called.
//
// Read-only analytics. Nothing here feeds strategy, sizing, selection, alerts, or a
// validation run.
//
// TWO METRICS, NEVER MIXED (see backtest-reference.ts): live realized R is compared
// against the RAW-R reference (PF ~2.90 on Q3-5 traded). The famous "PF 2.09 IS /
// 1.70 OOS" is a capacity-simulated dollar PF — carried for display only, never as
// the comparison bar.
//
// Metric math (computeStat) and the n>=30 threshold are REUSED from lib/jack/
// analytics.ts — one definition of win rate / avg R / PF across both views.
// =============================================================================

import type { ScorecardRow } from "@/lib/db/analytics";
import { computeStat, LOW_SAMPLE_THRESHOLD, type RStat } from "@/lib/jack/analytics";
import {
  CAPACITY_SIM_PF,
  RAW_R_REFERENCE,
  TIER_ORDER,
  normalizeTier,
  type RefStat,
  type Tier,
} from "@/lib/jack/backtest-reference";
import { analysisDirection, handleDirection, signalsDisagree } from "@/lib/jack/verdict";
import { normalizeSizeBucket } from "@/lib/jack/handle-score";

export { LOW_SAMPLE_THRESHOLD };

const RESOLVED_REASONS = new Set(["target", "stop", "timeout"]);

/** Resolved = the replay reached a real exit and produced an R. */
export function isResolvedRow(r: { exitReason: string | null; rRealized: number | null }): boolean {
  return r.exitReason != null && RESOLVED_REASONS.has(r.exitReason) && r.rRealized != null;
}
export function isNeverFiredRow(r: { exitReason: string | null }): boolean {
  return r.exitReason === "never_fired";
}
/**
 * OWNED: marked TRADED with no recorded exit — the same rule the board uses
 * (isOwnedPosition / getOpenPositions). Deliberately independent of the replay: a
 * position you still hold is open even if the SETUP's theoretical window resolved
 * months ago (a runner held past the window). Such a row is excluded from the
 * realized arm — it has no realized R yet — while its PAPER outcome still counts in
 * the (B) overlay analysis, which is about the AI's call on the setup, not about
 * what you did with it.
 */
export function isOpenRow(r: ScorecardRow): boolean {
  return r.userAction === "TRADED" && r.userExitPrice == null;
}
/** A closed live trade: user fills logged end-to-end, so a realized R exists. */
export function isRealizedTrade(r: ScorecardRow): boolean {
  return r.userAction === "TRADED" && r.userRRealized != null && r.userExitPrice != null;
}

// ============================================================
// (A) LIVE REALIZED
// ============================================================

export interface EquityPoint {
  seq: number;
  date: string; // exit date (or best available)
  ticker: string;
  r: number;
  cumR: number;
  cumUsd: number;
  /** Distance below the running peak, in R (<= 0). */
  drawdownR: number;
}

export interface TierCut {
  key: Tier | "unclassified";
  stat: RStat;
  reference: RefStat | null; // OOS per-tier bar; null for unclassified
}

export interface PRankCut {
  key: "P1" | "P2" | "P3" | "P4+" | "unranked";
  stat: RStat;
}

export interface LiveArm {
  /** Realized R on closed live trades — the headline. */
  realized: RStat;
  /** The SAME trades scored on the setup's theoretical R (setup quality vs execution). */
  theoretical: RStat;
  totalR: number;
  totalUsd: number;
  /** Expectancy per trade in R (== realized.avgR, named for the display) and in $. */
  expectancyR: number | null;
  expectancyUsd: number | null;
  maxDrawdownR: number; // positive magnitude
  currentDrawdownR: number; // positive magnitude
  curve: EquityPoint[];
  byTier: TierCut[];
  byPRank: PRankCut[];
  openCount: number;
  riskPerTrade: number;
}

function drawdowns(curve: EquityPoint[]): { max: number; current: number } {
  if (curve.length === 0) return { max: 0, current: 0 };
  const worst = Math.min(...curve.map((p) => p.drawdownR));
  return { max: Math.abs(worst), current: Math.abs(curve[curve.length - 1].drawdownR) };
}

function buildCurve(rows: ScorecardRow[], riskPerTrade: number): EquityPoint[] {
  const ordered = [...rows].sort((a, b) => {
    const da = a.userExitDate ?? a.userEntryDate ?? a.handleLowDate;
    const db = b.userExitDate ?? b.userEntryDate ?? b.handleLowDate;
    return da.localeCompare(db) || a.ticker.localeCompare(b.ticker);
  });

  let cumR = 0;
  let peak = 0;
  return ordered.map((r, i) => {
    const rr = r.userRRealized as number;
    cumR += rr;
    if (cumR > peak) peak = cumR;
    return {
      seq: i + 1,
      date: r.userExitDate ?? r.userEntryDate ?? r.handleLowDate,
      ticker: r.ticker,
      r: rr,
      cumR,
      cumUsd: cumR * riskPerTrade,
      drawdownR: cumR - peak,
    };
  });
}

function pRankKey(rank: number | undefined): PRankCut["key"] {
  if (rank == null) return "unranked";
  if (rank === 1) return "P1";
  if (rank === 2) return "P2";
  if (rank === 3) return "P3";
  return "P4+";
}

function computeLiveArm(
  rows: ScorecardRow[],
  ranks: Map<number, number>,
  riskPerTrade: number
): LiveArm {
  const realizedRows = rows.filter(isRealizedTrade);
  const realized = computeStat(realizedRows.map((r) => r.userRRealized as number));
  // Same trades, theoretical R — only those the replay also resolved.
  const theoretical = computeStat(
    realizedRows.filter(isResolvedRow).map((r) => r.rRealized as number)
  );

  const curve = buildCurve(realizedRows, riskPerTrade);
  const dd = drawdowns(curve);
  const totalR = curve.length ? curve[curve.length - 1].cumR : 0;

  const byTier: TierCut[] = [
    ...TIER_ORDER.map((t) => ({
      key: t as Tier | "unclassified",
      stat: computeStat(
        realizedRows.filter((r) => normalizeTier(r.tier) === t).map((r) => r.userRRealized as number)
      ),
      reference: RAW_R_REFERENCE.byTier[t] as RefStat | null,
    })),
    {
      key: "unclassified" as const,
      stat: computeStat(
        realizedRows.filter((r) => normalizeTier(r.tier) == null).map((r) => r.userRRealized as number)
      ),
      reference: null,
    },
  ];

  const rankKeys: PRankCut["key"][] = ["P1", "P2", "P3", "P4+", "unranked"];
  const byPRank: PRankCut[] = rankKeys.map((key) => ({
    key,
    stat: computeStat(
      realizedRows
        .filter((r) => pRankKey(ranks.get(r.setupId)) === key)
        .map((r) => r.userRRealized as number)
    ),
  }));

  return {
    realized,
    theoretical,
    totalR,
    totalUsd: totalR * riskPerTrade,
    expectancyR: realized.avgR,
    expectancyUsd: realized.avgR == null ? null : realized.avgR * riskPerTrade,
    maxDrawdownR: dd.max,
    currentDrawdownR: dd.current,
    curve,
    byTier,
    byPRank,
    openCount: rows.filter(isOpenRow).length,
    riskPerTrade,
  };
}

// ============================================================
// (B) AI OVERLAY — paper outcomes grouped by what the AI called
// ============================================================

export type AiBucketKey = "TRADE-full" | "SIZE-DOWN" | "SKIP" | "other";

export interface AiBucket {
  key: AiBucketKey | string;
  stat: RStat; // on theoretical (paper) R over RESOLVED setups
  neverFired: number; // counted, deliberately excluded from the R stats
}

export interface DisagreeCut {
  flagged: RStat; // signalsDisagree === true
  agreed: RStat; // signalsDisagree === false (both signals present)
  tradeVsHandleSkip: RStat; // AI says TRADE, handle says SKIP
  skipVsHandleFull: RStat; // AI says SKIP, handle says FULL
}

export interface AiArm {
  /** LIVE-section calls — the actionable verdicts. The headline comparison. */
  buckets: AiBucket[];
  /** PENDING-section calls (WATCH etc.) — informational, not trade verdicts. */
  pendingBuckets: AiBucket[];
  disagree: DisagreeCut;
  /** Plain-language read; null when gated by sample size. */
  read: string | null;
  readSuppressed: boolean;
  /** Buckets under the threshold, so the UI can name them in the gate notice. */
  insufficient: string[];
}

/** Map an AI decision string to its overlay bucket, reusing the display rules. */
export function aiBucketFor(decision: string | null): AiBucketKey {
  const dir = analysisDirection(decision);
  if (dir === "pos") return "TRADE-full";
  if (dir === "caution") return "SIZE-DOWN";
  if (dir === "neg") return "SKIP";
  return "other"; // WATCH / ALREADY FIRED / INVALIDATED / INCOMPLETE / null
}

const BUCKET_ORDER: AiBucketKey[] = ["TRADE-full", "SIZE-DOWN", "SKIP", "other"];

function bucketStat(rows: ScorecardRow[]): AiBucket["stat"] {
  return computeStat(rows.filter(isResolvedRow).map((r) => r.rRealized as number));
}

function computeAiArm(rows: ScorecardRow[]): AiArm {
  const live = rows.filter((r) => r.latestSection === "live");
  const pending = rows.filter((r) => r.latestSection === "pending");

  const buckets: AiBucket[] = BUCKET_ORDER.map((key) => {
    const inBucket = live.filter((r) => aiBucketFor(r.latestDecision) === key);
    return {
      key,
      stat: bucketStat(inBucket),
      neverFired: inBucket.filter(isNeverFiredRow).length,
    };
  });

  // Pending verdicts keep their raw wording — WATCH / WATCH-CAUTION / SKIP /
  // ALREADY FIRED are watchlist states, not trade calls, so they are NOT folded
  // into the headline buckets.
  const pendingKeys = [...new Set(pending.map((r) => r.latestDecision ?? "(none)"))].sort();
  const pendingBuckets: AiBucket[] = pendingKeys.map((key) => {
    const inBucket = pending.filter((r) => (r.latestDecision ?? "(none)") === key);
    return {
      key,
      stat: bucketStat(inBucket),
      neverFired: inBucket.filter(isNeverFiredRow).length,
    };
  });

  // ---- the "signals disagree" cut ----
  const withBothSignals = live.filter(
    (r) =>
      analysisDirection(r.latestDecision) != null &&
      handleDirection(normalizeSizeBucket(r.sizeBucket)) != null
  );
  const flaggedRows = withBothSignals.filter((r) =>
    signalsDisagree(r.latestDecision, normalizeSizeBucket(r.sizeBucket))
  );
  const agreedRows = withBothSignals.filter(
    (r) => !signalsDisagree(r.latestDecision, normalizeSizeBucket(r.sizeBucket))
  );
  const dirPair = (r: ScorecardRow) => ({
    a: analysisDirection(r.latestDecision),
    h: handleDirection(normalizeSizeBucket(r.sizeBucket)),
  });
  const disagree: DisagreeCut = {
    flagged: bucketStat(flaggedRows),
    agreed: bucketStat(agreedRows),
    tradeVsHandleSkip: bucketStat(
      flaggedRows.filter((r) => {
        const d = dirPair(r);
        return d.a === "pos" && d.h === "neg";
      })
    ),
    skipVsHandleFull: bucketStat(
      flaggedRows.filter((r) => {
        const d = dirPair(r);
        return d.a === "neg" && d.h === "pos";
      })
    ),
  };

  // ---- plain-language read, hard-gated on sample size ----
  const trade = buckets.find((b) => b.key === "TRADE-full")!;
  const skip = buckets.find((b) => b.key === "SKIP")!;
  const insufficient = [trade, skip].filter((b) => b.stat.n < LOW_SAMPLE_THRESHOLD).map((b) => String(b.key));
  const gated = insufficient.length > 0 || trade.stat.avgR == null || skip.stat.avgR == null;

  let read: string | null = null;
  if (!gated) {
    const t = trade.stat.avgR as number;
    const s = skip.stat.avgR as number;
    const fmt = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
    const head = `AI SKIPs returned ${fmt(s)} avg R (n=${skip.stat.n}) vs ${fmt(t)} for AI TRADEs (n=${trade.stat.n})`;
    // A 0.10R gap is inside the noise for samples this size — call it no signal.
    read =
      t - s > 0.1
        ? `${head} → the overlay HELPED: the setups it green-lit outperformed the ones it skipped.`
        : s - t > 0.1
          ? `${head} → the overlay HURT: the setups it skipped outperformed the ones it green-lit. It is deleting good trades.`
          : `${head} → NO SIGNAL: the two arms are within 0.10R of each other; the overlay is not separating winners from losers.`;
  }

  return { buckets, pendingBuckets, disagree, read, readSuppressed: gated, insufficient };
}

// ============================================================
// Top level
// ============================================================

export interface ScorecardTotals {
  withOutcome: number;
  resolved: number;
  neverFired: number;
  open: number;
  realizedTrades: number;
}

export interface JackScorecard {
  generatedAt: string;
  lowSampleThreshold: number;
  totals: ScorecardTotals;
  live: LiveArm;
  ai: AiArm;
  reference: {
    rawR: typeof RAW_R_REFERENCE;
    capacitySim: typeof CAPACITY_SIM_PF;
  };
  /** Modeling assumptions printed on screen — the paper numbers are only as good as these. */
  paperAssumptions: string[];
}

export const PAPER_ASSUMPTIONS = [
  "paper FIRE = a confirmed CLOSE above the rim (breakout_level) within 15 bars of the handle low — an intraday high poking through the rim is NOT a breakout, and an unconfirmed setup never trades (never_fired)",
  "paper FILL = the NEXT bar's OPEN after that confirming close — never the rim, never the scanner's projected entry. Gap slippage is included, exactly as the backtest ate it",
  "exit = intraday touch: stop on the bar LOW, target on the bar HIGH, stop checked FIRST (same-bar tie → stop, conservative). A stop-out is exactly -1R",
  "time stop = 120 bars from entry → mark-to-market at the last close",
  "these four rules mirror the frozen backtest (cup_handle_15yr_history_1.ipynb) that produced the raw-R reference — that is what makes live-vs-reference a fair comparison",
  "eligibility: a setup is only resolved once ~130 trading days have elapsed, so the full 120-bar window is guaranteed to exist. Younger setups are absent here, not zero",
  "never_fired setups are counted but excluded from R statistics, identically on every arm",
  "KNOWN GAP (second-order): the paper stop is the SCANNER's stop, anchored to its projected entry — the backtest re-derived the stop from the realized fill + ATR. Closing it needs the scanner to emit ATR + the raw stop base",
];

export function computeScorecard(
  rows: ScorecardRow[],
  ranks: Map<number, number>,
  riskPerTrade: number,
  asOf?: string
): JackScorecard {
  const today = asOf ?? new Date().toISOString().split("T")[0];
  return {
    generatedAt: today,
    lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
    totals: {
      withOutcome: rows.length,
      resolved: rows.filter(isResolvedRow).length,
      neverFired: rows.filter(isNeverFiredRow).length,
      open: rows.filter(isOpenRow).length,
      realizedTrades: rows.filter(isRealizedTrade).length,
    },
    live: computeLiveArm(rows, ranks, riskPerTrade),
    ai: computeAiArm(rows),
    reference: { rawR: RAW_R_REFERENCE, capacitySim: CAPACITY_SIM_PF },
    paperAssumptions: PAPER_ASSUMPTIONS,
  };
}
