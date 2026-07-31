/*
 * THROWAWAY read-only audit — why are only 6 of 238 setups replayable?
 *
 * Opens jack.db in SQLITE READONLY MODE (not via getDb(), which would run the
 * additive migrations = a write path). Executes SELECTs only. Cannot modify the DB
 * even if it tried: the connection is opened readonly.
 *
 *   npx tsx scripts/jack-geometry-audit.ts
 *   JACK_DB_PATH=/path/to/jack.db npx tsx scripts/jack-geometry-audit.ts
 *
 * Prints:
 *   TABLE 1 — geometry column coverage, split by whether the row was first seen
 *             BEFORE or AFTER the geometry-capture code shipped (2026-07-15).
 *   TABLE 2 — the setups that ARE replayable (breakout_level + stop + t05_target).
 *   VERDICT — whether those are exactly the 6 hand-coded backfill tickers.
 *
 * Delete this file once the question is answered.
 */
import Database from "better-sqlite3";
import { join } from "node:path";

// The geometry parse + geometry upsert shipped on this date (commits f36b2ed /
// 83b55ca). Rows first seen before it were stored geometry-blind no matter what
// the scanner CSV contained.
const GEOMETRY_CODE_DATE = "2026-07-15";

// scripts/jack-backfill-6-trades.ts inserts exactly these six with hardcoded geometry.
const BACKFILL_TICKERS = ["BNY", "UNM", "WELL", "EXPD", "MET", "MAA"].sort();

function main(): void {
  const dbPath = process.env.JACK_DB_PATH || join(process.cwd(), "data", "jack.db");
  console.log(`\nreading (READONLY): ${dbPath}\n`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM setups`).get() as { n: number }).n;

  // ---- TABLE 1: column-by-column coverage, split by ingest cohort ----------
  const coverage = db
    .prepare(
      `SELECT
         CASE WHEN first_seen_at >= @cut
              THEN 'AFTER  geometry code (>= ${GEOMETRY_CODE_DATE})'
              ELSE 'BEFORE geometry code (<  ${GEOMETRY_CODE_DATE})'
         END                                AS cohort,
         COUNT(*)                           AS rows,
         SUM(entry          IS NOT NULL)    AS entry,
         SUM(stop           IS NOT NULL)    AS stop,
         SUM(t05_target     IS NOT NULL)    AS target,
         SUM(breakout_level IS NOT NULL)    AS breakout,
         SUM(cup_depth_pct  IS NOT NULL)    AS cup_depth,
         SUM(handle_retr_pct IS NOT NULL)   AS handle_retr,
         SUM(breakout_level IS NOT NULL
             AND stop       IS NOT NULL
             AND t05_target IS NOT NULL)    AS replayable,
         MIN(substr(first_seen_at,1,10))    AS first_seen_min,
         MAX(substr(first_seen_at,1,10))    AS first_seen_max
       FROM setups
       GROUP BY 1
       ORDER BY 1`
    )
    .all({ cut: GEOMETRY_CODE_DATE });

  console.log(`TABLE 1 — geometry coverage by ingest cohort   (${total} setups total)`);
  console.table(coverage);

  // ---- TABLE 2: the rows that ARE replayable -------------------------------
  const replayable = db
    .prepare(
      `SELECT s.ticker, s.handle_low_date,
              substr(s.first_seen_at,1,10) AS first_seen,
              substr(s.last_seen_at,1,10)  AS last_seen,
              s.entry, s.stop, s.t05_target AS target, s.breakout_level AS breakout,
              (SELECT COUNT(*) FROM decisions d WHERE d.setup_id = s.id)          AS decisions,
              (SELECT d.decision FROM decisions d WHERE d.setup_id = s.id
                ORDER BY d.id DESC LIMIT 1)                                        AS latest_decision,
              (SELECT r.model FROM decisions d
                 JOIN validation_runs r ON r.id = d.validation_run_id
                WHERE d.setup_id = s.id ORDER BY d.id ASC LIMIT 1)                 AS first_run_model
         FROM setups s
        WHERE s.breakout_level IS NOT NULL
          AND s.stop           IS NOT NULL
          AND s.t05_target     IS NOT NULL
        ORDER BY s.handle_low_date, s.ticker`
    )
    .all() as Array<{ ticker: string; first_run_model: string | null }>;

  console.log(`\nTABLE 2 — replayable setups (${replayable.length})`);
  console.table(replayable);

  // ---- VERDICT -------------------------------------------------------------
  const tickers = [...new Set(replayable.map((r) => r.ticker))].sort();
  const isBackfillSet =
    tickers.length === BACKFILL_TICKERS.length && tickers.every((t, i) => t === BACKFILL_TICKERS[i]);
  const viaBackfillRun = replayable.filter((r) => r.first_run_model === "backfill").length;

  console.log("\nVERDICT");
  console.log(`  replayable tickers : ${tickers.join(" ") || "(none)"}`);
  console.log(`  backfill-script set: ${BACKFILL_TICKERS.join(" ")}`);
  console.log(`  first seen in a run with model='backfill': ${viaBackfillRun}/${replayable.length}`);
  console.log(
    isBackfillSet
      ? `  => MATCH. Every replayable row came from the hand-coded backfill script, so NO\n` +
          `     CSV-ingested setup has ever captured geometry — including rows ingested after\n` +
          `     ${GEOMETRY_CODE_DATE}. Cause is the scanner CSV's column names, not the ship date.`
      : `  => NOT the backfill set. Check TABLE 1: if the AFTER cohort has breakout populated,\n` +
          `     capture works now and only the pre-${GEOMETRY_CODE_DATE} cohort is affected.`
  );

  // ---- A hint at the real header, if any run retained one ------------------
  // Nothing persists the input CSV, but the LLM was fed "Scanner row: <raw csv line>"
  // and its markdown tables echo the numbers. Report whether raw_markdown is usable
  // for a recovery pass (§5 of the findings report).
  const runs = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              SUM(raw_markdown IS NOT NULL AND length(raw_markdown) > 0) AS with_markdown,
              SUM(parse_success = 1)                                     AS parsed_ok
         FROM validation_runs
        WHERE reference_kind IS NULL`
    )
    .get();
  console.log("\nRECOVERY SOURCE — validation_runs.raw_markdown availability");
  console.table([runs]);

  db.close();
  console.log("\nRead-only. Nothing was written.\n");
}

main();

// Module marker — keeps `main` out of the global script scope for tsc.
export {};
