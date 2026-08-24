/*
 * JACK board-hydration self-test — proves a pipeline-ingested run is visible on a
 * fresh page load, and that the ACTIONABLE fields survive the DB round-trip.
 *
 * Run:  npx tsx scripts/jack-board-hydration-selftest.ts
 *
 * The bug this closes: the terminal rendered the board from the VALIDATE POST's
 * response body, held in a client-side Jotai atom. pipeline/ingest.py POSTs from
 * the VPS, so that response goes to a Python process — the run persisted, became
 * getCurrentRunId(), and the terminal showed the empty "paste CSV" state anyway.
 *
 * The acceptance bar is explicit: every field that drives SIZING or the
 * FRESH/AGING decision must hydrate. A blank there is not acceptable.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `   ${detail}` : ""}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "jack-hyd-"));
process.env.JACK_DB_PATH = join(tmp, "jack.db");

async function main(): Promise<void> {
  const { applyFilters } = await import("../lib/jack/validation-core");
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");
  const { computeSizing, normalizeSizeBucket } = await import("../lib/jack/handle-score");

  const iso = (d: number) => {
    const x = new Date(); x.setUTCDate(x.getUTCDate() - d); return x.toISOString().slice(0, 10);
  };
  const HL = iso(5), TODAY = iso(0);

  // A stamped watchlist, exactly what the pipeline ingests.
  const csv = [
    "ticker,status,size_bucket,tier,sector,priority,handle_score,handle_low_date," +
      "days_since_handle_low,entry,stop,t05_target,breakout_level,cup_depth_pct," +
      "handle_retr_pct,confirmed_close_date,days_since_confirm,entry_status",
    `FIREME,pending,full,Q5,Energy,0.91,0.72,${HL},5,101,95,110,100,18.5,32.1,${TODAY},0,FRESH`,
    `AGEDCO,pending,half,Q3,Financials,0.55,0.49,${HL},5,50,47,56,49.5,15.2,28.0,${iso(3)},3,AGING`,
  ].join("\n");

  const { sectioned } = applyFilters(csv);
  check("CSV parsed", sectioned.stats.totalFinal === 2, String(sectioned.stats.totalFinal));

  // --- persist exactly as the ingest route does ----------------------------
  const ts = `${TODAY}T23:00:00.000Z`;
  const idMap = new Map<string, number>();
  for (const s of [...sectioned.live, ...sectioned.pending]) {
    idMap.set(`${s.ticker}|${s.handleLowDate}`, write.upsertSetup({
      ticker: s.ticker, handleLowDate: s.handleLowDate, status: s.status,
      entry: s.entry, stop: s.stop, t05Target: s.t05Target, breakoutLevel: s.breakoutLevel,
      cupDepthPct: s.cupDepthPct, handleRetrPct: s.handleRetrPct,
      handleScore: s.handleScore, sizeBucket: s.sizeBucket, sector: s.sector,
      tier: s.tier, priority: s.priority,
      entryStatus: s.entryStatus, confirmedCloseDate: s.confirmedCloseDate,
      daysSinceConfirm: s.daysSinceConfirm,
      daysSinceHandleLow: Number.isFinite(s.daysSinceHandleLow) ? s.daysSinceHandleLow : undefined,
    }, ts));
  }
  const runId = write.insertValidationRun({
    timestamp: ts, inputRowCount: 2, totalFinalCount: 2, liveFinalCount: 0, pendingFinalCount: 2,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, model: "claude-sonnet-4-5",
    rawMarkdown: "", parseSuccess: true,
  });
  write.insertDecisions([...sectioned.live, ...sectioned.pending].map((s) => ({
    ticker: s.ticker, handleLowDate: s.handleLowDate, section: "pending" as const,
    decision: "TRADE", notes: "clean handle, no news", newsClass: "none",
    sectorRs: "in-line", crossAsset: "neutral", earningsFlag: "clear",
    pctToBreakout: 1.5, shares: 333, notional: 33633,
  })), runId, idMap);

  // --- what the hydration route reads back ---------------------------------
  console.log("\n=== the board round-trips from SQLite ===\n");
  const board = read.getCurrentBoard();
  check("getCurrentBoard resolves to the ingested run", board.runId === runId, String(board.runId));
  check("both rows present", board.pending.length === 2, String(board.pending.length));

  const meta = read.getRunMeta(board.runId!);
  check("getRunMeta returns the run's OWN riskPerTrade (2000)", meta?.riskPerTrade === 2000,
    String(meta?.riskPerTrade));

  const r = board.pending.find((x) => x.ticker === "FIREME")!;

  console.log("\n=== ACTIONABLE fields — a blank here is NOT acceptable ===\n");
  check("entry", r.entry === 101, String(r.entry));
  check("stop", r.stop === 95, String(r.stop));
  check("target (t05)", r.target === 110, String(r.target));
  check("breakout (rim)", r.breakout === 100, String(r.breakout));
  check("size_bucket", r.sizeBucket === "full", String(r.sizeBucket));
  check("tier", r.tier === "Q5", String(r.tier));
  check("handle_score", r.handleScore === 0.72, String(r.handleScore));
  check("priority (P-rank source)", r.priority === 0.91, String(r.priority));
  check("sector", r.sector === "Energy", String(r.sector));
  check("ENTRY_STATUS  (drives FRESH/AGING)", r.entryStatus === "FRESH", String(r.entryStatus));
  check("confirmed_close_date", r.confirmedCloseDate === TODAY, String(r.confirmedCloseDate));
  check("days_since_confirm", r.daysSinceConfirm === 0, String(r.daysSinceConfirm));
  check("cup_depth_pct", r.cupDepthPct === 18.5, String(r.cupDepthPct));
  check("handle_retr_pct", r.handleRetrPct === 32.1, String(r.handleRetrPct));

  const aged = board.pending.find((x) => x.ticker === "AGEDCO")!;
  check("AGING row keeps its own entry_status", aged.entryStatus === "AGING", String(aged.entryStatus));
  check("AGING row keeps its own bucket (half)", aged.sizeBucket === "half", String(aged.sizeBucket));

  console.log("\n=== sizing recomputes correctly from the run's own risk ===\n");
  const sizing = computeSizing(meta!.riskPerTrade, r.entry, r.stop);
  const bucket = normalizeSizeBucket(r.sizeBucket);
  const rec = bucket === "half" ? sizing.halfShares : bucket === "skip" ? null : sizing.fullShares;
  check("fullShares non-zero", (sizing.fullShares ?? 0) > 0, String(sizing.fullShares));
  check("recShares follows the bucket (full -> fullShares)", rec === sizing.fullShares, String(rec));
  const aSizing = computeSizing(meta!.riskPerTrade, aged.entry, aged.stop);
  check("half bucket -> halfShares", (aSizing.halfShares ?? 0) > 0 &&
    aSizing.halfShares !== aSizing.fullShares, `${aSizing.halfShares}/${aSizing.fullShares}`);

  console.log("\n=== COMMENTARY also round-trips (it was persisted all along) ===\n");
  check("notes", r.notes === "clean handle, no news", String(r.notes));
  check("news_class", r.newsClass === "none", String(r.newsClass));
  check("sector_rs", r.sectorRs === "in-line", String(r.sectorRs));
  check("cross_asset", r.crossAsset === "neutral", String(r.crossAsset));
  check("earnings_flag", r.earningsFlag === "clear", String(r.earningsFlag));
  check("pct_to_breakout", r.pctToBreakout === 1.5, String(r.pctToBreakout));
  check("shares", r.shares === 333, String(r.shares));

  console.log("\n=== fired state hydrates (drives the pending->LIVE re-section) ===\n");
  write.markDecisionFired(r.decisionId, {
    firedAt: TODAY, fireClose: 101.2, fireBar: 3, firedStatus: "confirmed",
  });
  const after = read.getCurrentBoard().pending.find((x) => x.ticker === "FIREME")!;
  check("fired_at", after.firedAt === TODAY, String(after.firedAt));
  check("fired_status", after.firedStatus === "confirmed", String(after.firedStatus));
  check("fire_close", after.fireClose === 101.2, String(after.fireClose));

  const { isInLiveDisplayGroup } = await import("../lib/jack/combine-decisions");
  const { isBasketEligible } = await import("../lib/jack/basket");
  check("hydrated fired row lands in the LIVE display group",
    isInLiveDisplayGroup(after as never));
  check("hydrated fired row is Basket-eligible (sizing works off it)",
    isBasketEligible(after as never));

  console.log("\n=== days_since_handle_low round-trips (no blank, no recompute) ===\n");
  check("persisted and read back as the CSV's 5", after.daysSinceHandleLow === 5,
    String(after.daysSinceHandleLow));
  console.log("       the CSV said 5 (handle low -> the data's ASOF last bar). Recomputing");
  console.log("       against today would drift the moment ingest and the last bar diverge.");

  console.log("\n=== every render field hydrates — no blanks left ===\n");
  const blanks = ([
    "entry", "stop", "target", "breakout", "sizeBucket", "tier", "handleScore",
    "priority", "sector", "entryStatus", "confirmedCloseDate", "daysSinceConfirm",
    "cupDepthPct", "handleRetrPct", "daysSinceHandleLow", "notes", "newsClass",
    "sectorRs", "crossAsset", "earningsFlag", "pctToBreakout", "shares",
    "firedAt", "firedStatus", "fireClose",
  ] as const).filter((k) => (after as unknown as Record<string, unknown>)[k] == null);
  check("no null/undefined among the 25 hydrated fields", blanks.length === 0, blanks.join(", "));
}

async function cleanup(): Promise<void> {
  try { (await import("../lib/db/init")).closeDb(); } catch { /* nothing open */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
}

main()
  .then(async () => {
    console.log(`\n${passed} passed, ${failed} failed`);
    await cleanup();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("\nSELFTEST CRASHED:", err);
    await cleanup();
    process.exit(1);
  });
