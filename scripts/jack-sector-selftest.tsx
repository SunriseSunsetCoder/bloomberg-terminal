/*
 * JACK scanner-classification INGEST+RENDER self-test — proves sector / tier /
 * priority round-trip from the pasted scanner CSV all the way to the rendered
 * setup row, mirroring the size_bucket path (branch jack-sector-ingest).
 *
 * Covers:
 *   1. Parse + join: a CSV row carrying sector/tier/priority survives applyFilters
 *      (by-name, position-agnostic) and buildClientDecisions onto the client row.
 *   2. Render: those values appear on the COLLAPSED row (sector/tier labels + P n),
 *      so no setup reads "no sector".
 *   3. LIVE sort: priority DESC orders the live list (higher = take first).
 *   4. Header casing/spacing variant still parses.
 *   5. Graceful missing: a CSV without the columns → null fields, renders, no throw.
 *
 * Run:  npx tsx scripts/jack-sector-selftest.tsx
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyFilters, buildClientDecisions } from "../lib/jack/validation-core";
import { JackDecisionsTable, computeSetupContext } from "../components/bloomberg/views/jack-decisions-table";

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
const approx = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;

// Recent handle_low_date so rows survive the <=15d staleness filter.
const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

// Mirror the ingest selftest: parse → enrich → build the real client decisions.
function build(csv: string) {
  const { sectioned } = applyFilters(csv);
  const enrich = (arr: typeof sectioned.live) => arr.map((s) => ({ ...s, tiingo: {} }));
  const live = enrich(sectioned.live);
  const pending = enrich(sectioned.pending);
  const ed = (arr: typeof sectioned.live) =>
    arr.map((s) => ({ ticker: s.ticker, handle_low_date: s.handleLowDate, decision: "TRADE" }));
  const extracted = { live_decisions: ed(sectioned.live), pending_decisions: ed(sectioned.pending) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = buildClientDecisions(extracted as any, live as any, pending as any, [], new Map(), 2000);
  return { parsed: [...sectioned.live, ...sectioned.pending], out };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const find = (rows: any[], ticker: string) => rows.find((r) => r.ticker === ticker);

// ---- 1. Parse + join: two live rows carrying all three columns ----
console.log("\n[1] Parse + join (sector / tier / priority → client row)");
const csvFull = [
  "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level,sector,tier,priority",
  `KRC,just_fired,${recent},full,0.717,40,38,48,40.1,Financials,Q4,3.20`,
  `DORM,just_fired,${recent},full,0.70,100,96,120,100.5,Industrials,Q5,5.10`,
].join("\n");
const full = build(csvFull);
{
  const p = find(full.parsed, "KRC");
  check("parsed KRC sector === 'Financials'", p?.sector === "Financials", String(p?.sector));
  check("parsed KRC tier === 'Q4'", p?.tier === "Q4", String(p?.tier));
  check("parsed KRC priority ≈ 3.20", approx(p?.priority, 3.2), String(p?.priority));
  const c = find(full.out, "KRC");
  check("client KRC sector === 'Financials'", c?.sector === "Financials", String(c?.sector));
  check("client KRC tier === 'Q4'", c?.tier === "Q4", String(c?.tier));
  check("client KRC priority ≈ 3.20", approx(c?.priority, 3.2), String(c?.priority));
  const d = find(full.out, "DORM");
  check("client DORM sector/tier/priority", d?.sector === "Industrials" && d?.tier === "Q5" && approx(d?.priority, 5.1));
}

// ---- 2. Render: values on the collapsed row ----
console.log("\n[2] Render → collapsed row shows the tags");
const htmlFull = renderToStaticMarkup(
  React.createElement(JackDecisionsTable, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    decisions: full.out as any,
    isDarkMode: true,
    persistenceAvailable: true,
    individualCap: 200000,
  })
);
check("renders sector 'Financials'", htmlFull.includes("Financials"));
check("renders sector 'Industrials'", htmlFull.includes("Industrials"));
check("renders tier 'Q4'", htmlFull.includes("Q4"));
check("renders tier 'Q5'", htmlFull.includes("Q5"));

// ---- 3. LIVE sort by priority DESC (higher = take first) ----
console.log("\n[3] LIVE sort by priority DESC");
{
  const live = full.out.filter((d) => d.section === "live");
  check(
    "DORM (P 5.10) sorts before KRC (P 3.20)",
    live[0]?.ticker === "DORM" && live[1]?.ticker === "KRC",
    live.map((d) => d.ticker).join(",")
  );
}

// ---- 3b. Priority renders as an ORDINAL rank (P1 = best), not the raw float ----
console.log("\n[3b] Priority → ordinal rank P1/P2 (float untouched)");
{
  const iDorm = htmlFull.indexOf("DORM");
  const iKrc = htmlFull.indexOf("KRC");
  const iP1 = htmlFull.indexOf(">P1</span>");
  const iP2 = htmlFull.indexOf(">P2</span>");
  check("top-priority row (DORM, P 5.10) renders P1", iP1 !== -1 && iDorm < iP1 && iP1 < iKrc, `iDorm=${iDorm} iP1=${iP1} iKrc=${iKrc}`);
  check("next row (KRC, P 3.20) renders P2", iP2 !== -1 && iKrc < iP2, `iKrc=${iKrc} iP2=${iP2}`);
  check("raw priority floats no longer rendered (5.10 / 3.20 gone)", !htmlFull.includes("5.10") && !htmlFull.includes("3.20"));
  check("client-side priority FLOAT preserved (sort/persist key intact)", approx(find(full.out, "DORM")?.priority, 5.1) && approx(find(full.out, "KRC")?.priority, 3.2));
}

// ---- 4. Header casing / spacing variant still parses ----
console.log("\n[4] Quirky header (casing) still parses");
{
  const csvCased = [
    "Ticker,Status,Handle Low Date,Size Bucket,Handle Score,Entry,Stop,T05 Target,Breakout Level,Sector,TIER,Priority",
    `KRC,just_fired,${recent},full,0.717,40,38,48,40.1,Financials,Q4,3.20`,
  ].join("\n");
  const b = build(csvCased);
  const p = find(b.parsed, "KRC");
  check("'Sector' → sector 'Financials'", p?.sector === "Financials", String(p?.sector));
  check("'TIER' → tier 'Q4'", p?.tier === "Q4", String(p?.tier));
  check("'Priority' → priority ≈ 3.20", approx(p?.priority, 3.2), String(p?.priority));
}

// ---- 5. Graceful missing — no columns → null fields, renders, no throw ----
console.log("\n[5] Missing columns degrade gracefully");
{
  const csvBare = [
    "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level",
    `HOMB,just_fired,${recent},full,0.66,50,47,60,50.2`,
  ].join("\n");
  const b = build(csvBare);
  const p = find(b.parsed, "HOMB");
  check("missing sector → parsed undefined/null", p?.sector == null, String(p?.sector));
  check("missing tier → parsed undefined/null", p?.tier == null, String(p?.tier));
  check("missing priority → parsed undefined/null", p?.priority == null, String(p?.priority));
  const c = find(b.out, "HOMB");
  check("missing → client sector null", c?.sector === null, String(c?.sector));
  check("missing → client tier null", c?.tier === null, String(c?.tier));
  check("missing → client priority null", c?.priority === null, String(c?.priority));
  let threw = false;
  let html = "";
  try {
    html = renderToStaticMarkup(
      React.createElement(JackDecisionsTable, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        decisions: b.out as any,
        isDarkMode: true,
        persistenceAvailable: true,
        individualCap: 200000,
      })
    );
  } catch {
    threw = true;
  }
  check("renders without throwing", !threw && html.length > 0);
  check("HOMB row still present (ticker rendered)", html.includes("HOMB"));
}

// ---- 6. A TRADED (owned) LIVE row consumes NO P-number ----
console.log("\n[6] Owned (TRADED) live row excluded from P-rank numbering");
{
  // AAA has the HIGHEST priority but is owned (TRADED) → it must get no P-label and
  // consume no number; P1 goes to the best UN-traded setup (DORM).
  const csv = [
    "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level,sector,tier,priority",
    `AAA,just_fired,${recent},full,0.80,40,38,48,40.1,Financials,Q5,5.10`,
    `DORM,just_fired,${recent},full,0.70,100,96,120,100.5,Industrials,Q4,3.20`,
    `KRC,just_fired,${recent},full,0.66,50,47,60,50.2,Utilities,Q3,1.10`,
  ].join("\n");
  const b = build(csv); // sorted priority desc → [AAA(5.10), DORM(3.20), KRC(1.10)]
  const aaa = find(b.out, "AAA");
  if (aaa) aaa.userAction = "TRADED"; // mark the top-priority row owned
  const html = renderToStaticMarkup(
    React.createElement(JackDecisionsTable, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisions: b.out as any,
      isDarkMode: true,
      persistenceAvailable: true,
      individualCap: 200000,
    })
  );
  const iAAA = html.indexOf("AAA");
  const iDorm = html.indexOf("DORM");
  const iKrc = html.indexOf("KRC");
  const iP1 = html.indexOf(">P1</span>");
  const iP2 = html.indexOf(">P2</span>");
  check(
    "owned AAA (highest priority) renders NO P-label",
    iAAA !== -1 && iAAA < iDorm && !/>P\d<\/span>/.test(html.slice(iAAA, iDorm)),
    html.slice(iAAA, iDorm).slice(0, 60)
  );
  check("P1 = best UN-traded (DORM), not the owned AAA", iP1 !== -1 && iDorm < iP1 && iP1 < iKrc, `iDorm=${iDorm} iP1=${iP1} iKrc=${iKrc}`);
  check("P2 = next un-traded (KRC)", iP2 !== -1 && iKrc < iP2, `iKrc=${iKrc} iP2=${iP2}`);
  check("no P3 — the owned row consumed no number", !html.includes(">P3</span>"));
}

// ---- 7. Exited (closed) + firing LIVE row: "exited" marker + no P-rank ----
console.log("\n[7] Exited firing row shows 'exited' marker and gets no P-rank");
{
  const csv = [
    "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level,sector,tier,priority",
    `EXIT,just_fired,${recent},full,0.80,40,38,48,40.1,Financials,Q5,5.10`,
    `DORM,just_fired,${recent},full,0.70,100,96,120,100.5,Industrials,Q4,3.20`,
  ].join("\n");
  const b = build(csv); // sorted priority desc → [EXIT(5.10), DORM(3.20)]
  const ex = find(b.out, "EXIT");
  if (ex) {
    ex.userAction = "TRADED"; // traded...
    ex.userExitPrice = 44; // ...and exited (recorded exit) — closed, but firing again
    ex.userExitDate = "2026-07-20";
  }
  const html = renderToStaticMarkup(
    React.createElement(JackDecisionsTable, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisions: b.out as any,
      isDarkMode: true,
      persistenceAvailable: true,
      individualCap: 200000,
    })
  );
  const iExit = html.indexOf(">EXIT<");
  const iDorm = html.indexOf("DORM");
  check("exited row renders the 'exited' marker", html.includes(">exited</span>"));
  check(
    "exited (highest priority) row has NO P-label",
    iExit !== -1 && iExit < iDorm && !/>P\d<\/span>/.test(html.slice(iExit, iDorm)),
    html.slice(iExit, iDorm).slice(0, 60)
  );
  check("P1 goes to the un-traded DORM", html.includes(">P1</span>") && iDorm < html.indexOf(">P1</span>"));
  check("no P2 — only one un-traded row to rank", !html.includes(">P2</span>"));
}

// ---- 8. Handle/cup geometry plumbs to the client + the SETUP GEOMETRY / LEVELS
//        tokens compute correctly (percent-normalize round-trip + rendered text) ----
console.log("\n[8] Setup geometry round-trips + computeSetupContext tokens");
{
  // cup_depth_pct=32.0 (already percent → passes through), handle_retr_pct=0.45
  // (fraction < 1 → normalizeDepthPct ×100 → 45). entry/stop/target 40/38/48.
  const csv = [
    "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level,cup_depth_pct,handle_retr_pct",
    `KRC,just_fired,${recent},full,0.717,40,38,48,40.1,32.0,0.45`,
  ].join("\n");
  const b = build(csv);
  const c = find(b.out, "KRC");
  // Plumb: parsed geometry survives onto the client decision.
  check("client cupDepthPct === 32.0 (percent passes through)", c?.cupDepthPct === 32.0, String(c?.cupDepthPct));
  check("client handleRetrPct === 45 (fraction 0.45 → percent)", c?.handleRetrPct === 45, String(c?.handleRetrPct));
  check(
    "client daysSinceHandleLow ≈ 3 (derived from recent handle_low_date)",
    c?.daysSinceHandleLow != null && c.daysSinceHandleLow >= 2 && c.daysSinceHandleLow <= 4,
    String(c?.daysSinceHandleLow)
  );

  // Rendered tokens: the exact text the expand's SETUP GEOMETRY / LEVELS lines show.
  const { geometry, levels } = computeSetupContext(c);
  const levelText = levels.map((l) => l.text);
  check("geometry: cup depth 32.0%", geometry.includes("cup depth 32.0%"), geometry.join(" · "));
  check("geometry: handle retrace 45.0%", geometry.includes("handle retrace 45.0%"), geometry.join(" · "));
  check("geometry: 'Nd since handle low' present", geometry.some((g) => /^\d+d since handle low$/.test(g)), geometry.join(" · "));
  check("levels: to stop -5.0%", levelText.includes("to stop -5.0%"), levelText.join(" · "));
  check("levels: to target +20.0%", levelText.includes("to target +20.0%"), levelText.join(" · "));
  check("levels: R:R 4.0", levelText.includes("R:R 4.0"), levelText.join(" · "));
  // recShares = fullShares = floor(2000/(40-38)) = 1000 → risk $2,000, reward $8,000.
  check("levels: risk $2,000 (deployable size × stop distance)", levelText.includes("risk $2,000"), levelText.join(" · "));
  check("levels: reward $8,000 (deployable size × target distance)", levelText.includes("reward $8,000"), levelText.join(" · "));
  check("levels: no 'now … from entry' (no currentPrice in test)", !levelText.some((x) => x.startsWith("now ")), levelText.join(" · "));
}

// ---- 8b. SKIP fallback: recShares null/0 → $ figures use full-risk shares ----
console.log("\n[8b] SKIP row → risk/reward $ fall back to full-risk shares (never blank/$0)");
{
  // A skip-bucket row has recShares null; the $ figures must still show at full-risk size.
  const ctx = computeSetupContext({
    cupDepthPct: null,
    handleRetrPct: null,
    daysSinceHandleLow: null,
    entry: 40,
    stop: 38,
    target: 48,
    currentPrice: null,
    recShares: null, // SKIP — no recommended size
    fullShares: 1000, // full-risk size
  });
  const txt = ctx.levels.map((l) => l.text);
  check("SKIP: risk still shown at full-risk ($2,000)", txt.includes("risk $2,000"), txt.join(" · "));
  check("SKIP: reward still shown at full-risk ($8,000)", txt.includes("reward $8,000"), txt.join(" · "));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
