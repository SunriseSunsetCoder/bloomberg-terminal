/*
 * JACK scorecard self-test — metric math, small-n gating, the AI-overlay grouping,
 * the paper (theoretical) arm, the disagree cut, and the P-rank recomputation.
 *
 * Two layers:
 *   [PURE]  computeScorecard over hand-built rows, checked against hand-computed
 *           WR / avg R / PF / expectancy / drawdown values.
 *   [DB]    a real throwaway SQLite DB (JACK_DB_PATH) exercising getScorecardRows +
 *           getPriorityRanks against the actual schema and the real write path.
 *
 * No network, no Redis, no Telegram.
 *
 * Run:  npx tsx scripts/jack-scorecard-selftest.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScorecardRow } from "../lib/db/analytics";
import {
  computeScorecard,
  aiBucketFor,
  isRealizedTrade,
  isOpenRow,
  isResolvedRow,
  LOW_SAMPLE_THRESHOLD,
} from "../lib/jack/scorecard";
import { RAW_R_REFERENCE, CAPACITY_SIM_PF } from "../lib/jack/backtest-reference";

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
const near = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Row factory — only the fields the computation reads need to be meaningful.
// ---------------------------------------------------------------------------
let nextId = 1;
function row(p: Partial<ScorecardRow> = {}): ScorecardRow {
  const id = p.setupId ?? nextId++;
  return {
    setupId: id,
    ticker: p.ticker ?? `T${id}`,
    handleLowDate: p.handleLowDate ?? "2026-01-01",
    entry: 100,
    stop: 95,
    target: 115,
    breakout: 101,
    tier: null,
    priority: null,
    sector: null,
    fired: 1,
    exitReason: "target",
    rRealized: 2,
    maxFavorablePct: null,
    maxAdversePct: null,
    handleScore: null,
    sizeBucket: null,
    userAction: null,
    jackDecisionAtMark: null,
    userRRealized: null,
    userEntryPrice: null,
    userEntryDate: null,
    userExitPrice: null,
    userExitDate: null,
    latestDecision: null,
    latestSection: null,
    latestRunId: 1,
    ...p,
  };
}
/** A closed live trade with a realized R. */
const trade = (r: number, p: Partial<ScorecardRow> = {}) =>
  row({
    userAction: "TRADED",
    userRRealized: r,
    userEntryPrice: 100,
    userEntryDate: "2026-02-01",
    userExitPrice: 100 + r * 5,
    userExitDate: p.userExitDate ?? "2026-03-01",
    ...p,
  });
/** A paper-only setup: the AI called it, the user never traded it. */
const paper = (r: number, decision: string, p: Partial<ScorecardRow> = {}) =>
  row({ rRealized: r, exitReason: r >= 0 ? "target" : "stop", latestDecision: decision, latestSection: "live", ...p });

// ===========================================================================
console.log("\n[1] PURE — metric math on a hand-computed fixture");
// ===========================================================================
{
  // Realized R: +2, -1, +3, -1, +0.5  → sum 3.5 · n 5 · wins 3 → WR 0.6
  // gross win 5.5, gross loss 2.0 → PF 2.75 · avg R 0.7
  const rs = [2, -1, 3, -1, 0.5];
  const rows = rs.map((r, i) =>
    trade(r, { userExitDate: `2026-03-0${i + 1}`, ticker: `AA${i}` })
  );
  const s = computeScorecard(rows, new Map(), 2000, "2026-07-30");

  check("n = 5", s.live.realized.n === 5);
  check("win rate = 0.60", near(s.live.realized.winRate, 0.6));
  check("avg R = +0.70", near(s.live.realized.avgR, 0.7));
  check("PF = 2.75", near(s.live.realized.pf, 2.75));
  check("total R = +3.50", near(s.live.totalR, 3.5));
  check("total $ = 3.5 × 2000 = 7000", near(s.live.totalUsd, 7000));
  check("expectancy R = avg R", near(s.live.expectancyR, 0.7));
  check("expectancy $ = 1400", near(s.live.expectancyUsd, 1400));
  check("realizedTrades total = 5", s.totals.realizedTrades === 5);

  // Curve: cum 2, 1, 4, 3, 3.5 · peaks 2,2,4,4,4 → dd 0,-1,0,-1,-0.5
  check("curve length 5", s.live.curve.length === 5);
  check("curve cumR ends at 3.5", near(s.live.curve[4].cumR, 3.5));
  check("curve cumUsd ends at 7000", near(s.live.curve[4].cumUsd, 7000));
  check("max drawdown = 1.00R", near(s.live.maxDrawdownR, 1));
  check("current drawdown = 0.50R", near(s.live.currentDrawdownR, 0.5));
  check("curve ordered by exit date", s.live.curve.map((p) => p.date).join(",") === "2026-03-01,2026-03-02,2026-03-03,2026-03-04,2026-03-05");
}

// ===========================================================================
console.log("\n[2] PURE — PF edge cases");
// ===========================================================================
{
  const noLosers = computeScorecard([trade(1), trade(2)], new Map(), 2000).live.realized;
  check("no losers → PF null (∞), not a crash", noLosers.pf === null && noLosers.n === 2);
  const allLosers = computeScorecard([trade(-1), trade(-1)], new Map(), 2000).live.realized;
  check("all losers → PF 0", near(allLosers.pf, 0));
  check("all losers → WR 0", near(allLosers.winRate, 0));
  const empty = computeScorecard([], new Map(), 2000);
  check("empty input → n 0, no NaN", empty.live.realized.n === 0 && empty.live.totalR === 0);
  check("empty input → drawdowns 0", empty.live.maxDrawdownR === 0 && empty.live.currentDrawdownR === 0);
}

// ===========================================================================
console.log("\n[3] PURE — open positions and never-fired are excluded");
// ===========================================================================
{
  const open = row({ userAction: "TRADED", userEntryPrice: 100, exitReason: null, rRealized: null });
  const neverFired = row({ exitReason: "never_fired", rRealized: null, latestDecision: "TRADE", latestSection: "live" });
  const s = computeScorecard([trade(2), open, neverFired], new Map(), 2000);
  check("open row detected", isOpenRow(open));
  check("open excluded from realized n", s.live.realized.n === 1);
  check("open counted separately", s.live.openCount === 1 && s.totals.open === 1);
  check("never_fired not resolved", !isResolvedRow(neverFired));
  check("never_fired counted in totals", s.totals.neverFired === 1);
  const tradeBucket = s.ai.buckets.find((b) => b.key === "TRADE-full")!;
  check("never_fired shown on its AI bucket but out of R stats", tradeBucket.neverFired === 1 && tradeBucket.stat.n === 0);
}

// ===========================================================================
console.log("\n[4] PURE — small-n gating");
// ===========================================================================
{
  const mk = (n: number, r: number, decision: string) => Array.from({ length: n }, () => paper(r, decision));
  // 29 vs 29 → suppressed; 30 vs 30 → read appears.
  const under = computeScorecard([...mk(29, 1, "TRADE"), ...mk(29, -1, "SKIP")], new Map(), 2000);
  check(`n=29 both arms → read SUPPRESSED (threshold ${LOW_SAMPLE_THRESHOLD})`, under.ai.readSuppressed && under.ai.read === null);
  check("suppressed run names both short buckets", under.ai.insufficient.length === 2);

  const over = computeScorecard([...mk(30, 1, "TRADE"), ...mk(30, -1, "SKIP")], new Map(), 2000);
  check("n=30 both arms → read RENDERED", !over.ai.readSuppressed && over.ai.read !== null);
  check("read says the overlay HELPED (+1R trades vs -1R skips)", !!over.ai.read?.includes("HELPED"));

  const oneShort = computeScorecard([...mk(30, 1, "TRADE"), ...mk(29, -1, "SKIP")], new Map(), 2000);
  check("one arm short → still suppressed", oneShort.ai.readSuppressed);
  check("the short arm is named", oneShort.ai.insufficient.join() === "SKIP");

  check("lowSample flag set under threshold", under.ai.buckets.find((b) => b.key === "SKIP")!.stat.lowSample);
  check("lowSample flag clear at threshold", !over.ai.buckets.find((b) => b.key === "SKIP")!.stat.lowSample);

  // Direction of the read
  const hurt = computeScorecard([...mk(30, -0.5, "TRADE"), ...mk(30, 1.5, "SKIP")], new Map(), 2000);
  check("skips outperforming trades → read says HURT", !!hurt.ai.read?.includes("HURT"));
  const flat = computeScorecard([...mk(30, 1, "TRADE"), ...mk(30, 1.05, "SKIP")], new Map(), 2000);
  check("arms within 0.10R → read says NO SIGNAL", !!flat.ai.read?.includes("NO SIGNAL"));
}

// ===========================================================================
console.log("\n[5] PURE — AI bucket mapping + latest-call grouping");
// ===========================================================================
{
  check("TRADE → TRADE-full", aiBucketFor("TRADE") === "TRADE-full");
  check("SIZE DOWN 50% → SIZE-DOWN", aiBucketFor("SIZE DOWN 50%") === "SIZE-DOWN");
  check("SKIP → SKIP", aiBucketFor("SKIP") === "SKIP");
  check("INVALIDATED → other", aiBucketFor("INVALIDATED") === "other");
  check("ALREADY EXTENDED → other", aiBucketFor("ALREADY EXTENDED") === "other");
  check("WATCH → other", aiBucketFor("WATCH") === "other");
  check("null → other", aiBucketFor(null) === "other");

  const s = computeScorecard(
    [
      paper(2, "TRADE"),
      paper(-1, "SIZE DOWN 50%"),
      paper(3, "SKIP"),
      row({ rRealized: 1, latestDecision: "WATCH", latestSection: "pending" }),
    ],
    new Map(),
    2000
  );
  check("live buckets carry only live-section rows", s.ai.buckets.reduce((n, b) => n + b.stat.n, 0) === 3);
  check("pending call kept out of the headline buckets", s.ai.buckets.find((b) => b.key === "other")!.stat.n === 0);
  check("pending bucket present and populated", s.ai.pendingBuckets.length === 1 && s.ai.pendingBuckets[0].stat.n === 1);
  check("pending bucket keeps the raw wording", s.ai.pendingBuckets[0].key === "WATCH");
}

// ===========================================================================
console.log("\n[6] PURE — signals-disagree cut");
// ===========================================================================
{
  const s = computeScorecard(
    [
      paper(2, "TRADE", { sizeBucket: "skip" }), // hard conflict: TRADE vs handle SKIP
      paper(-1, "SKIP", { sizeBucket: "full" }), // hard conflict: SKIP vs handle FULL
      paper(1, "TRADE", { sizeBucket: "full" }), // agree
      paper(1, "SIZE DOWN 50%", { sizeBucket: "full" }), // caution vs pos → NOT a conflict
      paper(1, "TRADE", { sizeBucket: null }), // no handle signal → out of the cut entirely
    ],
    new Map(),
    2000
  );
  check("flagged n = 2", s.ai.disagree.flagged.n === 2);
  check("agreed n = 2 (caution pair counts as agreement)", s.ai.disagree.agreed.n === 2);
  check("TRADE+handle-SKIP sub-cut n = 1", s.ai.disagree.tradeVsHandleSkip.n === 1);
  check("SKIP+handle-FULL sub-cut n = 1", s.ai.disagree.skipVsHandleFull.n === 1);
  check("TRADE+handle-SKIP avg R = +2", near(s.ai.disagree.tradeVsHandleSkip.avgR, 2));
  check("rows with no handle bucket excluded from the cut", s.ai.disagree.flagged.n + s.ai.disagree.agreed.n === 4);
}

// ===========================================================================
console.log("\n[7] PURE — tier cuts carry the frozen reference");
// ===========================================================================
{
  const s = computeScorecard(
    [trade(2, { tier: "Q5" }), trade(-1, { tier: "Q3" }), trade(1, { tier: "q4" }), trade(1, { tier: null })],
    new Map(),
    2000
  );
  const q5 = s.live.byTier.find((t) => t.key === "Q5")!;
  const q4 = s.live.byTier.find((t) => t.key === "Q4")!;
  const un = s.live.byTier.find((t) => t.key === "unclassified")!;
  check("Q5 cut picks up its row", q5.stat.n === 1);
  check("lowercase tier normalizes to Q4", q4.stat.n === 1);
  check("null tier → unclassified", un.stat.n === 1 && un.reference === null);
  check("Q5 reference = frozen 4.54 PF", near(q5.reference?.pf, RAW_R_REFERENCE.byTier.Q5.pf));
  check("Q3 reference = frozen 1.93 PF", near(s.live.byTier.find((t) => t.key === "Q3")!.reference?.pf, 1.93));
  check("overall reference = raw-R 2.90 PF / +0.56R / 70%", near(s.reference.rawR.overall.pf, 2.9) && near(s.reference.rawR.overall.avgR, 0.56) && near(s.reference.rawR.overall.winRate, 0.7));
  check("capacity-sim PF carried separately, NOT as the bar", s.reference.capacitySim.is === 2.09 && s.reference.capacitySim.oos === 1.7 && CAPACITY_SIM_PF.label.includes("capacity sim"));
  check("reference basis states the population", s.reference.rawR.basis.includes("Q3-5 traded"));
}

// ===========================================================================
console.log("\n[8] PURE — theoretical arm + paper assumptions surfaced");
// ===========================================================================
{
  // Same trade, realized +0.5 but the setup offered +2 → execution gap, not edge.
  const s = computeScorecard([trade(0.5, { rRealized: 2, exitReason: "target" })], new Map(), 2000);
  check("realized arm uses user R", near(s.live.realized.avgR, 0.5));
  check("theoretical arm uses replay R on the same trade", near(s.live.theoretical.avgR, 2));
  check("paper assumptions include the next-day-open entry rule", s.paperAssumptions.some((a) => a.includes("NEXT DAY")));
  check("paper assumptions include tie=stop-first", s.paperAssumptions.some((a) => a.includes("stop first")));
  check("paper assumptions include the 130-day window", s.paperAssumptions.some((a) => a.includes("130")));
}

// ===========================================================================
// [DB] real schema + real writes
// ===========================================================================
const dir = mkdtempSync(join(tmpdir(), "jack-scorecard-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

async function dbLayer(): Promise<void> {
  console.log("\n[9] DB — getScorecardRows + getPriorityRanks against the real schema");
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");
  const { getScorecardRows, getPriorityRanks } = await import("../lib/db/analytics");

  const HLD = "2026-01-05";
  const meta = (t: string, n: number) => ({
    timestamp: t, inputRowCount: n, totalFinalCount: n, liveFinalCount: n, pendingFinalCount: n,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, parseSuccess: true,
  });

  // Run 1: four LIVE setups with distinct priorities + one PENDING.
  const defs = [
    { t: "AAA", dec: "TRADE", sec: "live" as const, tier: "Q5", prio: 9.5, bucket: "full" },
    { t: "BBB", dec: "SKIP", sec: "live" as const, tier: "Q3", prio: 7.0, bucket: "full" },
    { t: "CCC", dec: "SIZE DOWN 50%", sec: "live" as const, tier: "Q4", prio: 3.2, bucket: "half" },
    { t: "DDD", dec: "TRADE", sec: "live" as const, tier: "Q4", prio: 1.1, bucket: "skip" },
    { t: "EEE", dec: "WATCH", sec: "pending" as const, tier: "Q5", prio: 8.0, bucket: "full" },
  ];
  const map = new Map<string, number>();
  for (const d of defs) {
    map.set(`${d.t}|${HLD}`, write.upsertSetup({
      ticker: d.t, handleLowDate: HLD, status: d.sec === "live" ? "just_fired" : "pending",
      entry: 100, stop: 95, t05Target: 115, breakoutLevel: 101,
      tier: d.tier, priority: d.prio, sizeBucket: d.bucket, handleScore: 0.7,
    }, "2026-01-06T12:00:00.000Z"));
  }
  const runId = write.insertValidationRun(meta("2026-01-06T12:00:00.000Z", defs.length));
  const { ids } = write.insertDecisions(
    defs.map((d) => ({ ticker: d.t, handleLowDate: HLD, section: d.sec, decision: d.dec })),
    runId, map
  );

  // AAA traded and closed: entry 101, exit 111, stop 95 → user R = 10/6 = 1.666…
  read.markDecisionUserAction(ids.find((i) => i.ticker === "AAA")!.decisionId, "TRADED");
  write.updateUserFills(map.get(`AAA|${HLD}`)!, 101, "2026-01-07", 111, "2026-02-20");
  // BBB traded and still OPEN (entry, no exit) — must be excluded from realized.
  read.markDecisionUserAction(ids.find((i) => i.ticker === "BBB")!.decisionId, "TRADED");
  write.updateUserFills(map.get(`BBB|${HLD}`)!, 100, "2026-01-08", null, null);
  // Paper (replay) outcomes for everything.
  for (const d of defs) {
    write.insertOutcome({
      setupId: map.get(`${d.t}|${HLD}`)!, fired: true,
      exitReason: d.t === "CCC" ? "stop" : "target",
      rRealized: d.t === "CCC" ? -1 : 2.4, outcomeSource: "tiingo_replay",
    });
  }

  const rows = getScorecardRows();
  const ranks = getPriorityRanks();
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));

  check("one row per setup with an outcome", rows.length === 5);
  check("AAA carries its latest AI decision", byTicker.get("AAA")!.latestDecision === "TRADE");
  check("CCC carries SIZE DOWN 50%", byTicker.get("CCC")!.latestDecision === "SIZE DOWN 50%");
  check("EEE section is pending", byTicker.get("EEE")!.latestSection === "pending");
  check("tier/priority/sizeBucket read through", byTicker.get("AAA")!.tier === "Q5" && byTicker.get("AAA")!.priority === 9.5 && byTicker.get("AAA")!.sizeBucket === "full");
  check("AAA user R computed by the write path", near(byTicker.get("AAA")!.userRRealized, 10 / 6, 1e-9));

  // P-rank: LIVE only, ranked by priority DESC → AAA(9.5)=1, BBB(7.0)=2, CCC(3.2)=3, DDD(1.1)=4.
  // EEE is pending → unranked even though its priority (8.0) would place it 2nd.
  check("P-rank AAA = 1", ranks.get(map.get(`AAA|${HLD}`)!) === 1);
  check("P-rank BBB = 2", ranks.get(map.get(`BBB|${HLD}`)!) === 2);
  check("P-rank CCC = 3", ranks.get(map.get(`CCC|${HLD}`)!) === 3);
  check("P-rank DDD = 4", ranks.get(map.get(`DDD|${HLD}`)!) === 4);
  check("pending setup gets no P-rank", ranks.get(map.get(`EEE|${HLD}`)!) === undefined);

  const s = computeScorecard(rows, ranks, 2000, "2026-07-30");
  check("realized arm = AAA only (BBB still open)", s.live.realized.n === 1 && isRealizedTrade(byTicker.get("AAA")!));
  // BBB is held with no recorded exit → OPEN, even though the replay resolved the
  // SETUP long ago. Open = user state, not replay state (matches the board's rule).
  check("open position counted, not scored", s.live.openCount === 1 && isOpenRow(byTicker.get("BBB")!));
  check("open position still excluded from the realized arm", !isRealizedTrade(byTicker.get("BBB")!));
  check("open position's PAPER outcome still counts in the AI arm", s.ai.buckets.find((b) => b.key === "SKIP")!.stat.n === 1);
  check("AAA lands in the P1 bucket", s.live.byPRank.find((p) => p.key === "P1")!.stat.n === 1);
  check("AAA lands in the Q5 tier cut", s.live.byTier.find((t) => t.key === "Q5")!.stat.n === 1);
  check("AI buckets cover the 4 live setups", s.ai.buckets.reduce((n, b) => n + b.stat.n, 0) === 4);
  check("SKIP bucket holds BBB's paper R", near(s.ai.buckets.find((b) => b.key === "SKIP")!.stat.avgR, 2.4));
  check("SIZE-DOWN bucket holds CCC's -1R", near(s.ai.buckets.find((b) => b.key === "SIZE-DOWN")!.stat.avgR, -1));
  check("DDD (TRADE + handle skip) shows in the disagree cut", s.ai.disagree.tradeVsHandleSkip.n === 1);
  check("everything is still gated (n well under 30)", s.ai.readSuppressed && s.live.realized.lowSample);

  // Re-validating in a LATER run must move the setup to its newest call + rank.
  console.log("\n[10] DB — a setup in several runs uses its LATEST call and rank");
  const run2 = write.insertValidationRun(meta("2026-02-06T12:00:00.000Z", 2));
  write.insertDecisions(
    [
      { ticker: "DDD", handleLowDate: HLD, section: "live", decision: "SKIP" },
      { ticker: "AAA", handleLowDate: HLD, section: "live", decision: "TRADE" },
    ],
    run2,
    map
  );
  const rows2 = getScorecardRows();
  const ranks2 = getPriorityRanks();
  const ddd = rows2.find((r) => r.ticker === "DDD")!;
  check("DDD's latest decision is now SKIP", ddd.latestDecision === "SKIP");
  check("DDD's run id is the newer run", ddd.latestRunId === run2);
  check("DDD re-ranks within run 2 (AAA 9.5 → 1, DDD 1.1 → 2)", ranks2.get(map.get(`DDD|${HLD}`)!) === 2);
  const s2 = computeScorecard(rows2, ranks2, 2000, "2026-07-30");
  check("DDD counts once, under SKIP", s2.ai.buckets.find((b) => b.key === "SKIP")!.stat.n === 2);
  check("total live-bucket n is unchanged (no double count)", s2.ai.buckets.reduce((n, b) => n + b.stat.n, 0) === 4);
}

dbLayer()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });
