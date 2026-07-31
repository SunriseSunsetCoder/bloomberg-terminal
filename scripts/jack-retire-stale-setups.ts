/*
 * JACK one-time cleanup — retire the stale PENDING setups already in the DB.
 *
 * Background: getPendingSetups() used to take each setup's own latest decision with
 * no run filter, so ideas from previous weekly scans stayed "pending" forever and
 * kept firing Telegram alerts even though the terminal (which shows the LAST run)
 * had long dropped them. The read is now run-scoped, and every new ingest retires
 * what the scan no longer carries — this script does that retirement ONCE for the
 * setups already sitting in the DB, so the alert noise stops before the next VALIDATE.
 *
 * DRY RUN BY DEFAULT — writes nothing, prints exactly what it would mark.
 *   npx tsx scripts/jack-retire-stale-setups.ts            # report only
 *   npx tsx scripts/jack-retire-stale-setups.ts --apply    # perform the retirement
 *
 * Safety: a candidate is only ever a setup that is (a) not in the current run and
 * (b) NEVER marked TRADED. Open and closed positions are excluded by that rule, and
 * --apply re-checks the invariant inside the transaction and aborts if it is violated.
 * Writes to the `setups` table only — no decision, fill, or outcome row is touched.
 */

interface CandidateRow {
  id: number;
  ticker: string;
  handle_low_date: string;
  last_seen_at: string;
  last_section: string | null;
  ever_traded: number;
  currently_open: number;
}

const APPLY = process.argv.includes("--apply");

async function main(): Promise<number> {
  const { getDb } = await import("../lib/db/init");
  const read = await import("../lib/db/read");
  const db = getDb();

  const now = new Date().toISOString();

  // ---- 1. What the board is currently showing -------------------------------
  const board = read.getCurrentBoard();
  if (board.runId === null) {
    console.error(
      "\nNo validation run with decisions found — refusing to retire anything.\n" +
        "Run a VALIDATE first so there is a current board to scope against.\n"
    );
    return 1;
  }
  const run = db
    .prepare(`SELECT timestamp FROM validation_runs WHERE id = ?`)
    .get(board.runId) as { timestamp: string };

  const open = read.getOpenPositions();
  const pending = read.getPendingSetups();

  console.log("\n=================================================================");
  console.log(` JACK stale-setup cleanup — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  console.log("=================================================================\n");
  console.log(`Current board  : run #${board.runId}  (${run.timestamp})`);
  console.log(`  live         : ${board.live.length} decisions`);
  console.log(`  pending      : ${board.pending.length} decisions`);
  console.log(`\nAlert-eligible PENDING after the fix (${pending.length}):`);
  console.log(`  ${pending.map((p) => p.ticker).join(" ") || "(none)"}`);
  console.log(`\nOPEN POSITIONS — must be untouched (${open.length}):`);
  console.log(`  ${open.map((p) => p.ticker).join(" ") || "(none)"}`);

  // ---- 2. Candidates: not in the current run, never TRADED ------------------
  const currentSetupIds = db
    .prepare(`SELECT DISTINCT setup_id AS id FROM decisions WHERE validation_run_id = ?`)
    .all(board.runId) as Array<{ id: number }>;
  const inRun = currentSetupIds.map((r) => r.id);
  const ph = inRun.map(() => "?").join(",");

  const candidateSql = `
    SELECT s.id, s.ticker, s.handle_low_date, s.last_seen_at,
           (SELECT d.section FROM decisions d
             WHERE d.setup_id = s.id ORDER BY d.id DESC LIMIT 1) AS last_section,
           EXISTS (SELECT 1 FROM decisions d2
                    WHERE d2.setup_id = s.id AND d2.user_action = 'TRADED') AS ever_traded,
           (EXISTS (SELECT 1 FROM decisions d3
                     WHERE d3.setup_id = s.id AND d3.user_action = 'TRADED')
            AND NOT EXISTS (SELECT 1 FROM outcomes o
                             WHERE o.setup_id = s.id AND o.user_exit_price IS NOT NULL)) AS currently_open
      FROM setups s
     WHERE s.retired_at IS NULL
       AND s.id NOT IN (${ph})
       AND NOT EXISTS (SELECT 1 FROM decisions d4
                        WHERE d4.setup_id = s.id AND d4.user_action = 'TRADED')
     ORDER BY s.ticker ASC`;

  const candidates = db.prepare(candidateSql).all(...inRun) as CandidateRow[];

  // Everything off-board that is PROTECTED because it was traded at some point —
  // shown so it is visible that these are deliberately left alone.
  const protectedRows = db
    .prepare(
      `SELECT s.ticker, s.handle_low_date,
              (NOT EXISTS (SELECT 1 FROM outcomes o
                            WHERE o.setup_id = s.id AND o.user_exit_price IS NOT NULL)) AS currently_open
         FROM setups s
        WHERE s.id NOT IN (${ph})
          AND EXISTS (SELECT 1 FROM decisions d
                       WHERE d.setup_id = s.id AND d.user_action = 'TRADED')
        ORDER BY s.ticker ASC`
    )
    .all(...inRun) as Array<{ ticker: string; handle_low_date: string; currently_open: number }>;

  // ---- 3. Report -----------------------------------------------------------
  console.log(`\n-----------------------------------------------------------------`);
  console.log(` WILL RETIRE — ${candidates.length} setup(s)`);
  console.log(`-----------------------------------------------------------------`);
  if (candidates.length === 0) {
    console.log("  (nothing to retire — the DB is already clean)");
  } else {
    console.log(
      `  ${"TICKER".padEnd(8)}${"HANDLE_LOW".padEnd(13)}${"LAST_SEEN".padEnd(13)}${"LAST_SECTION".padEnd(14)}TRADED  OPEN`
    );
    for (const c of candidates) {
      console.log(
        `  ${c.ticker.padEnd(8)}${c.handle_low_date.padEnd(13)}${(c.last_seen_at ?? "").slice(0, 10).padEnd(13)}` +
          `${(c.last_section ?? "-").padEnd(14)}${String(c.ever_traded).padEnd(8)}${c.currently_open}`
      );
    }
    console.log(`\n  tickers: ${candidates.map((c) => c.ticker).join(" ")}`);
  }

  console.log(`\n PROTECTED (off-board but ever TRADED — never retired): ${protectedRows.length}`);
  for (const p of protectedRows) {
    console.log(`  ${p.ticker.padEnd(8)}${p.handle_low_date.padEnd(13)}${p.currently_open ? "OPEN POSITION" : "closed (exited)"}`);
  }

  // ---- 4. Invariants -------------------------------------------------------
  const badTraded = candidates.filter((c) => c.ever_traded === 1);
  const badOpen = candidates.filter((c) => c.currently_open === 1);
  const openTickers = new Set(open.map((p) => p.ticker.toUpperCase()));
  const badOpenByTicker = candidates.filter((c) => openTickers.has(c.ticker.toUpperCase()));

  console.log(`\n-----------------------------------------------------------------`);
  console.log(` INVARIANTS`);
  console.log(`-----------------------------------------------------------------`);
  console.log(`  ever-TRADED candidates      : ${badTraded.length}   (must be 0)`);
  console.log(`  currently-open candidates   : ${badOpen.length}   (must be 0)`);
  console.log(`  open-position tickers hit   : ${badOpenByTicker.length}   (must be 0)`);
  console.log(`  open positions affected     : 0`);

  if (badTraded.length || badOpen.length || badOpenByTicker.length) {
    console.error(
      `\nABORT — a candidate touches a real position. Nothing was written. This is a bug;\n` +
        `report the rows above before doing anything else.\n`
    );
    return 1;
  }

  // ---- 5. Apply ------------------------------------------------------------
  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing written. Re-run with --apply to retire the ${candidates.length} setup(s) above.\n` +
        `Redis: leave the jack:alert:* / jack:*:slot:* keys alone — they only SUPPRESS sends\n` +
        `and self-expire within ~36h; clearing them risks a duplicate re-send today.\n`
    );
    return 0;
  }

  if (candidates.length === 0) {
    console.log(`\nNothing to apply.\n`);
    return 0;
  }

  const ids = candidates.map((c) => c.id);
  const idPh = ids.map(() => "?").join(",");
  const applyTx = db.transaction(() => {
    // Re-check the invariant INSIDE the transaction: only ever-never-TRADED rows.
    const recheck = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM setups s
            WHERE s.id IN (${idPh})
              AND EXISTS (SELECT 1 FROM decisions d
                           WHERE d.setup_id = s.id AND d.user_action = 'TRADED')`
        )
        .get(...ids) as { c: number }
    ).c;
    if (recheck > 0) throw new Error(`${recheck} candidate(s) are TRADED — aborting, nothing written`);

    return db
      .prepare(
        `UPDATE setups SET retired_at = ?, retired_reason = 'one_time_cleanup'
          WHERE id IN (${idPh}) AND retired_at IS NULL`
      )
      .run(now, ...ids).changes;
  });

  const changed = applyTx();
  const pendingAfter = read.getPendingSetups();
  const openAfter = read.getOpenPositions();

  console.log(`\nAPPLIED — ${changed} setup(s) retired (retired_reason='one_time_cleanup').`);
  console.log(`  pending after : ${pendingAfter.length}  [${pendingAfter.map((p) => p.ticker).join(" ")}]`);
  console.log(`  open after    : ${openAfter.length}  [${openAfter.map((p) => p.ticker).join(" ")}]`);
  if (openAfter.length !== open.length) {
    console.error(`\n  ⚠ OPEN POSITION COUNT CHANGED (${open.length} → ${openAfter.length}) — investigate immediately.\n`);
    return 1;
  }
  console.log(`  open positions unchanged ✓\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.message : String(err), "\n");
    process.exit(1);
  });

// This file is a module (top-level dynamic imports only) — keeps its `main` out of
// the global script scope so tsc does not see it as a duplicate declaration.
export {};
