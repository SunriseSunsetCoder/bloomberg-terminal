/*
 * JACK handle_score RENDER self-test — proves the setup-row component actually
 * renders the structured pill (and disagreement flag) when the decision object
 * carries handleScore + sizeBucket. This is the regression guard for "the pill
 * data path is correct" — it renders the REAL JackDecisionsTable to HTML and
 * asserts the pill markup is present.
 *
 * Run:  npx tsx scripts/jack-handle-score-render-selftest.tsx
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JackDecisionsTable } from "../components/bloomberg/views/jack-decisions-table";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// A fully-populated FULL-bucket row (analysis TRADE agrees with handle FULL).
const krc = {
  decisionId: 1, setupId: 10, ticker: "KRC", handleLowDate: "2026-07-15",
  section: "live", decision: "TRADE",
  entry: 40, stop: 38, target: 48, shares: 100, breakout: 40.1, currentPrice: 41,
  note: "clean handle", newsClass: null, sectorRs: null, crossAsset: null,
  earningsFlag: null, pctToBreakout: 1.2,
  userAction: null, userEntryPrice: null, userEntryDate: null, userExitPrice: null, userExitDate: null,
  jackDecisionAtMark: null, sharesAtMark: null,
  handleScore: 0.717, sizeBucket: "full",
  fullShares: 1000, fullNotional: 40000, halfShares: 500, halfNotional: 20000,
  recShares: 1000, recNotional: 40000,
};
// A SKIP-bucket row where the analysis said TRADE → hard conflict → disagreement flag.
const spg = { ...krc, ticker: "SPG", decision: "TRADE", handleScore: 0.349, sizeBucket: "skip", recShares: null, recNotional: null };

const html = renderToStaticMarkup(
  React.createElement(JackDecisionsTable, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    decisions: [krc, spg] as any,
    isDarkMode: true,
    persistenceAvailable: true,
    individualCap: 200000,
  })
);

console.log("\n[render] JackDecisionsTable → HTML");
check("structured pill label 'handle score:' present", html.includes("handle score:"));
check("KRC renders 'FULL · 0.72'", html.includes("FULL · 0.72"));
check("SPG renders 'SKIP · 0.35' (skip still shown)", html.includes("SKIP · 0.35"));
check("disagreement flag 'signals disagree' present (SPG TRADE+skip)", html.includes("signals disagree"));
check("analysis verdict still rendered alongside", html.includes("TRADE"));

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
