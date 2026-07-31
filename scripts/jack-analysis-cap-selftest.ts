/*
 * JACK analysis output-CAP-HARDEN self-test — the truncation/reconcile/degrade
 * contract (branch jack-analysis-cap-harden, 2026-07-20).
 *
 * Locks the three properties the cap-harden fix depends on:
 *   1. ALL-DECIDED: every input setup came back → incompleteCount 0, and the run
 *      is NOT degraded even when a batch's stop_reason was max_tokens (the cap cut
 *      only trailing markdown). This is the false-degrade fix.
 *   2. CUT-FENCE BATCH: a batch whose JSON fence was truncated yields NO decisions
 *      (extractJsonBlock → null), so ITS setups are reconciled to an explicit
 *      INCOMPLETE placeholder — never a silent drop, never a defaulted SKIP — and
 *      the run IS degraded.
 *   3. INCOMPLETE is inert in the display layer: it never triggers the SKIP veto
 *      and never raises the "signals disagree" flag.
 *
 * Pure — imports only the reconcile helper + the (pure) display classifiers.
 *
 * Run:  npx tsx scripts/jack-analysis-cap-selftest.ts
 */
import {
  INCOMPLETE_DECISION,
  normalizeIsoDate,
  buildDecidedKeys,
  incompleteForSetups,
  isDegraded,
} from "../lib/jack/reconcile";
import { signalsDisagree } from "../lib/jack/verdict";
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

// Shared fixtures: four setups, all with a valid handle_low_date.
const setups = [
  { ticker: "KRC", handleLowDate: "2026-07-10" },
  { ticker: "DORM", handleLowDate: "2026-07-11" },
  { ticker: "ROKU", handleLowDate: "2026-07-12" },
  { ticker: "HOMB", handleLowDate: "2026-07-13" },
];

// ---- 1. ALL-DECIDED — truncation that lost NO decisions is NOT degraded ----
console.log("\n[1] All setups decided (cap cut only trailing markdown)");
{
  // Every setup came back with a decision (mixed date formats to exercise normalize).
  const decisions = [
    { ticker: "KRC", handle_low_date: "2026-07-10", decision: "TRADE" },
    { ticker: "DORM", handle_low_date: "7/11/2026", decision: "SIZE DOWN 50%" },
    { ticker: "roku", handle_low_date: "2026-07-12", decision: "SKIP" }, // lowercase ticker
    { ticker: "HOMB", handle_low_date: "2026-07-13", decision: "TRADE" },
  ];
  const decidedKeys = buildDecidedKeys(decisions);
  const truncated = true; // a batch DID hit max_tokens...
  const incomplete = incompleteForSetups(setups, decidedKeys, truncated);
  const incompleteCount = incomplete.length;
  check("all four decided → 0 INCOMPLETE", incompleteCount === 0, `count=${incompleteCount}`);
  check(
    "NOT degraded despite stop_reason=max_tokens (markdown present, no loss)",
    isDegraded(true, incompleteCount) === false
  );
  check("no client markdown at all → degraded regardless", isDegraded(false, incompleteCount) === true);
}

// ---- 2. CUT-FENCE BATCH — its setups become INCOMPLETE, run IS degraded ----
console.log("\n[2] A batch's JSON fence was truncated (that batch parsed to nothing)");
{
  // Batch A (KRC, DORM) parsed fine. Batch B (ROKU, HOMB) had its closing ``` cut
  // → extractJsonBlock returned null → NO decisions survive for ROKU/HOMB.
  const survivingDecisions = [
    { ticker: "KRC", handle_low_date: "2026-07-10", decision: "TRADE" },
    { ticker: "DORM", handle_low_date: "2026-07-11", decision: "TRADE" },
  ];
  const decidedKeys = buildDecidedKeys(survivingDecisions);
  const truncated = true;
  const incomplete = incompleteForSetups(setups, decidedKeys, truncated);
  const incompleteCount = incomplete.length;
  check("2 undecided setups → 2 INCOMPLETE", incompleteCount === 2, `count=${incompleteCount}`);
  check(
    "INCOMPLETE are exactly ROKU + HOMB (the cut batch)",
    incomplete.map((d) => d.ticker).sort().join(",") === "HOMB,ROKU",
    incomplete.map((d) => d.ticker).join(",")
  );
  check("placeholder decision === INCOMPLETE_DECISION (not SKIP)", incomplete.every((d) => d.decision === INCOMPLETE_DECISION));
  check("no INCOMPLETE decision is 'SKIP'", incomplete.every((d) => !/SKIP/i.test(d.decision)));
  check(
    "truncated → note mentions the token cap",
    incomplete.every((d) => /token cap/.test(d.notes))
  );
  check("real decision loss → run IS degraded", isDegraded(true, incompleteCount) === true);
}

// ---- 2b. No-decision (non-truncation) still INCOMPLETE, different note ----
console.log("\n[2b] Undecided WITHOUT truncation (model just omitted a row)");
{
  const decidedKeys = buildDecidedKeys([{ ticker: "KRC", handle_low_date: "2026-07-10" }]);
  const incomplete = incompleteForSetups(setups, decidedKeys, /* truncated */ false);
  check("3 undecided → 3 INCOMPLETE", incomplete.length === 3, `count=${incomplete.length}`);
  check("no-truncation note says 'no decision returned'", incomplete.every((d) => /no decision returned/.test(d.notes)));
}

// ---- 3. INCOMPLETE is inert in the display layer ----
console.log("\n[3] INCOMPLETE never classifies as SKIP / never 'signals disagree'");
check("signalsDisagree(INCOMPLETE, full) === false", signalsDisagree(INCOMPLETE_DECISION, "full") === false);
check("signalsDisagree(INCOMPLETE, skip) === false", signalsDisagree(INCOMPLETE_DECISION, "skip") === false);
check("signalsDisagree(INCOMPLETE, half) === false", signalsDisagree(INCOMPLETE_DECISION, "half") === false);
{
  // FULL bucket + INCOMPLETE verdict → NOT vetoed (INCOMPLETE is not a SKIP verdict,
  // and the bucket isn't skip). Shows the would-be recShares, unstruck.
  const r = mainSharesForRow({
    userAction: null,
    decision: INCOMPLETE_DECISION,
    sizeBucket: "full",
    sharesAtMark: null,
    recShares: 236,
    fullShares: 236,
  });
  check("INCOMPLETE + full bucket → NOT vetoed", r.vetoed === false && r.shares === 236, JSON.stringify(r));
}

// ---- 4. Helper sanity (date normalize + key building) ----
console.log("\n[4] Reconcile helper sanity");
check("normalizeIsoDate ISO passthrough", normalizeIsoDate("2026-07-12") === "2026-07-12");
check("normalizeIsoDate US → ISO", normalizeIsoDate("7/5/2026") === "2026-07-05");
check("normalizeIsoDate junk → null", normalizeIsoDate("not-a-date") === null);
check(
  "buildDecidedKeys uppercases ticker + normalizes date",
  buildDecidedKeys([{ ticker: "krc", handle_low_date: "7/10/2026" }]).has("KRC|2026-07-10")
);

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
