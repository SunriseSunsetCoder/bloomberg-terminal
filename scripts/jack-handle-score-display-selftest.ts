/*
 * JACK handle_score DISPLAY self-test — the disagreement-flag direction mapping.
 *
 * Locks the deterministic rule: flag ONLY the hard positive/negative contradiction
 * between the analysis verdict and the handle bucket (TRADE+SKIP, SKIP+FULL).
 * caution-vs-anything (SIZE DOWN, HALF) is a nuance and must stay quiet.
 *
 * Run:  npx tsx scripts/jack-handle-score-display-selftest.ts
 */
import { analysisDirection, handleDirection, signalsDisagree } from "../lib/jack/verdict";
import { mainSharesForRow } from "../components/bloomberg/views/jack-decisions-table";

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

console.log("\n[1] Analysis-verdict direction");
check("TRADE → pos", analysisDirection("TRADE") === "pos");
check("SKIP → neg", analysisDirection("SKIP") === "neg");
check("AVOID → neg", analysisDirection("AVOID") === "neg");
check("SIZE DOWN 50% → caution", analysisDirection("SIZE DOWN 50%") === "caution");
check("REDUCE → caution", analysisDirection("REDUCE") === "caution");
check("TRADE — SIZE DOWN 50% → caution (size-down wins over trade)", analysisDirection("TRADE — SIZE DOWN 50%") === "caution");
check("WATCH → null (no stance, never flags)", analysisDirection("WATCH") === null);
check("INCOMPLETE — RE-RUN → null", analysisDirection("INCOMPLETE — RE-RUN") === null);
check("null → null", analysisDirection(null) === null);

console.log("\n[2] Handle-bucket direction");
check("full → pos", handleDirection("full") === "pos");
check("half → caution", handleDirection("half") === "caution");
check("skip → neg", handleDirection("skip") === "neg");
check("FULL (caps) → pos", handleDirection("FULL") === "pos");
check("null → null", handleDirection(null) === null);

console.log("\n[3] Disagreement — HARD opposite only");
check("TRADE + skip → DISAGREE", signalsDisagree("TRADE", "skip") === true);
check("SKIP + full → DISAGREE", signalsDisagree("SKIP", "full") === true);
check("SIZE DOWN + full → quiet (caution vs pos)", signalsDisagree("SIZE DOWN 50%", "full") === false);
check("TRADE + half → quiet (pos vs caution)", signalsDisagree("TRADE", "half") === false);
check("SKIP + half → quiet (neg vs caution)", signalsDisagree("SKIP", "half") === false);
check("SIZE DOWN + half → quiet (caution vs caution)", signalsDisagree("SIZE DOWN 50%", "half") === false);
check("TRADE + full → agree (quiet)", signalsDisagree("TRADE", "full") === false);
check("SKIP + skip → agree (quiet)", signalsDisagree("SKIP", "skip") === false);
check("WATCH + full → quiet (no analysis stance)", signalsDisagree("WATCH", "full") === false);
check("TRADE + null bucket → quiet (no handle stance)", signalsDisagree("TRADE", null) === false);

// ---- Main "Shares" — bucket-driven with SKIP veto (handoff decision 3) ----
console.log("\n[4] Main Shares tied to handle bucket (+ SKIP veto)");
type Row = Parameters<typeof mainSharesForRow>[0];
const row = (o: Partial<Row>): Row => ({
  userAction: null, decision: "TRADE", sizeBucket: null,
  sharesAtMark: null, recShares: null, fullShares: null, ...o,
});
// DORM: FULL bucket → full-risk 236 (even if the analysis verdict is SIZE DOWN 50%,
// which is NOT a skip so it must not veto).
{
  const r = mainSharesForRow(row({ decision: "SIZE DOWN 50%", sizeBucket: "full", recShares: 236, fullShares: 236 }));
  check("DORM FULL → 236, not vetoed", r.shares === 236 && r.vetoed === false, JSON.stringify(r));
}
// CBU: HALF bucket → ×0.5 = 202 (recShares already halved).
{
  const r = mainSharesForRow(row({ decision: "TRADE", sizeBucket: "half", recShares: 202, fullShares: 405 }));
  check("CBU HALF → 202, not vetoed", r.shares === 202 && r.vetoed === false, JSON.stringify(r));
}
// ROKU: SKIP analysis verdict + FULL bucket → vetoed; shows the would-be (recShares) struck.
{
  const r = mainSharesForRow(row({ decision: "SKIP", sizeBucket: "full", recShares: 300, fullShares: 300 }));
  check("ROKU SKIP+FULL → vetoed, would-be 300 struck", r.vetoed === true && r.shares === 300, JSON.stringify(r));
}
// Skip-bucket row → vetoed; recShares is null for skip, so falls back to full-risk, struck.
{
  const r = mainSharesForRow(row({ decision: "TRADE", sizeBucket: "skip", recShares: null, fullShares: 280 }));
  check("skip-bucket → vetoed, would-be full-risk 280 struck", r.vetoed === true && r.shares === 280, JSON.stringify(r));
}
// Marked row keeps its frozen mark-time size and is never vetoed (already decided).
{
  const r = mainSharesForRow(row({ userAction: "TRADED", decision: "SKIP", sizeBucket: "skip", sharesAtMark: 150 }));
  check("marked TRADED skip → frozen 150, not vetoed", r.shares === 150 && r.vetoed === false, JSON.stringify(r));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
