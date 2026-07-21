/*
 * JACK decision-merge self-test — combineJackDecisions routing + the exactly-one-
 * section invariant (branch jack-priority-owned-routing).
 *
 * Rule under test: a setup whose LATEST mark is TRADED routes to CURRENT POSITIONS
 * ("open"), never LIVE/PENDING; PASSED/WATCHING/unmarked stay in LIVE/PENDING; and
 * NO setup ever vanishes or double-renders — even if the open-positions fetch is
 * empty (fall-through guard re-sections the TRADED run row to "open").
 *
 * Run:  npx tsx scripts/jack-combine-decisions-selftest.ts
 */
import { combineJackDecisions } from "../lib/jack/combine-decisions";
import type { JackDecisionClient } from "../components/bloomberg/hooks/useJackValidation";

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

function mk(overrides: Partial<JackDecisionClient>): JackDecisionClient {
  return {
    decisionId: null, setupId: null, ticker: "X", handleLowDate: "2026-07-10",
    section: "live", decision: "TRADE", entry: null, stop: null, target: null,
    shares: null, breakout: null, currentPrice: null, note: null, newsClass: null,
    sectorRs: null, crossAsset: null, earningsFlag: null, pctToBreakout: null,
    userAction: null, userEntryPrice: null, userEntryDate: null, userExitPrice: null,
    userExitDate: null, jackDecisionAtMark: null, sharesAtMark: null,
    ...overrides,
  } as JackDecisionClient;
}
const bySetup = (rows: JackDecisionClient[], id: number) => rows.filter((r) => r.setupId === id);

// ---- 1. Full routing: TRADED → open; PASSED/unmarked → live; pending → pending ----
console.log("\n[1] TRADED routes to CURRENT POSITIONS, others stay put");
{
  const run = [
    mk({ setupId: 1, ticker: "TRADIN", section: "live", userAction: "TRADED" }), // traded + in this week's scan
    mk({ setupId: 2, ticker: "PASS", section: "live", userAction: "PASSED" }),
    mk({ setupId: 3, ticker: "UNMARK", section: "live", userAction: null }),
    mk({ setupId: 4, ticker: "PEND", section: "pending", userAction: null }),
  ];
  const open = [
    mk({ setupId: 1, ticker: "TRADIN", section: "open", userAction: "TRADED" }), // owned view of #1 (from getOpenPositions)
    mk({ setupId: 5, ticker: "TRADOUT", section: "open", userAction: "TRADED" }), // owned, NOT in this week's scan
  ];
  const out = combineJackDecisions(run, open);

  const sec = (id: number) => bySetup(out, id).map((r) => r.section);
  check("TRADED-in-scan (#1) → open only (not live)", sec(1).length === 1 && sec(1)[0] === "open", sec(1).join(","));
  check("PASSED (#2) → live", sec(2).length === 1 && sec(2)[0] === "live", sec(2).join(","));
  check("unmarked (#3) → live", sec(3).length === 1 && sec(3)[0] === "live", sec(3).join(","));
  check("pending (#4) → pending", sec(4).length === 1 && sec(4)[0] === "pending", sec(4).join(","));
  check("TRADED-not-in-scan (#5) → open", sec(5).length === 1 && sec(5)[0] === "open", sec(5).join(","));
}

// ---- 2. Exactly-one-section invariant: no vanish, no double-render ----
console.log("\n[2] Every setup appears in exactly one section");
{
  const run = [
    mk({ setupId: 1, section: "live", userAction: "TRADED" }),
    mk({ setupId: 2, section: "live", userAction: "PASSED" }),
    mk({ setupId: 3, section: "pending", userAction: null }),
  ];
  const open = [
    mk({ setupId: 1, section: "open", userAction: "TRADED" }),
    mk({ setupId: 5, section: "open", userAction: "TRADED" }),
  ];
  const out = combineJackDecisions(run, open);
  const ids = out.map((r) => r.setupId);
  const uniq = new Set(ids);
  check("no setupId appears twice", ids.length === uniq.size, `ids=${ids.join(",")}`);
  check("all input setups present (1,2,3,5)", [1, 2, 3, 5].every((id) => uniq.has(id)), [...uniq].join(","));
  check("total rows = 4 (no vanish, no dupe)", out.length === 4, String(out.length));
}

// ---- 3. Fall-through guard: TRADED run row with EMPTY open fetch still surfaces ----
console.log("\n[3] Open fetch empty → TRADED run row re-sectioned to open (never vanishes)");
{
  const out = combineJackDecisions(
    [mk({ setupId: 9, ticker: "RACE", section: "live", userAction: "TRADED" })],
    [] // open-positions fetch hasn't returned yet
  );
  check("single row returned", out.length === 1, String(out.length));
  check("TRADED row re-sectioned to open (not lost, not left in live)", out[0]?.section === "open", out[0]?.section);
}

// ---- 4. No open rows + no traded → passthrough unchanged ----
console.log("\n[4] Plain passthrough (no owned rows)");
{
  const run = [
    mk({ setupId: 1, section: "live", userAction: null }),
    mk({ setupId: 2, section: "pending", userAction: "PASSED" }),
  ];
  const out = combineJackDecisions(run, []);
  check("both run rows kept, sections unchanged", out.length === 2 && out.every((r) => r.section !== "open"));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
