// =============================================================================
// JACK Session C — pure analytics computation (no DB, no React → unit-testable).
//
// Encodes the CRITICAL modeling rules from the spec §3:
//  - NULL user_action != PASSED (NULL in universe, excluded from selection math).
//  - Universe = RESOLVED setups (theoretical R); exclude never_fired + still_open.
//  - Selection uses jack_decision_at_mark (frozen), not the drifting live decision.
//  - Execution delta = user_R_realized - R_realized; report mean AND median, flag
//    outlier-driven aggregates and idiosyncratic causes (pre-breakout entry).
//  - still_open excluded from resolved stats; shown in a separate open-exposure strip.
//  - Sample guards: n < LOW_SAMPLE_THRESHOLD flags "LOW SAMPLE"; the
//    universe-vs-selected VERDICT is SUPPRESSED until both arms clear the threshold.
// =============================================================================

import type { AnalyticsRow } from "@/lib/db/analytics";
import { normalizeSizeBucket, type SizeBucket } from "@/lib/jack/handle-score";

// n>=30 mirrors the futures-book discipline (PROJECT_STATE §4). Named, not magic.
export const LOW_SAMPLE_THRESHOLD = 30;

// Bucket display order for the forward test — best directive first.
const BUCKET_ORDER: SizeBucket[] = ["full", "half", "skip"];

const RESOLVED_REASONS = new Set(["target", "stop", "timeout"]);

export function isResolved(r: AnalyticsRow): boolean {
  return r.exitReason != null && RESOLVED_REASONS.has(r.exitReason) && r.rRealized != null;
}
export function isNeverFired(r: AnalyticsRow): boolean {
  return r.exitReason === "never_fired";
}
// Live position: the user traded it, hasn't logged an exit, and it isn't resolved.
export function isOpenPosition(r: AnalyticsRow): boolean {
  return r.userAction === "TRADED" && r.userExitPrice == null && !isResolved(r) && !isNeverFired(r);
}

function isSkipVerdict(v: string | null): boolean {
  return !!v && /SKIP|AVOID|PASS/i.test(v);
}
function isTradeVerdict(v: string | null): boolean {
  return !!v && /TRADE/i.test(v);
}

export interface RStat {
  n: number;
  winRate: number | null; // fraction 0..1
  avgR: number | null;
  pf: number | null; // null = no losers → PF undefined (∞)
  grossWin: number;
  grossLoss: number;
  lowSample: boolean; // n < LOW_SAMPLE_THRESHOLD
}

export function computeStat(rs: number[]): RStat {
  const n = rs.length;
  if (n === 0) {
    return { n: 0, winRate: null, avgR: null, pf: null, grossWin: 0, grossLoss: 0, lowSample: true };
  }
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n,
    winRate: wins.length / n,
    avgR: rs.reduce((a, b) => a + b, 0) / n,
    pf: grossLoss > 0 ? grossWin / grossLoss : null,
    grossWin,
    grossLoss,
    lowSample: n < LOW_SAMPLE_THRESHOLD,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function quarterOf(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(dateIso);
  if (!m) return "unknown";
  const q = Math.floor((parseInt(m[2], 10) - 1) / 3) + 1;
  return `${m[1]}-Q${q}`;
}

function daysBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.round((t1 - t0) / 86400000);
}

// ---- output shapes ----
export interface Bucket extends RStat {
  bucket: string;
}
export interface ExecTrade {
  ticker: string;
  rRealized: number;
  userR: number;
  delta: number;
  cause: string;
}
export interface OverrideStat extends RStat {
  label: string;
}
export interface OpenPosition {
  ticker: string;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  stop: number | null;
  target: number | null;
  riskPerShare: number | null; // entry - stop (the R denominator)
  daysHeld: number | null;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
}

// ---- handle_score forward test (spec Part D) ----
// Quintile/bucket PF on REAL RESOLVED setups, grouped by the FROZEN sizing
// directive, so JACK confirms on its OWN accumulated trades whether full > half >
// skip in realized PF — closing the backtest→live loop. Primary metric is
// theoretical R (rRealized), the exact analog of the validated quintile-PF table;
// `actual` re-cuts it on user-fill R for setups actually TRADED.
export interface HandleBucketStat extends RStat {
  bucket: SizeBucket;
  actual: RStat; // user-fill R over TRADED+resolved rows in this bucket
}
export interface HandleScoreForwardTest {
  buckets: HandleBucketStat[]; // ordered full, half, skip (always all three present)
  unbucketed: RStat; // resolved setups with no handle_score (pre-signal history)
  // Backtest reference (FROZEN) the live numbers are being checked against.
  backtestReference: Array<{ bucket: SizeBucket; quintile: string; isPf: number; oosPf: number }>;
  // Verdict is SUPPRESSED until EACH of full/half/skip clears n>=30 resolved — do
  // NOT show a confident "full beats skip" on a handful of trades.
  verdict: string | null;
  verdictSuppressed: boolean;
  insufficientBuckets: SizeBucket[]; // buckets still under the threshold
  minBucketN: number; // smallest per-bucket resolved n (drives the guard)
}

export interface JackAnalytics {
  generatedAt: string;
  lowSampleThreshold: number;
  totals: { withOutcome: number; resolved: number; neverFired: number; open: number };
  edgeOverTime: Bucket[];
  handleScoreForwardTest: HandleScoreForwardTest;
  universeVsSelected: {
    universe: RStat;
    selectedTheoretical: RStat;
    selectedActual: RStat;
    deltaPf: number | null; // selectedTheo.pf - universe.pf
    deltaAvgR: number | null;
    verdict: string | null; // null = SUPPRESSED (insufficient sample) — do NOT render a conclusion
    verdictSuppressed: boolean;
  };
  execution: {
    meanDelta: number | null;
    medianDelta: number | null;
    n: number;
    lowSample: boolean;
    outlierDriven: boolean; // one trade dominates the mean → trust the median
    trades: ExecTrade[]; // sorted by delta desc
  };
  decisionBreakdown: {
    traded: RStat;
    passed: RStat;
    overrides: OverrideStat[]; // "traded JACK's SKIP", "passed JACK's TRADE"
    perTicker: Array<{
      ticker: string;
      userAction: string | null;
      jackDecisionAtMark: string | null;
      rRealized: number | null;
      userR: number | null;
      exitReason: string | null;
    }>;
  };
  openExposure: OpenPosition[];
}

export function computeAnalytics(rows: AnalyticsRow[], asOf?: string): JackAnalytics {
  const today = asOf ?? new Date().toISOString().split("T")[0];

  const resolved = rows.filter(isResolved);
  const neverFired = rows.filter(isNeverFired);
  const open = rows.filter(isOpenPosition);

  // ---- View 1: edge over time (quarterly by setup date, theoretical R) ----
  const byQuarter = new Map<string, number[]>();
  for (const r of resolved) {
    const q = quarterOf(r.handleLowDate);
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q)!.push(r.rRealized as number);
  }
  const edgeOverTime: Bucket[] = [...byQuarter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, rs]) => ({ bucket, ...computeStat(rs) }));

  // ---- Handle-score forward test (Part D): bucket PF on resolved setups ----
  // Group every RESOLVED setup by its frozen sizing directive and compute PF on
  // theoretical R (the quintile-PF analog). Also re-cut each bucket on ACTUAL
  // user-fill R (TRADED rows with a logged fill) — the "on real trades" view.
  const buckets: HandleBucketStat[] = BUCKET_ORDER.map((bucket) => {
    const inBucket = resolved.filter((r) => normalizeSizeBucket(r.sizeBucket) === bucket);
    const theo = computeStat(inBucket.map((r) => r.rRealized as number));
    const actualRows = inBucket.filter((r) => r.userAction === "TRADED" && r.userRRealized != null);
    const actual = computeStat(actualRows.map((r) => r.userRRealized as number));
    return { bucket, ...theo, actual };
  });
  const unbucketed = computeStat(
    resolved.filter((r) => normalizeSizeBucket(r.sizeBucket) == null).map((r) => r.rRealized as number)
  );

  // Guard: the verdict is SUPPRESSED until EVERY bucket has n>=30 resolved. Below
  // that we scream "insufficient data" and show only the raw bucket numbers.
  const insufficientBuckets = buckets.filter((b) => b.n < LOW_SAMPLE_THRESHOLD).map((b) => b.bucket);
  const minBucketN = Math.min(...buckets.map((b) => b.n));
  const bucketsClear = insufficientBuckets.length === 0;

  let hsVerdict: string | null = null;
  if (bucketsClear) {
    const full = buckets.find((b) => b.bucket === "full")!;
    const half = buckets.find((b) => b.bucket === "half")!;
    const skip = buckets.find((b) => b.bucket === "skip")!;
    // PF can be null (no losers → ∞); treat null as +Infinity for the ordering.
    const pf = (b: HandleBucketStat) => (b.pf == null ? Number.POSITIVE_INFINITY : b.pf);
    const monotonic = pf(full) > pf(half) && pf(half) > pf(skip);
    hsVerdict = monotonic
      ? "CONFIRMED on live trades — realized PF is monotonic full > half > skip; the handle-score sizing edge holds forward."
      : pf(full) > pf(skip)
        ? "PARTIAL — full outperforms skip on realized PF, but the full > half > skip ordering isn't clean. Directionally consistent with the backtest."
        : "NOT CONFIRMED — realized PF does NOT rank full > skip. The live sample contradicts the backtest; investigate before trusting score-sizing.";
  }

  const forwardTest: HandleScoreForwardTest = {
    buckets,
    unbucketed,
    backtestReference: [
      { bucket: "full", quintile: "Q5", isPf: 4.2, oosPf: 4.36 },
      { bucket: "full", quintile: "Q4", isPf: 2.13, oosPf: 3.03 },
      // Q3 promoted half→full 2026-07-20 (15-yr backtest, PF 2.24 all 16 yrs). isPf/oosPf
      // below are the FROZEN original t05 reference numbers, kept as-is for the record.
      { bucket: "full", quintile: "Q3", isPf: 1.38, oosPf: 1.65 },
      { bucket: "skip", quintile: "Q2", isPf: 1.79, oosPf: 0.87 },
      { bucket: "skip", quintile: "Q1", isPf: 1.2, oosPf: 1.1 },
    ],
    verdict: hsVerdict,
    verdictSuppressed: !bucketsClear,
    insufficientBuckets,
    minBucketN: Number.isFinite(minBucketN) ? minBucketN : 0,
  };

  // ---- View 2: universe vs selected ----
  const universe = computeStat(resolved.map((r) => r.rRealized as number));
  const selTheoRows = resolved.filter((r) => r.userAction === "TRADED");
  const selectedTheoretical = computeStat(selTheoRows.map((r) => r.rRealized as number));
  const selActualRows = selTheoRows.filter((r) => r.userRRealized != null);
  const selectedActual = computeStat(selActualRows.map((r) => r.userRRealized as number));

  const bothClear = universe.n >= LOW_SAMPLE_THRESHOLD && selectedTheoretical.n >= LOW_SAMPLE_THRESHOLD;
  let verdict: string | null = null;
  if (bothClear && selectedTheoretical.pf != null && universe.pf != null) {
    verdict =
      selectedTheoretical.pf > universe.pf * 1.1
        ? "Selection ADDS value — selected PF exceeds the universe."
        : selectedTheoretical.pf < universe.pf * 0.9
          ? "Selection DETRACTS — selected PF trails the universe (mechanical would beat you)."
          : "Selection ~ neutral vs trading the full universe.";
  }
  const deltaPf =
    selectedTheoretical.pf != null && universe.pf != null ? selectedTheoretical.pf - universe.pf : null;
  const deltaAvgR =
    selectedTheoretical.avgR != null && universe.avgR != null ? selectedTheoretical.avgR - universe.avgR : null;

  // ---- View 3: execution quality (theoretical vs actual R) ----
  const execRows = resolved.filter(
    (r) => r.userAction === "TRADED" && r.userRRealized != null && r.rRealized != null
  );
  const trades: ExecTrade[] = execRows
    .map((r) => {
      const delta = (r.userRRealized as number) - (r.rRealized as number);
      let cause: string;
      if (r.userEntryPrice != null && r.breakout != null && r.userEntryPrice < r.breakout) {
        cause = "pre-breakout entry — smaller risk denominator inflates R (idiosyncratic, not skill)";
      } else if (delta < -0.15) {
        cause = "underperformed setup — early exit / bad take-profit";
      } else if (delta > 0.15) {
        cause = "beat setup — favorable fill/exit";
      } else {
        cause = "≈ tracked the setup";
      }
      return { ticker: r.ticker, rRealized: r.rRealized as number, userR: r.userRRealized as number, delta, cause };
    })
    .sort((a, b) => b.delta - a.delta);

  const deltas = trades.map((t) => t.delta);
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const medianDelta = median(deltas);
  // One trade dominates the mean when the largest |delta| exceeds 3R AND is far from
  // the median — e.g. WELL's pre-breakout-entry R. Then trust the median.
  const maxAbs = deltas.length ? Math.max(...deltas.map(Math.abs)) : 0;
  const outlierDriven =
    deltas.length >= 2 && maxAbs >= 3 && (medianDelta == null || maxAbs > Math.abs(medianDelta) * 3);

  // ---- View 4: decision-type breakdown ----
  const traded = computeStat(resolved.filter((r) => r.userAction === "TRADED").map((r) => r.rRealized as number));
  const passed = computeStat(resolved.filter((r) => r.userAction === "PASSED").map((r) => r.rRealized as number));
  const tradedJackSkip = resolved.filter((r) => r.userAction === "TRADED" && isSkipVerdict(r.jackDecisionAtMark));
  const passedJackTrade = resolved.filter((r) => r.userAction === "PASSED" && isTradeVerdict(r.jackDecisionAtMark));
  const overrides: OverrideStat[] = [
    { label: "Traded JACK's SKIP (overrode a skip)", ...computeStat(tradedJackSkip.map((r) => r.rRealized as number)) },
    { label: "Passed JACK's TRADE (overrode a trade)", ...computeStat(passedJackTrade.map((r) => r.rRealized as number)) },
  ];
  const perTicker = resolved
    .filter((r) => r.userAction === "TRADED" || r.userAction === "PASSED")
    .map((r) => ({
      ticker: r.ticker,
      userAction: r.userAction,
      jackDecisionAtMark: r.jackDecisionAtMark,
      rRealized: r.rRealized,
      userR: r.userRRealized,
      exitReason: r.exitReason,
    }));

  // ---- Open exposure strip (mark-to-market where available) ----
  const openExposure: OpenPosition[] = open.map((r) => ({
    ticker: r.ticker,
    userEntryPrice: r.userEntryPrice,
    userEntryDate: r.userEntryDate,
    stop: r.stop,
    target: r.target,
    riskPerShare: r.userEntryPrice != null && r.stop != null ? r.userEntryPrice - r.stop : null,
    daysHeld: daysBetween(r.userEntryDate, today),
    maxFavorablePct: r.maxFavorablePct,
    maxAdversePct: r.maxAdversePct,
  }));

  return {
    generatedAt: today,
    lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
    totals: { withOutcome: rows.length, resolved: resolved.length, neverFired: neverFired.length, open: open.length },
    edgeOverTime,
    handleScoreForwardTest: forwardTest,
    universeVsSelected: {
      universe,
      selectedTheoretical,
      selectedActual,
      deltaPf,
      deltaAvgR,
      verdict,
      verdictSuppressed: !bothClear,
    },
    execution: { meanDelta, medianDelta, n: trades.length, lowSample: trades.length < LOW_SAMPLE_THRESHOLD, outlierDriven, trades },
    decisionBreakdown: { traded, passed, overrides, perTicker },
    openExposure,
  };
}
