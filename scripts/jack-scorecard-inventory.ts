/*
 * JACK scorecard data inventory — READ-ONLY diagnostics. Writes nothing, changes
 * nothing, imports no app code beyond the DB opener. Run it on the VPS to answer
 * "what data does a performance scorecard actually have to work with?" before any
 * scorecard code is written.
 *
 *   npx tsx scripts/jack-scorecard-inventory.ts
 *
 * Reports: setup/run/decision inventory + date ranges, the AI decision vocabulary
 * distribution, outcome resolution state, how many resolved setups are TRADED (the
 * live-realized arm) vs not (the paper arm), tier/priority/size_bucket coverage,
 * and how many setups are still waiting on their resolution window.
 */
async function main(): Promise<void> {
  const { getDb } = await import("../lib/db/init");
  const { DEFAULT_RESOLUTION_DAYS } = await import("../lib/jack/outcome-tracker");
  const db = getDb();

  const one = <T>(sql: string, ...p: unknown[]): T => db.prepare(sql).get(...p) as T;
  const many = <T>(sql: string, ...p: unknown[]): T[] => db.prepare(sql).all(...p) as T[];
  const line = (s = "") => console.log(s);
  const head = (s: string) => {
    line();
    line(`--- ${s} ${"-".repeat(Math.max(0, 62 - s.length))}`);
  };

  line("\n=================================================================");
  line(" JACK scorecard data inventory (read-only)");
  line("=================================================================");

  // ---- runs / setups / decisions -------------------------------------------
  head("RUNS / SETUPS / DECISIONS");
  const runs = one<{ n: number; first: string; last: string }>(
    `SELECT COUNT(*) AS n, MIN(timestamp) AS first, MAX(timestamp) AS last
       FROM validation_runs WHERE reference_kind IS NULL`
  );
  line(`validation runs      : ${runs.n}   ${runs.first ?? "-"} → ${runs.last ?? "-"}`);
  const runsWithDec = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM validation_runs r
      WHERE r.reference_kind IS NULL
        AND EXISTS (SELECT 1 FROM decisions d WHERE d.validation_run_id = r.id)`
  );
  line(`  ...with decisions  : ${runsWithDec.n}`);

  const setups = one<{ n: number; first: string; last: string; geo: number }>(
    `SELECT COUNT(*) AS n, MIN(handle_low_date) AS first, MAX(handle_low_date) AS last,
            SUM(CASE WHEN breakout_level IS NOT NULL AND stop IS NOT NULL AND t05_target IS NOT NULL
                     THEN 1 ELSE 0 END) AS geo
       FROM setups`
  );
  line(`setups               : ${setups.n}   handle_low ${setups.first ?? "-"} → ${setups.last ?? "-"}`);
  line(`  ...with full geometry (replayable): ${setups.geo}`);

  const cov = one<{ tier: number; prio: number; bucket: number; score: number; sector: number }>(
    `SELECT SUM(tier IS NOT NULL) AS tier, SUM(priority IS NOT NULL) AS prio,
            SUM(size_bucket IS NOT NULL) AS bucket, SUM(handle_score IS NOT NULL) AS score,
            SUM(sector IS NOT NULL) AS sector
       FROM setups`
  );
  line(`  column coverage    : tier ${cov.tier} · priority ${cov.prio} · size_bucket ${cov.bucket} · handle_score ${cov.score} · sector ${cov.sector}`);
  const tiers = many<{ tier: string; n: number }>(
    `SELECT COALESCE(tier,'(null)') AS tier, COUNT(*) AS n FROM setups GROUP BY 1 ORDER BY n DESC`
  );
  line(`  tiers              : ${tiers.map((t) => `${t.tier}=${t.n}`).join("  ")}`);

  const dec = one<{ n: number }>(`SELECT COUNT(*) AS n FROM decisions`);
  line(`decision rows        : ${dec.n}`);

  // ---- AI decision vocabulary ----------------------------------------------
  head("AI DECISION VOCABULARY (latest decision per setup)");
  const vocab = many<{ section: string; decision: string; n: number }>(
    `SELECT d.section, d.decision, COUNT(*) AS n
       FROM decisions d
       JOIN (SELECT setup_id, MAX(id) AS max_id FROM decisions GROUP BY setup_id) l ON l.max_id = d.id
      GROUP BY d.section, d.decision
      ORDER BY d.section, n DESC`
  );
  for (const v of vocab) line(`  ${v.section.padEnd(8)}${v.decision.padEnd(22)}${v.n}`);
  const multi = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (SELECT setup_id FROM decisions GROUP BY setup_id HAVING COUNT(*) > 1)`
  );
  line(`  setups appearing in >1 run (latest-decision rule applies): ${multi.n}`);

  // ---- outcome resolution state --------------------------------------------
  head("OUTCOMES");
  const outs = many<{ exit_reason: string; n: number }>(
    `SELECT COALESCE(exit_reason,'(null / user-fill only)') AS exit_reason, COUNT(*) AS n
       FROM outcomes GROUP BY 1 ORDER BY n DESC`
  );
  for (const o of outs) line(`  ${o.exit_reason.padEnd(30)}${o.n}`);

  const RESOLVED = `o.exit_reason IN ('target','stop','timeout') AND o.R_realized IS NOT NULL`;
  const resolved = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outcomes o WHERE ${RESOLVED}`);
  line(`  RESOLVED (target/stop/timeout, R present): ${resolved.n}`);

  // ---- (A) live realized arm ------------------------------------------------
  head("(A) LIVE REALIZED — traded by the user");
  const tradedMarks = one<{ n: number }>(
    `SELECT COUNT(DISTINCT setup_id) AS n FROM decisions WHERE user_action = 'TRADED'`
  );
  line(`setups ever marked TRADED            : ${tradedMarks.n}`);
  const withEntry = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outcomes WHERE user_entry_price IS NOT NULL`
  );
  const withExit = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outcomes WHERE user_entry_price IS NOT NULL AND user_exit_price IS NOT NULL`
  );
  const withUserR = one<{ n: number }>(`SELECT COUNT(*) AS n FROM outcomes WHERE user_R_realized IS NOT NULL`);
  line(`  with an entry fill logged          : ${withEntry.n}`);
  line(`  with entry AND exit (closed)       : ${withExit.n}`);
  line(`  with user_R_realized computed      : ${withUserR.n}   <-- (A)'s realized-R sample`);
  const tradedResolved = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outcomes o
      WHERE ${RESOLVED}
        AND EXISTS (SELECT 1 FROM decisions d WHERE d.setup_id = o.setup_id AND d.user_action='TRADED')`
  );
  line(`  TRADED and theoretically resolved  : ${tradedResolved.n}`);
  const openNow = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM setups s
      WHERE EXISTS (SELECT 1 FROM decisions d WHERE d.setup_id=s.id AND d.user_action='TRADED')
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.setup_id=s.id AND o.user_exit_price IS NOT NULL)`
  );
  line(`  still OPEN (excluded from resolved) : ${openNow.n}`);

  const tradeRows = many<{ ticker: string; d: string; tier: string; prio: number; bucket: string; ur: number; r: number; reason: string; ed: string; xd: string }>(
    `SELECT s.ticker, s.handle_low_date AS d, COALESCE(s.tier,'-') AS tier,
            s.priority AS prio, COALESCE(s.size_bucket,'-') AS bucket,
            o.user_R_realized AS ur, o.R_realized AS r, COALESCE(o.exit_reason,'-') AS reason,
            COALESCE(o.user_entry_date,'-') AS ed, COALESCE(o.user_exit_date,'-') AS xd
       FROM outcomes o JOIN setups s ON s.id = o.setup_id
      WHERE o.user_R_realized IS NOT NULL
      ORDER BY o.user_entry_date ASC`
  );
  if (tradeRows.length) {
    line(`\n  ${"TICKER".padEnd(8)}${"SETUP".padEnd(12)}${"TIER".padEnd(6)}${"PRIO".padEnd(8)}${"BUCKET".padEnd(8)}${"userR".padEnd(8)}${"theoR".padEnd(8)}${"EXIT".padEnd(9)}ENTRY→EXIT`);
    for (const t of tradeRows) {
      line(
        `  ${t.ticker.padEnd(8)}${t.d.padEnd(12)}${t.tier.padEnd(6)}${String(t.prio ?? "-").padEnd(8)}${t.bucket.padEnd(8)}` +
          `${(t.ur?.toFixed(2) ?? "-").padEnd(8)}${(t.r?.toFixed(2) ?? "-").padEnd(8)}${t.reason.padEnd(9)}${t.ed} → ${t.xd}`
      );
    }
  }

  // ---- (B) paper arm --------------------------------------------------------
  head("(B) PAPER — resolved setups the user did NOT trade");
  const paper = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outcomes o
      WHERE ${RESOLVED}
        AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.setup_id = o.setup_id AND d.user_action='TRADED')`
  );
  line(`resolved, never traded (paper sample): ${paper.n}`);
  const byDecision = many<{ decision: string; n: number; avg: number }>(
    `SELECT d.decision, COUNT(*) AS n, AVG(o.R_realized) AS avg
       FROM outcomes o
       JOIN (SELECT setup_id, MAX(id) AS max_id FROM decisions GROUP BY setup_id) l ON l.setup_id = o.setup_id
       JOIN decisions d ON d.id = l.max_id
      WHERE ${RESOLVED}
      GROUP BY d.decision ORDER BY n DESC`
  );
  line(`\n  resolved setups grouped by LATEST AI decision (this is (B)'s raw material):`);
  for (const b of byDecision) {
    line(`    ${b.decision.padEnd(22)}n=${String(b.n).padEnd(6)}avg theo R ${b.avg?.toFixed(2) ?? "-"}`);
  }

  // ---- pipeline: what is still waiting to resolve ---------------------------
  head("PIPELINE — not resolvable yet");
  const calendarCutoff = new Date();
  calendarCutoff.setDate(calendarCutoff.getDate() - Math.ceil(DEFAULT_RESOLUTION_DAYS * 1.5));
  const cutoffIso = calendarCutoff.toISOString().slice(0, 10);
  line(`resolution window     : ${DEFAULT_RESOLUTION_DAYS} trading days`);
  line(`gate cutoff (handle_low <= ) : ${cutoffIso}`);
  const waiting = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM setups s
      WHERE s.handle_low_date > ?
        AND s.breakout_level IS NOT NULL AND s.stop IS NOT NULL AND s.t05_target IS NOT NULL`,
    cutoffIso
  );
  const eligibleUnresolved = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM setups s
      WHERE s.handle_low_date <= ?
        AND s.breakout_level IS NOT NULL AND s.stop IS NOT NULL AND s.t05_target IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.setup_id = s.id AND o.exit_reason IS NOT NULL)`,
    cutoffIso
  );
  line(`setups too RECENT to resolve : ${waiting.n}   (will resolve as they age)`);
  line(`eligible but unresolved      : ${eligibleUnresolved.n}   (run UPDATE OUTCOMES / wait for the daily job)`);

  line("\nRead-only — nothing was written.\n");
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
  process.exit(1);
});

// Module marker — see the note in jack-retire-stale-setups.ts.
export {};
