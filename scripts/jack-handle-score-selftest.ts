/*
 * JACK handle_score self-test — pure-logic verification (no DB, no network).
 *
 * Covers the four things the integration must get right:
 *   1. Bucketing against the FROZEN edges (spec sanity: HOMB 0.452→skip below the
 *      0.456 Q3 line; AHR 0.658→full above the 0.657 line; the Q3/Q4 lines).
 *   2. The UNIT-MISMATCH fix (fraction 0.15 → 15; percent 14.5 stays).
 *   3. Concrete sizing (full_shares = risk ÷ stop distance; half = full × 0.5).
 *   4. The forward-test n≥30-per-bucket guard: it must SUPPRESS its verdict on a
 *      handful of trades and only draw a conclusion once every bucket clears 30.
 *
 * Run:  npx tsx scripts/jack-handle-score-selftest.ts
 */
import {
  bucketForScore,
  quintileForScore,
  normalizeDepthPct,
  computeSizing,
  computeHandleScore,
  searchsortedRight,
  HSCORE_EDGES,
  handleScoreReference,
} from "../lib/jack/handle-score";
import { computeAnalytics } from "../lib/jack/analytics";
import type { AnalyticsRow } from "../lib/db/analytics";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- 1. Bucketing vs frozen edges ----
console.log("\n[1] Bucketing against frozen edges", JSON.stringify([...HSCORE_EDGES]));
check("HOMB 0.452 → skip (just under 0.456 Q3 line)", bucketForScore(0.452) === "skip", bucketForScore(0.452) ?? "null");
check("0.456 exactly → half (Q3 line)", bucketForScore(0.456) === "half", bucketForScore(0.456) ?? "null");
check("AHR 0.658 → full (just over 0.657 line)", bucketForScore(0.658) === "full", bucketForScore(0.658) ?? "null");
check("0.548 → full (Q4 line)", bucketForScore(0.548) === "full", bucketForScore(0.548) ?? "null");
check("0.20 → skip (Q1/Q2 low)", bucketForScore(0.2) === "skip", bucketForScore(0.2) ?? "null");
check("0.90 → full (top)", bucketForScore(0.9) === "full", bucketForScore(0.9) ?? "null");
check("below-range 0.0 → skip", bucketForScore(0.0) === "skip", bucketForScore(0.0) ?? "null");
check("null score → null bucket", bucketForScore(null) === null);
check("quintile(0.452)=1 (Q2)", quintileForScore(0.452) === 1, String(quintileForScore(0.452)));
check("quintile(0.658)=4 (Q5)", quintileForScore(0.658) === 4, String(quintileForScore(0.658)));
check("searchsortedRight equal-to-edge counts left", searchsortedRight([1, 2, 3], 2) === 2, String(searchsortedRight([1, 2, 3], 2)));

// ---- 2. Unit-mismatch fix ----
console.log("\n[2] Depth unit normalization (fraction → percent)");
check("fraction 0.15 → 15", normalizeDepthPct(0.15) === 15, String(normalizeDepthPct(0.15)));
check("fraction 0.324 → 32.4", Math.abs((normalizeDepthPct(0.324) ?? 0) - 32.4) < 1e-9, String(normalizeDepthPct(0.324)));
check("percent 14.5 unchanged", normalizeDepthPct(14.5) === 14.5, String(normalizeDepthPct(14.5)));
check("percent 43.2 unchanged", normalizeDepthPct(43.2) === 43.2, String(normalizeDepthPct(43.2)));
check("null → null", normalizeDepthPct(null) === null);
check("boundary 1.0 unchanged (already percent)", normalizeDepthPct(1.0) === 1.0, String(normalizeDepthPct(1.0)));

// ---- 3. Concrete sizing ----
console.log("\n[3] Concrete share sizing");
const sz = computeSizing(2000, 145.0, 139.12); // risk/share ≈ 5.88 → 340 sh
check("full_shares = floor(2000 / (145-139.12)) = 340", sz.fullShares === 340, String(sz.fullShares));
check("full_notional = 340 × 145 = 49300", sz.fullNotional === 49300, String(sz.fullNotional));
check("half_shares = floor(340 × 0.5) = 170", sz.halfShares === 170, String(sz.halfShares));
const szBad = computeSizing(2000, 100, 105); // stop above entry
check("stop >= entry → null shares", szBad.fullShares === null);
const szNull = computeSizing(2000, null, 90);
check("missing entry → null shares", szNull.fullShares === null);

// ---- fallback scorer (percentile vs history) ----
console.log("\n[3b] Fallback percentile scorer");
const thresholds = {
  feature_hist: {
    days_since_handle_low: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    handle_dur_days: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    handle_depth_atr: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
  },
};
// lowest possible features → all contribs high → score near 1
const hiScore = computeHandleScore({ days_since_handle_low: 1, handle_dur_days: 10, handle_depth_atr: 0.5 }, thresholds);
const loScore = computeHandleScore({ days_since_handle_low: 10, handle_dur_days: 100, handle_depth_atr: 5 }, thresholds);
check("fresh/short/shallow scores higher than stale/long/deep", (hiScore ?? 0) > (loScore ?? 1), `${hiScore} vs ${loScore}`);
check("missing feature → neutral contrib keeps score in 0..1", (() => {
  const s = computeHandleScore({ days_since_handle_low: 5 }, thresholds);
  return s != null && s >= 0 && s <= 1;
})());

// ---- 4. Forward-test n>=30 per-bucket guard ----
console.log("\n[4] Forward-test suppression guard (n>=30 per bucket)");
function row(i: number, bucket: string, r: number): AnalyticsRow {
  return {
    setupId: i,
    ticker: `T${i}`,
    handleLowDate: "2026-01-15",
    entry: 100,
    stop: 95,
    target: 115,
    breakout: 101,
    fired: 1,
    exitReason: r >= 0 ? "target" : "stop",
    rRealized: r,
    maxFavorablePct: null,
    maxAdversePct: null,
    handleScore: bucket === "full" ? 0.7 : bucket === "half" ? 0.5 : 0.2,
    sizeBucket: bucket,
    userAction: null,
    jackDecisionAtMark: null,
    userRRealized: null,
    userEntryPrice: null,
    userEntryDate: null,
    userExitPrice: null,
    userExitDate: null,
  };
}
// Small sample — a few resolved per bucket. Guard MUST suppress.
const smallRows: AnalyticsRow[] = [];
let idx = 0;
for (const b of ["full", "half", "skip"]) for (let k = 0; k < 5; k++) smallRows.push(row(idx++, b, k % 4 === 0 ? -1 : 2));
const smallFt = computeAnalytics(smallRows, "2026-07-18").handleScoreForwardTest;
check("small sample → verdict SUPPRESSED", smallFt.verdictSuppressed === true);
check("small sample → verdict text is null (no confident conclusion)", smallFt.verdict === null);
check("small sample → all 3 buckets flagged insufficient", smallFt.insufficientBuckets.length === 3, smallFt.insufficientBuckets.join(","));
check("small sample → raw bucket numbers STILL present", smallFt.buckets.every((b) => b.n === 5));
check("minBucketN reported = 5", smallFt.minBucketN === 5, String(smallFt.minBucketN));

// Large sample — 35 per bucket, PF monotonic full>half>skip. Guard releases.
const bigRows: AnalyticsRow[] = [];
idx = 1000;
// full: mostly winners (high PF); half: fewer; skip: near breakeven.
const winRates: Record<string, number> = { full: 0.9, half: 0.6, skip: 0.4 };
for (const b of ["full", "half", "skip"]) {
  for (let k = 0; k < 35; k++) {
    const win = k / 35 < winRates[b];
    bigRows.push(row(idx++, b, win ? 3 : -1));
  }
}
const bigFt = computeAnalytics(bigRows, "2026-07-18").handleScoreForwardTest;
check("large sample → verdict RELEASED (not suppressed)", bigFt.verdictSuppressed === false);
check("large sample → verdict text present", typeof bigFt.verdict === "string" && (bigFt.verdict?.length ?? 0) > 0);
check("large sample → no insufficient buckets", bigFt.insufficientBuckets.length === 0);
const pf = (bk: string) => bigFt.buckets.find((x) => x.bucket === bk)!.pf ?? Infinity;
check("large sample → PF monotonic full>half>skip", pf("full") > pf("half") && pf("half") > pf("skip"), `${pf("full")}/${pf("half")}/${pf("skip")}`);
check("large sample → verdict CONFIRMED", (bigFt.verdict ?? "").includes("CONFIRMED"), bigFt.verdict ?? "");

// One-bucket-short: full & half clear 30 but skip has 10 → still suppressed.
const mixedRows: AnalyticsRow[] = [];
idx = 5000;
for (let k = 0; k < 35; k++) mixedRows.push(row(idx++, "full", k < 30 ? 3 : -1));
for (let k = 0; k < 35; k++) mixedRows.push(row(idx++, "half", k < 20 ? 3 : -1));
for (let k = 0; k < 10; k++) mixedRows.push(row(idx++, "skip", -1));
const mixedFt = computeAnalytics(mixedRows, "2026-07-18").handleScoreForwardTest;
check("one bucket short (skip n=10) → STILL suppressed", mixedFt.verdictSuppressed === true);
check("one bucket short → only skip flagged", mixedFt.insufficientBuckets.length === 1 && mixedFt.insufficientBuckets[0] === "skip", mixedFt.insufficientBuckets.join(","));

// ---- reference payload sanity ----
console.log("\n[5] Frozen reference payload");
const ref = handleScoreReference();
check("reference edges match frozen constants", JSON.stringify(ref.hscore_edges) === JSON.stringify([...HSCORE_EDGES]));
check("reference size map Q5/Q4 full, Q3 half, Q1/Q2 skip", ref.size_map.Q5 === "full" && ref.size_map.Q4 === "full" && ref.size_map.Q3 === "half" && ref.size_map.Q2 === "skip" && ref.size_map.Q1 === "skip");

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
