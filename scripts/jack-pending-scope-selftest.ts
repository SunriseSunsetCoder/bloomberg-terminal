/*
 * JACK pending-scope self-test — proves the alert-eligible PENDING set is EXACTLY
 * the terminal's current PENDING list, and that open positions are unaffected.
 *
 * Regression guard for the stale-alert bug: getPendingSetups() used to take each
 * setup's own MAX(decision id) with no run filter, so ideas from previous weekly
 * scans stayed pending forever — invisible on the terminal, still alerting.
 *
 * Runs against a REAL throwaway SQLite DB (JACK_DB_PATH), exercising the real
 * write/read/retire code paths. No network, no Redis, no Telegram.
 *
 * Run:  npx tsx scripts/jack-pending-scope-selftest.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const sorted = (a: string[]) => [...a].sort().join(",");

const dir = mkdtempSync(join(tmpdir(), "jack-pending-scope-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

async function main(): Promise<void> {
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");
  const { combineJackDecisions } = await import("../lib/jack/combine-decisions");
  const { evalStopHit, evalApproachStop } = await import("../lib/jack/alerts");
  const { getDb } = await import("../lib/db/init");
  const db = getDb();

  type Client = import("@/components/bloomberg/hooks/useJackValidation").JackDecisionClient;

  // ---------------------------------------------------------------------------
  // Helpers: build a validation run the same way persistRun() does.
  // ---------------------------------------------------------------------------
  const runMeta = (timestamp: string, n: number) => ({
    timestamp,
    inputRowCount: n,
    totalFinalCount: n,
    liveFinalCount: n,
    pendingFinalCount: n,
    liveDroppedStale: 0,
    pendingDroppedStale: 0,
    liveDroppedOverCap: 0,
    pendingDroppedOverCap: 0,
    tiingoAttempted: 0,
    tiingoSucceeded: 0,
    riskPerTrade: 2000,
    parseSuccess: true,
  });

  const HLD = "2026-06-01";

  /**
   * Ingest a scan: upsert its setups, insert the run + one decision each, then run
   * the SAME retirement persistRun() runs. Returns { runId, ids }.
   */
  function ingest(
    timestamp: string,
    rows: Array<{ ticker: string; section: "live" | "pending" }>
  ): { runId: number; ids: Map<string, { decisionId: number; setupId: number }> } {
    const setupIdMap = new Map<string, number>();
    for (const r of rows) {
      const id = write.upsertSetup(
        {
          ticker: r.ticker,
          handleLowDate: HLD,
          status: r.section === "live" ? "just_fired" : "pending",
          entry: 100,
          stop: 95,
          t05Target: 115,
          breakoutLevel: 101,
        },
        timestamp
      );
      setupIdMap.set(`${r.ticker}|${HLD}`, id);
    }
    const runId = write.insertValidationRun(runMeta(timestamp, rows.length));
    const { ids } = write.insertDecisions(
      rows.map((r) => ({
        ticker: r.ticker,
        handleLowDate: HLD,
        section: r.section,
        decision: r.section === "live" ? "TRADE" : "WATCH",
      })),
      runId,
      setupIdMap
    );
    // Mirrors app/api/jack-validation/route.ts persistRun step 3b.
    write.retireSupersededSetups([...setupIdMap.values()], runId, timestamp);
    const map = new Map<string, { decisionId: number; setupId: number }>();
    for (const i of ids) map.set(i.ticker, { decisionId: i.decisionId, setupId: i.setupId });
    return { runId, ids: map };
  }

  /**
   * The TERMINAL's list, reconstructed the way the UI builds it: the current run's
   * decision rows fed through the REAL combineJackDecisions (jack-view.tsx), which
   * routes owned setups into CURRENT POSITIONS. Whatever ends up in section
   * "pending" is what the user sees under PENDING.
   */
  function terminalPendingTickers(): string[] {
    const board = read.getCurrentBoard();
    const asClient = (r: import("../lib/db/read").CurrentBoardRow): Client => ({
      decisionId: r.decisionId,
      setupId: r.setupId,
      ticker: r.ticker,
      handleLowDate: r.handleLowDate,
      section: r.section,
      decision: r.decision,
      entry: r.entry,
      stop: r.stop,
      target: r.target,
      shares: null,
      breakout: r.breakout,
      currentPrice: null,
      note: null,
      newsClass: null,
      sectorRs: null,
      crossAsset: null,
      earningsFlag: null,
      pctToBreakout: null,
      userAction: r.userAction,
      userEntryPrice: null,
      userEntryDate: null,
      userExitPrice: r.userExitPrice,
      userExitDate: null,
      jackDecisionAtMark: null,
      sharesAtMark: null,
    });
    const runRows = [...board.live, ...board.pending].map(asClient);
    const openRows = read.getOpenPositions().map(
      (p): Client => ({
        ...asClient({
          decisionId: p.decisionId,
          setupId: p.setupId,
          ticker: p.ticker,
          handleLowDate: p.handleLowDate,
          section: "live",
          decision: p.jackDecisionAtMark ?? "TRADED",
          entry: p.entry,
          stop: p.stop,
          target: p.target,
          breakout: p.breakout,
          userAction: "TRADED",
          userExitPrice: p.userExitPrice,
          retiredAt: null,
        }),
        section: "open",
        userEntryPrice: p.userEntryPrice,
      })
    );
    return combineJackDecisions(runRows, openRows)
      .filter((d) => d.section === "pending")
      .map((d) => d.ticker);
  }

  const retiredAtOf = (ticker: string): string | null =>
    (db.prepare(`SELECT retired_at AS r FROM setups WHERE ticker = ?`).get(ticker) as { r: string | null }).r;

  // ---------------------------------------------------------------------------
  // RUN 1 — last week's scan
  //   AAA pending → marked TRADED, no exit  (open position; drops off next scan)
  //   BBB pending → never traded            (the stale idea that kept alerting)
  //   EEE pending → TRADED then EXITED      (re-appears in run 2)
  //   FFF pending → never traded            (re-appears in run 3)
  // ---------------------------------------------------------------------------
  console.log("\n[1] Run 1 — prior weekly scan");
  const run1 = ingest("2026-07-01T12:00:00.000Z", [
    { ticker: "AAA", section: "pending" },
    { ticker: "BBB", section: "pending" },
    { ticker: "EEE", section: "pending" },
    { ticker: "FFF", section: "pending" },
  ]);

  read.markDecisionUserAction(run1.ids.get("AAA")!.decisionId, "TRADED");
  write.updateUserFills(run1.ids.get("AAA")!.setupId, 101, "2026-07-02", null, null);

  read.markDecisionUserAction(run1.ids.get("EEE")!.decisionId, "TRADED");
  write.updateUserFills(run1.ids.get("EEE")!.setupId, 101, "2026-07-02", 112, "2026-07-10");

  check("run 1 is the current board", read.getCurrentRunId() === run1.runId);
  check(
    "run 1 pending excludes the open position AAA",
    sorted(read.getPendingSetups().map((p) => p.ticker)) === sorted(["BBB", "FFF", "EEE"]),
    read.getPendingSetups().map((p) => p.ticker).join(",")
  );
  check("AAA is an open position", read.getOpenPositions().some((p) => p.ticker === "AAA"));

  const aaaBefore = db
    .prepare(
      `SELECT (SELECT user_action FROM decisions WHERE setup_id = ? AND user_action IS NOT NULL) AS act,
              (SELECT user_entry_price FROM outcomes WHERE setup_id = ?) AS entry,
              (SELECT user_exit_price FROM outcomes WHERE setup_id = ?) AS exit`
    )
    .get(run1.ids.get("AAA")!.setupId, run1.ids.get("AAA")!.setupId, run1.ids.get("AAA")!.setupId);

  // ---------------------------------------------------------------------------
  // RUN 2 — this week's scan. AAA / BBB / FFF are NOT in it.
  //   CCC pending (new)   DDD live (new)   EEE pending (traded+exited, firing again)
  // ---------------------------------------------------------------------------
  console.log("\n[2] Run 2 — this week's scan (AAA/BBB/FFF dropped off)");
  const run2 = ingest("2026-07-20T12:00:00.000Z", [
    { ticker: "CCC", section: "pending" },
    { ticker: "DDD", section: "live" },
    { ticker: "EEE", section: "pending" },
  ]);

  check("run 2 is the current board", read.getCurrentRunId() === run2.runId);

  // ---- 1. SET EQUALITY: alerts === terminal ---------------------------------
  const alertSet = read.getPendingSetups().map((p) => p.ticker);
  const uiSet = terminalPendingTickers();
  check(
    "alert PENDING set === terminal PENDING list (via real combineJackDecisions)",
    sorted(alertSet) === sorted(uiSet),
    `alerts=[${sorted(alertSet)}] ui=[${sorted(uiSet)}]`
  );
  check("pending is exactly CCC + EEE", sorted(alertSet) === sorted(["CCC", "EEE"]), alertSet.join(","));

  // ---- 2. STALE DROP --------------------------------------------------------
  check("stale BBB is NOT alert-eligible", !alertSet.includes("BBB"));
  check("stale BBB is retired by the ingest", retiredAtOf("BBB") !== null);
  check("live-section DDD is not in the pending set", !alertSet.includes("DDD"));

  // ---- 3. TRADED POSITION STILL ALERTS -------------------------------------
  const aaa = read.getOpenPositions().find((p) => p.ticker === "AAA");
  check("open AAA still returned by getOpenPositions after dropping off the scan", !!aaa);
  check("open AAA was NOT retired", retiredAtOf("AAA") === null);
  check("open AAA still fires a stop-hit alert", !!aaa && evalStopHit(aaa.ticker, 94, aaa.stop) !== null);
  check("open AAA still fires an approach-stop heads-up", !!aaa && evalApproachStop(aaa.ticker, 96.5, aaa.stop) !== null);
  check("open AAA is not double-counted into pending", !alertSet.includes("AAA"));

  // ---- 4. INGEST DOES NOT CLOBBER TRADED/EXITED STATE ----------------------
  const aaaAfter = db
    .prepare(
      `SELECT (SELECT user_action FROM decisions WHERE setup_id = ? AND user_action IS NOT NULL) AS act,
              (SELECT user_entry_price FROM outcomes WHERE setup_id = ?) AS entry,
              (SELECT user_exit_price FROM outcomes WHERE setup_id = ?) AS exit`
    )
    .get(run1.ids.get("AAA")!.setupId, run1.ids.get("AAA")!.setupId, run1.ids.get("AAA")!.setupId);
  check(
    "TRADED mark + fills survive the retirement pass byte-for-byte",
    JSON.stringify(aaaBefore) === JSON.stringify(aaaAfter),
    `${JSON.stringify(aaaBefore)} vs ${JSON.stringify(aaaAfter)}`
  );
  const exitedRetired = retiredAtOf("EEE");
  check("exited EEE (present in run 2) is not retired", exitedRetired === null);

  // ---- 5. EXITED-AND-REFIRING IS BACK ON THE BOARD -------------------------
  check("traded-then-exited EEE is alert-eligible again (matches display)", alertSet.includes("EEE"));

  // ---------------------------------------------------------------------------
  // RUN 3 — FFF returns to the watchlist
  // ---------------------------------------------------------------------------
  console.log("\n[3] Run 3 — a retired ticker returns");
  check("FFF was retired by run 2", retiredAtOf("FFF") !== null);
  const run3 = ingest("2026-07-27T12:00:00.000Z", [
    { ticker: "CCC", section: "pending" },
    { ticker: "FFF", section: "pending" },
  ]);
  const alertSet3 = read.getPendingSetups().map((p) => p.ticker);
  check("run 3 is the current board", read.getCurrentRunId() === run3.runId);
  check("returning FFF is un-retired", retiredAtOf("FFF") === null);
  check("returning FFF is alert-eligible again", alertSet3.includes("FFF"));
  check("EEE dropped off run 3 → no longer alert-eligible", !alertSet3.includes("EEE"));
  check(
    "run 3: alerts still === terminal",
    sorted(alertSet3) === sorted(terminalPendingTickers()),
    `alerts=[${sorted(alertSet3)}] ui=[${sorted(terminalPendingTickers())}]`
  );
  check("open AAA STILL open after two scans without it", read.getOpenPositions().some((p) => p.ticker === "AAA"));

  // ---------------------------------------------------------------------------
  // RUN 4 — parse-failed run: a validation_runs row with ZERO decisions.
  // The board must fall back to the last good run, not go blank.
  // ---------------------------------------------------------------------------
  console.log("\n[4] Parse-failed run — last-good-list fallback");
  const deadRunId = write.insertValidationRun({
    ...runMeta("2026-07-28T12:00:00.000Z", 5),
    parseSuccess: false,
    errorMsg: "JSON parse failed",
  });
  check("empty run inserted", deadRunId > run3.runId);
  check("current run is still run 3 (not the empty run)", read.getCurrentRunId() === run3.runId);
  check(
    "pending set unchanged by the failed run",
    sorted(read.getPendingSetups().map((p) => p.ticker)) === sorted(alertSet3),
    read.getPendingSetups().map((p) => p.ticker).join(",")
  );

  // ---- retirement guards ----------------------------------------------------
  console.log("\n[5] Retirement guards");
  const before = db.prepare(`SELECT COUNT(*) AS c FROM setups WHERE retired_at IS NOT NULL`).get() as { c: number };
  const noop = write.retireSupersededSetups([], run3.runId, "2026-07-28T12:00:00.000Z");
  const after = db.prepare(`SELECT COUNT(*) AS c FROM setups WHERE retired_at IS NOT NULL`).get() as { c: number };
  check("empty scan retires nothing", noop.retired === 0 && before.c === after.c);
  check(
    "ever-TRADED setups are never retired",
    (db.prepare(
      `SELECT COUNT(*) AS c FROM setups s
        WHERE s.retired_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM decisions d WHERE d.setup_id = s.id AND d.user_action = 'TRADED')`
    ).get() as { c: number }).c === 0
  );
  const repeat = write.retireSupersededSetups(
    [run3.ids.get("CCC")!.setupId, run3.ids.get("FFF")!.setupId],
    run3.runId,
    "2026-07-28T12:00:00.000Z"
  );
  check("retirement is idempotent (re-run retires nothing new)", repeat.retired === 0);
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort */
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });
