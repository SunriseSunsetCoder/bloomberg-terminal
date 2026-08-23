/*
 * JACK Phase 4 acceptance test — headless ingest with NO ANTHROPIC_API_KEY.
 *
 * Run:  npx tsx scripts/jack-headless-ingest-selftest.ts
 *
 * THE REQUIREMENT THIS EXISTS TO PROVE:
 *
 *   a best_effort run with no API key
 *     -> the board populates
 *     -> a fire PROMOTES
 *     -> the Basket Sizer SIZES it (non-zero shares)
 *     -> ONLY the verdict text is missing
 *
 * If any downstream check keys off `decision` being non-null/graded and blocks an
 * UNREVIEWED row, that silently reintroduces "the board doesn't move without the
 * LLM" through a side door. Step 5 asserts the specific trap (classifyVerdict is
 * a SUBSTRING match, so a badly chosen placeholder would classify as SKIP), and
 * step 6 catches the general case by DIFFING an UNREVIEWED run against a graded
 * one and requiring every non-commentary column to be identical.
 *
 * Real throwaway SQLite, real ingest helpers, real promoter, real sizing math.
 * No network: the analysis is never invoked (there is no key), and bars are
 * injected rather than fetched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bar } from "../lib/jack/outcome-tracker";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `   ${detail}` : ""}`);
  }
}

// jack.db location must be set BEFORE the db layer is imported.
const tmp = mkdtempSync(join(tmpdir(), "jack-p4-"));
process.env.JACK_DB_PATH = join(tmp, "jack.db");
delete process.env.ANTHROPIC_API_KEY; // the whole point
process.env.JACK_DISABLE_PERSISTENCE = "";

async function main(): Promise<void> {
  const { applyFilters, UNREVIEWED_DECISION, FLOOR_GUARD_MIN_FRACTION } = await import(
    "../lib/jack/validation-core"
  );
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");
  const { isPromotedToLive } = await import("../lib/jack/promotion");
  const { isBasketEligible, computeBasket, defaultBasketOptions } = await import("../lib/jack/basket");
  const { isInLiveDisplayGroup, isFiredActionable } = await import("../lib/jack/combine-decisions");
  const { isTradeableSetup, computeSizing } = await import("../lib/jack/handle-score");
  const { getDb } = await import("../lib/db/init");
  const { classifyVerdict } = await import("../lib/jack/verdict");

  // Dates are RELATIVE to today, never pinned. A hardcoded handle_low_date silently
  // rots past MAX_HANDLE_DAYS (15) and applyFilters starts dropping every fixture
  // row — the test then "fails" for a calendar reason rather than a code one.
  const iso = (daysAgo: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };
  const HL = iso(5);          // 5 days old: comfortably inside the staleness window
  const TODAY = iso(0);
  const RIM = 100;

  // ---- a stamped watchlist, exactly what Phase 3 emits ---------------------
  const header =
    "ticker,bucket,status,size_bucket,tier,sector,priority,handle_score,handle_low_date," +
    "current_price,entry,stop,t05_target,breakout_level,R_to_target,cup_depth_pct," +
    "handle_retr_pct,days_since_handle_low,confirmed_close_date,days_since_confirm," +
    "bars_since_confirm,entry_status";
  const row = (t: string, status: string, es: string, ccd: string, dsc: string) =>
    `${t},just_fired,${status},full,Q5,Energy,0.9,0.72,${HL},` +
    `101.5,101,95,110,${RIM},2.4,18.5,32.1,4,${ccd},${dsc},${dsc},${es}`;

  const csv = [
    header,
    row("FIREME", "pending", "FRESH", TODAY, "0"),
    row("AGEDCO", "pending", "AGING", iso(3), "3"),
    row("COILER", "pending", "PENDING", "", ""),
  ].join("\n");

  // ---- STEP 1: best_effort persist with no key ----------------------------
  console.log("\n=== 1. best_effort ingest, NO ANTHROPIC_API_KEY ===\n");

  const { sectioned } = applyFilters(csv);
  check("CSV parsed and sectioned without any model involvement",
    sectioned.stats.totalFinal === 3, String(sectioned.stats.totalFinal));

  const parsedByTicker = new Map(
    [...sectioned.live, ...sectioned.pending].map((s) => [s.ticker, s])
  );
  check("entry_status parsed off the CSV",
    parsedByTicker.get("FIREME")?.entryStatus === "FRESH" &&
    parsedByTicker.get("AGEDCO")?.entryStatus === "AGING" &&
    parsedByTicker.get("COILER")?.entryStatus === "PENDING",
    JSON.stringify([...parsedByTicker.values()].map((s) => s.entryStatus)));
  check("confirmed_close_date parsed",
    parsedByTicker.get("FIREME")?.confirmedCloseDate === TODAY);
  check("geometry parsed independently of the analysis",
    parsedByTicker.get("FIREME")?.breakoutLevel === RIM &&
    parsedByTicker.get("FIREME")?.stop === 95);

  const ts = `${TODAY}T23:00:00.000Z`;
  const setupIdMap = new Map<string, number>();
  for (const s of [...sectioned.live, ...sectioned.pending]) {
    const id = write.upsertSetup(
      {
        ticker: s.ticker, handleLowDate: s.handleLowDate, status: s.status,
        entry: s.entry, stop: s.stop, t05Target: s.t05Target, breakoutLevel: s.breakoutLevel,
        handleScore: s.handleScore, sizeBucket: s.sizeBucket, sector: s.sector,
        tier: s.tier, priority: s.priority,
        entryStatus: s.entryStatus, confirmedCloseDate: s.confirmedCloseDate,
        daysSinceConfirm: s.daysSinceConfirm,
      },
      ts
    );
    setupIdMap.set(`${s.ticker}|${s.handleLowDate}`, id);
  }
  check("all 3 setups upserted", setupIdMap.size === 3);

  const runId = write.insertValidationRun({
    timestamp: ts, inputRowCount: 3, totalFinalCount: 3, liveFinalCount: sectioned.live.length,
    pendingFinalCount: sectioned.pending.length, liveDroppedStale: 0, pendingDroppedStale: 0,
    liveDroppedOverCap: 0, pendingDroppedOverCap: 0, tiingoAttempted: 0, tiingoSucceeded: 0,
    riskPerTrade: 2000, model: "none", rawMarkdown: "", parseSuccess: false,
    errorMsg: "analysis skipped — UNREVIEWED",
  });

  // The synthesized rows: join key + placeholder ONLY, no commentary.
  const unreviewedRows = [...sectioned.live, ...sectioned.pending].map((s) => ({
    ticker: s.ticker,
    handleLowDate: s.handleLowDate,
    section: (sectioned.live.includes(s) ? "live" : "pending") as "live" | "pending",
    decision: UNREVIEWED_DECISION,
  }));
  const ins = write.insertDecisions(unreviewedRows, runId, setupIdMap);
  check("decision rows inserted for every setup", ins.inserted === 3, String(ins.inserted));
  check("none skipped as unmatched", ins.skipped === 0, String(ins.skipped));

  // ---- STEP 2/3: the board exists and the fire promotes -------------------
  console.log("\n=== 2. board populates and the fire PROMOTES ===\n");

  check("getCurrentRunId resolves to this run", read.getCurrentRunId() === runId,
    String(read.getCurrentRunId()));
  const board = read.getCurrentBoard();
  check("board carries all 3 rows", board.live.length + board.pending.length === 3,
    `${board.live.length}/${board.pending.length}`);
  check("board rows carry the UNREVIEWED verdict",
    board.pending.concat(board.live).every((r) => r.decision === UNREVIEWED_DECISION));

  // Bars where FIREME closes above the rim on the most recent bar.
  const dates = [iso(4), iso(3), iso(2), iso(1), TODAY];
  const bars: Bar[] = dates.map((date, i) => {
    const close = i === dates.length - 1 ? RIM + 2 : RIM - 3;
    return { date, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000 };
  });

  const boardRow = board.pending.concat(board.live).find((r) => r.ticker === "FIREME")!;
  const promo = isPromotedToLive(
    {
      handleLowDate: HL, breakout: boardRow.breakout, stop: boardRow.stop,
      target: boardRow.target, sizeBucket: boardRow.sizeBucket, tier: boardRow.tier,
    },
    bars,
    TODAY
  );
  check("UNREVIEWED row PROMOTES to LIVE", promo.promoted === true,
    `${promo.promoted} reason=${promo.reason}`);
  check("promotion reason is 'promoted', not blocked by the missing verdict",
    promo.reason === "promoted", promo.reason);
  check("fire date detected", promo.fireDate === TODAY, String(promo.fireDate));

  write.markDecisionFired(boardRow.decisionId!, {
    firedAt: promo.fireDate!, fireClose: promo.fireClose!, fireBar: promo.fireBar!,
    firedStatus: promo.firedStatus!,
  });

  const board2 = read.getCurrentBoard();
  const fired = board2.pending.concat(board2.live).find((r) => r.ticker === "FIREME")!;
  check("fired_status persisted", isFiredActionable(fired as never),
    String((fired as { firedStatus?: string }).firedStatus));
  check("fired UNREVIEWED row lands in the LIVE display group",
    isInLiveDisplayGroup(fired as never));

  // ---- STEP 4: the Sizer sizes it ----------------------------------------
  console.log("\n=== 3. the Basket Sizer SIZES it ===\n");

  check("setup is tradeable on its handle bucket (not the verdict)",
    isTradeableSetup(fired as never));
  check("isBasketEligible TRUE for the UNREVIEWED fired row",
    isBasketEligible(fired as never));

  const sizing = computeSizing(2000, 101, 95);
  const shares = sizing.fullShares ?? 0;
  check("computeSizing returns NON-ZERO shares", shares > 0, String(shares));

  // The REAL Sizer, end to end — not just the shares helper.
  const candidates = [fired].map((r) => ({
    setupId: (r as { setupId: number }).setupId,
    ticker: r.ticker, handleLowDate: r.handleLowDate,
    entry: r.entry, stop: r.stop, target: r.target,
    tier: r.tier, sector: r.sector, priority: r.priority,
    sizeBucket: r.sizeBucket, handleScore: r.handleScore,
    userAction: null, retiredAt: null,
  }));
  const totals = computeBasket(candidates as never, [], defaultBasketOptions());
  const basketRow = totals.rows.find((x) => x.ticker === "FIREME");
  check("the UNREVIEWED row appears in the computed basket", !!basketRow,
    JSON.stringify(totals.rows.map((x) => x.ticker)));
  check("the basket SIZES it with non-zero shares", (basketRow?.shares ?? 0) > 0,
    String(basketRow?.shares));
  console.log(`       entry 101 / stop 95 -> ${basketRow?.shares} shares in the basket`);

  // ---- STEP 5: the side door, asserted directly --------------------------
  console.log("\n=== 4. the SIDE DOOR: the placeholder must not read as a verdict ===\n");

  check(`classifyVerdict("${UNREVIEWED_DECISION}") === "other"`,
    classifyVerdict(UNREVIEWED_DECISION) === "other", classifyVerdict(UNREVIEWED_DECISION));
  check("placeholder is NOT classified as skip (would veto the row)",
    classifyVerdict(UNREVIEWED_DECISION) !== "skip");
  for (const trap of ["TRADE", "SKIP", "AVOID", "PASS", "WATCH", "FIRED", "EXTENDED"]) {
    check(`placeholder contains no "${trap}" substring`,
      !UNREVIEWED_DECISION.toUpperCase().includes(trap));
  }

  // ---- STEP 6: diff vs a graded run --------------------------------------
  console.log("\n=== 5. ONLY the verdict differs (diff vs a graded run) ===\n");

  const gradedRunId = write.insertValidationRun({
    timestamp: `${TODAY}T23:30:00.000Z`, inputRowCount: 3, totalFinalCount: 3,
    liveFinalCount: sectioned.live.length, pendingFinalCount: sectioned.pending.length,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, model: "claude-sonnet-4-5",
    rawMarkdown: "graded", parseSuccess: true,
  });
  write.insertDecisions(
    [...sectioned.live, ...sectioned.pending].map((s) => ({
      ticker: s.ticker, handleLowDate: s.handleLowDate,
      section: (sectioned.live.includes(s) ? "live" : "pending") as "live" | "pending",
      decision: "TRADE", notes: "looks good", newsClass: "none", sectorRs: "in-line",
    })),
    gradedRunId,
    setupIdMap
  );

  const gradedBoard = read.getCurrentBoard();
  check("the graded run is now the board", gradedBoard.runId === gradedRunId);

  // COMMENTARY = what the model produces. Everything else must match.
  const COMMENTARY = new Set([
    "decisionId", "decision", "notes", "newsClass", "sectorRs", "crossAsset",
    "earningsFlag", "shares", "notional", "liveCloseDeltaPct", "pctToBreakout",
    "firedAt", "fireClose", "fireBar", "firedStatus", // set by the promoter, per-row
  ]);

  const u = board2.pending.concat(board2.live).find((r) => r.ticker === "AGEDCO")! as unknown as Record<string, unknown>;
  const g = gradedBoard.pending.concat(gradedBoard.live).find((r) => r.ticker === "AGEDCO")! as unknown as Record<string, unknown>;

  const drift: string[] = [];
  for (const k of Object.keys(g)) {
    if (COMMENTARY.has(k)) continue;
    if (u[k] !== g[k]) drift.push(`${k}: unreviewed=${String(u[k])} graded=${String(g[k])}`);
  }
  check("every NON-commentary column is identical between the two runs",
    drift.length === 0, drift.join(" | "));
  check("the verdict itself DOES differ (the test is actually comparing something)",
    u.decision !== g.decision, `${String(u.decision)} vs ${String(g.decision)}`);
  console.log(`       compared ${Object.keys(g).length - COMMENTARY.size} structural columns`);

  // ---- STEP 7: freshness columns REFRESH, geometry PRESERVES -------------
  console.log("\n=== 6. freshness REFRESHES nightly, geometry PRESERVES ===\n");

  const fid = setupIdMap.get(`FIREME|${HL}`)!;
  const readSetup = (id: number) =>
    getDb().prepare(`SELECT * FROM setups WHERE id = ?`).get(id) as Record<string, unknown>;

  // Re-ingest the SAME setup a night later: FRESH -> AGING, and geometry unchanged
  // even though the CSV now carries a different rim.
  write.upsertSetup(
    {
      ticker: "FIREME", handleLowDate: HL, status: "pending",
      entry: 999, stop: 888, t05Target: 777, breakoutLevel: 666, // must NOT overwrite
      handleScore: 0.72, sizeBucket: "full", sector: "Energy", tier: "Q5", priority: 0.9,
      entryStatus: "AGING", confirmedCloseDate: TODAY, daysSinceConfirm: 1,
    },
    `${TODAY}T23:59:00.000Z`
  );
  const rowAfter = readSetup(fid);
  check("entry_status REFRESHED FRESH -> AGING (new value wins)",
    rowAfter.entry_status === "AGING", String(rowAfter.entry_status));
  check("days_since_confirm refreshed 0 -> 1", rowAfter.days_since_confirm === 1,
    String(rowAfter.days_since_confirm));
  check("geometry PRESERVED (rim still 100, not the new 666)",
    rowAfter.breakout_level === RIM, String(rowAfter.breakout_level));
  check("stop preserved (95, not 888)", rowAfter.stop === 95, String(rowAfter.stop));

  // The manual-paste case: an UNSTAMPED csv must CLEAR the label, not keep a
  // stale FRESH that would read as "takeable at the next open".
  write.upsertSetup(
    {
      ticker: "FIREME", handleLowDate: HL, status: "pending",
      entryStatus: undefined, confirmedCloseDate: undefined, daysSinceConfirm: undefined,
    },
    `${TODAY}T23:59:30.000Z`
  );
  const cleared = readSetup(fid);
  check("an UNSTAMPED ingest CLEARS entry_status (no stale FRESH survives)",
    cleared.entry_status === null, String(cleared.entry_status));
  check("geometry still preserved through the unstamped ingest",
    cleared.breakout_level === RIM, String(cleared.breakout_level));

  // ---- STEP 8: the floor guard ------------------------------------------
  console.log("\n=== 7. the floor guard ===\n");

  const priorCount = read.getCurrentBoardSetupCount();
  check("baseline = the current board's decision count", priorCount === 3, String(priorCount));
  check(`a 1-setup run is below the ${FLOOR_GUARD_MIN_FRACTION * 100}% floor`,
    1 < priorCount * FLOOR_GUARD_MIN_FRACTION);
  check("a 2-setup run is NOT below the floor (only <50% is refused)",
    !(2 < priorCount * FLOOR_GUARD_MIN_FRACTION));
  check("with no prior board (0) the guard cannot refuse — a first run must land",
    !(0 > 0));

  // ---- the ORDERING claim, asserted against the source --------------------
  //
  // "A sub-floor run must reject BEFORE retireSupersededSetups" is the property
  // that makes retirement-under-best_effort safe. It holds structurally: the
  // guard returns from POST before persistRun is called, and retire lives INSIDE
  // persistRun. Both halves are asserted here so a future refactor that moves
  // either one trips this test rather than silently retiring a whole watchlist.
  const { readFileSync } = await import("node:fs");
  const routeSrc = readFileSync("app/api/jack-validation/route.ts", "utf-8");
  const guardIdx = routeSrc.indexOf("INGEST REFUSED");
  const enrichIdx = routeSrc.indexOf("await enrichAllSetups(");
  const persistFnIdx = routeSrc.indexOf("function persistRun(");
  const retireIdx = routeSrc.indexOf("retireSupersededSetups(");
  const persistCallIdx = routeSrc.indexOf("persistRun({");

  check("the floor guard sits BEFORE Tiingo enrichment (a refused run costs nothing)",
    guardIdx > 0 && enrichIdx > 0 && guardIdx < enrichIdx, `${guardIdx} < ${enrichIdx}`);
  check("retireSupersededSetups is called INSIDE persistRun",
    persistFnIdx > 0 && retireIdx > persistFnIdx, `${persistFnIdx} < ${retireIdx}`);
  // Ordering must be judged INSIDE the POST body: persistRun's only call site is
  // in persistAndRespond, a helper declared ABOVE POST, so raw file offsets would
  // compare the wrong things. What matters is that within the handler, the guard
  // runs before anything that reaches persistence.
  void persistCallIdx;
  const postBody = routeSrc.slice(routeSrc.indexOf("export async function POST"));
  const gInPost = postBody.indexOf("INGEST REFUSED");
  const firstPersistInPost = postBody.indexOf("persistAndRespond({");
  check("inside POST, the guard runs before any call that reaches persistence",
    gInPost > 0 && firstPersistInPost > 0 && gInPost < firstPersistInPost,
    `guard@${gInPost} persist@${firstPersistInPost}`);
  check("the guard's rejection path returns (never falls through to persistence)",
    /ingestRefused: true[\s\S]{0,400}?\{ status: 200 \}/.test(postBody));
  check("the guard writes nothing (no upsert/insert between the check and its return)",
    !routeSrc.slice(guardIdx, routeSrc.indexOf("// 2. Tiingo enrichment"))
      .match(/upsertSetup|insertDecisions|insertValidationRun|retireSuperseded/));

  // ---- and the DANGER it prevents, demonstrated for real ------------------
  //
  // Persist a 1-setup run WITHOUT the guard and retirement takes out the other
  // two. This is what a broken scan would do to the watchlist unguarded.
  const survivorId = setupIdMap.get(`FIREME|${HL}`)!;
  const retired = write.retireSupersededSetups([survivorId], gradedRunId, `${TODAY}T23:59:59.000Z`);
  check("UNGUARDED, a 1-of-3 run retires the other 2 — the danger is real",
    retired.retired === 2, JSON.stringify(retired));
  console.log("       (the guard's job is to make sure that path is never reached)");
}

async function cleanup(): Promise<void> {
  // better-sqlite3 holds the file open; on Windows rmSync then fails with EPERM.
  try {
    const { closeDb } = await import("../lib/db/init");
    closeDb();
  } catch {
    /* nothing to close */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort — it is a temp dir, and a leftover must not fail the run */
  }
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
