/*
 * JACK handle_score INGEST self-test — proves parseCsvRow reads size_bucket +
 * handle_score from the scanner CSV and they survive into the built client
 * decision. Regression guard for the "pill never rendered" bug: the ingest was
 * dropping these two columns because the by-name lookup was an exact indexOf,
 * brittle to header quoting / casing / BOM / spacing. The lookup is now normalized.
 *
 * Run:  npx tsx scripts/jack-handle-score-ingest-selftest.ts
 */
import { applyFilters, buildClientDecisions } from "../app/api/jack-validation/route";

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

// Recent handle_low_date so the row survives the <=15d staleness filter.
const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

// Build EnrichedSetup[] + a matching LLM "extracted" from parsed setups, then run
// the real buildClientDecisions — mirroring the production path end to end.
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

// ---- 1. Clean header (baseline — must keep working) ----
console.log("\n[1] Clean comma header");
{
  const csv = [
    "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level",
    `KRC,just_fired,${recent},full,0.717,40,38,48,40.1`,
  ].join("\n");
  const { parsed, out } = build(csv);
  const krc = parsed.find((p) => p.ticker === "KRC")!;
  check("parsed KRC handleScore ≈ 0.717", approx(krc.handleScore, 0.717), String(krc.handleScore));
  check("parsed KRC sizeBucket === 'full'", krc.sizeBucket === "full", String(krc.sizeBucket));
  const d = out.find((r) => r.ticker === "KRC")!;
  check("built decision handleScore ≈ 0.717", approx(d.handleScore, 0.717), String(d.handleScore));
  check("built decision sizeBucket === 'full'", d.sizeBucket === "full", String(d.sizeBucket));
}

// ---- 2. Quirky header: BOM + quoted + mixed-case names (the FIX) ----
// Exact indexOf("size_bucket") / indexOf("handle_score") FAILS here; normalized
// matching (strip BOM, strip quotes, lowercase, space/hyphen→underscore) succeeds.
console.log("\n[2] Quirky header — BOM + quoted + mixed case (regression for the drop)");
{
  const csv = [
    `﻿ticker,status,handle_low_date,"Size_Bucket","Handle_Score",entry,stop,t05_target,breakout_level`,
    `KRC,just_fired,${recent},full,0.717,40,38,48,40.1`,
  ].join("\n");
  const { parsed, out } = build(csv);
  const krc = parsed.find((p) => p.ticker === "KRC")!;
  check("parsed KRC handleScore ≈ 0.717 (quirky header)", approx(krc.handleScore, 0.717), String(krc.handleScore));
  check("parsed KRC sizeBucket === 'full' (quirky header)", krc.sizeBucket === "full", String(krc.sizeBucket));
  const d = out.find((r) => r.ticker === "KRC")!;
  check("built decision handleScore ≈ 0.717 (quirky header)", approx(d.handleScore, 0.717), String(d.handleScore));
  check("built decision sizeBucket === 'full' (quirky header)", d.sizeBucket === "full", String(d.sizeBucket));
  // BOM must not corrupt the first column either.
  check("BOM stripped — ticker still 'KRC'", krc.ticker === "KRC", krc.ticker);
}

// ---- 3. Space/hyphen header variants ----
console.log("\n[3] Header name variants (space / hyphen → underscore)");
{
  const csv = [
    `ticker,status,handle_low_date,size bucket,handle-score,entry,stop,t05_target,breakout_level`,
    `DORM,just_fired,${recent},half,0.540,100,96,120,100.5`,
  ].join("\n");
  const { parsed } = build(csv);
  const d = parsed.find((p) => p.ticker === "DORM")!;
  check("'size bucket' → sizeBucket 'half'", d.sizeBucket === "half", String(d.sizeBucket));
  check("'handle-score' → handleScore ≈ 0.540", approx(d.handleScore, 0.54), String(d.handleScore));
}

// ---- 4. Blank handle_score cell → handleScore null, gate hides pill ----
console.log("\n[4] Blank score cell → null (render gate hides pill)");
{
  const csv = [
    "ticker,status,handle_low_date,size_bucket,handle_score,entry,stop,t05_target,breakout_level",
    `VTRS,just_fired,${recent},,,20,19,26,20.1`,
  ].join("\n");
  const { parsed } = build(csv);
  const d = parsed.find((p) => p.ticker === "VTRS")!;
  check("blank score → handleScore undefined/null", d.handleScore == null, String(d.handleScore));
  check("blank bucket → sizeBucket undefined/null", d.sizeBucket == null, String(d.sizeBucket));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
