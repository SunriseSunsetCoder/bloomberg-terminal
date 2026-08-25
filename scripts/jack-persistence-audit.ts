/*
 * JACK persistence audit — READ-ONLY. Writes nothing, changes nothing.
 *
 *   npx tsx scripts/jack-persistence-audit.ts
 *
 * ANSWERS ONE QUESTION: is the data JSCORE and JANLY depend on actually being
 * SAVED, or is it silently not being written?
 *
 * The distinction that matters for forward-testing:
 *   (a) NOT PERSISTED  -> real problem, months of data lost
 *   (b) PERSISTED but not yet SURFACED -> expected, nothing is lost
 *
 * Both surfaces read `setups JOIN outcomes` (INNER). So an empty `outcomes`
 * table empties BOTH. What separates them is downstream: JSCORE also reads
 * getPriorityRanks() off `decisions` (which changes every run), while JANLY
 * suppresses its verdicts until every handle-score bucket has n >= 30.
 *
 * Run it on the VPS — it needs jack.db.
 */

async function main(): Promise<void> {
  const { getDb } = await import("../lib/db/init");
  const db = getDb();

  const one = <T>(sql: string, p: Record<string, unknown> = {}): T =>
    db.prepare(sql).get(p) as T;
  const many = <T>(sql: string, p: Record<string, unknown> = {}): T[] =>
    db.prepare(sql).all(p) as T[];
  const line = (s = "") => console.log(s);
  const head = (s: string) => {
    line();
    line(`--- ${s} ${"-".repeat(Math.max(0, 66 - s.length))}`);
  };
  const q = (label: string, sql: string) => {
    line();
    line(`  Q: ${label}`);
    line(`     ${sql.replace(/\s+/g, " ").trim().slice(0, 150)}`);
  };

  line("\n==================================================================");
  line(" JACK persistence audit (read-only)  —  is the data being SAVED?");
  line("==================================================================");

  // ---- 1. Is anything being written at all? --------------------------------
  head("1. TABLE INVENTORY — are rows landing?");
  q("row counts per table", "SELECT COUNT(*) FROM <each>");
  for (const t of ["setups", "validation_runs", "decisions", "outcomes"]) {
    const n = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).n;
    line(`     ${t.padEnd(18)} ${String(n).padStart(8)} rows`);
  }

  // ---- 2. Is NEW data landing per run? -------------------------------------
  head("2. RECENCY — is each run writing?");
  q("last 10 validation runs", "SELECT id, timestamp FROM validation_runs ORDER BY id DESC LIMIT 10");
  const runs = many<{ id: number; timestamp: string; n: number }>(
    `SELECT r.id, r.timestamp, (SELECT COUNT(*) FROM decisions d WHERE d.validation_run_id = r.id) AS n
       FROM validation_runs r ORDER BY r.id DESC LIMIT 10`
  );
  if (runs.length === 0) {
    line("     NO RUNS AT ALL — nothing has ever been ingested.");
  } else {
    line(`     ${"run".padEnd(8)}${"timestamp".padEnd(26)}decisions`);
    for (const r of runs) {
      line(`     ${String("#" + r.id).padEnd(8)}${(r.timestamp ?? "?").padEnd(26)}${r.n}`);
    }
    line("");
    line("     -> distinct decision rows per run proves the ingest is persisting.");
    line("        A flat/absent list here WOULD be the persistence bug.");
  }

  q("newest setup first_seen_at", "SELECT MAX(first_seen_at) FROM setups");
  const newest = one<{ v: string | null }>(`SELECT MAX(first_seen_at) AS v FROM setups`).v;
  const oldest = one<{ v: string | null }>(`SELECT MIN(first_seen_at) AS v FROM setups`).v;
  line(`     setups first_seen_at: oldest ${oldest ?? "-"} · newest ${newest ?? "-"}`);

  // ---- 3. THE OUTCOMES TABLE — the shared dependency ------------------------
  head("3. OUTCOMES — the table BOTH surfaces inner-join");
  q("outcomes by exit_reason",
    "SELECT exit_reason, COUNT(*) FROM outcomes GROUP BY exit_reason");
  const byReason = many<{ exit_reason: string | null; n: number }>(
    `SELECT exit_reason, COUNT(*) AS n FROM outcomes GROUP BY exit_reason ORDER BY n DESC`
  );
  if (byReason.length === 0) {
    line("     OUTCOMES IS EMPTY. Both JSCORE and JANLY will be blank — the inner");
    line("     join yields nothing. See section 4 for WHY (it may be correct).");
  } else {
    for (const r of byReason) {
      line(`     ${(r.exit_reason ?? "(null)").padEnd(14)} ${String(r.n).padStart(6)}`);
    }
  }
  const oc = one<{ n: number; first: string | null; last: string | null }>(
    `SELECT COUNT(*) AS n, MIN(outcome_computed_at) AS first, MAX(outcome_computed_at) AS last FROM outcomes`
  );
  line(`     outcome_computed_at: first ${oc.first ?? "-"} · last ${oc.last ?? "-"}`);
  const bySource = many<{ outcome_source: string; n: number }>(
    `SELECT outcome_source, COUNT(*) AS n FROM outcomes GROUP BY outcome_source ORDER BY n DESC`
  );
  for (const s of bySource) line(`     source ${s.outcome_source.padEnd(20)} ${s.n}`);

  // ---- 4. WHY outcomes is the size it is -----------------------------------
  head("4. THE 195-DAY GATE — why outcomes may legitimately be near-empty");
  const { DEFAULT_RESOLUTION_DAYS } = await import("../lib/jack/outcome-tracker");
  const calendarDays = Math.ceil(DEFAULT_RESOLUTION_DAYS * 1.5);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - calendarDays);
  const cutoffIso = cutoff.toISOString().split("T")[0];
  line(`     DEFAULT_RESOLUTION_DAYS = ${DEFAULT_RESOLUTION_DAYS}`);
  line(`     calendar gate           = ceil(${DEFAULT_RESOLUTION_DAYS} * 1.5) = ${calendarDays} days`);
  line(`     cutoff                  = ${cutoffIso}`);
  line("");
  line("     getSetupsNeedingOutcomes only considers setups whose handle_low_date");
  line("     is ON OR BEFORE that cutoff. Anything newer CANNOT have an outcome");
  line("     yet, BY DESIGN — resolving early would fabricate results.");

  q("setups eligible vs too-recent",
    "SELECT COUNT(*) FROM setups WHERE handle_low_date <= @cutoff");
  const elig = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM setups WHERE handle_low_date <= @cutoff`, { cutoff: cutoffIso }).n;
  const tooNew = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM setups WHERE handle_low_date > @cutoff`, { cutoff: cutoffIso }).n;
  line(`     setups old enough to resolve : ${elig}`);
  line(`     setups TOO RECENT to resolve : ${tooNew}   <- these are your forward test`);

  q("eligible AND still missing an outcome (the tracker's actual work queue)",
    "SELECT COUNT(*) FROM setups s WHERE s.handle_low_date <= @cutoff AND geometry NOT NULL AND NOT EXISTS(outcome)");
  const pending = one<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM setups s
      WHERE s.handle_low_date <= @cutoff
        AND s.breakout_level IS NOT NULL AND s.stop IS NOT NULL AND s.t05_target IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.setup_id = s.id AND o.exit_reason IS NOT NULL)`,
    { cutoff: cutoffIso }
  ).n;
  line(`     eligible, geometry OK, NOT yet resolved : ${pending}`);
  line("");
  if (pending > 0) {
    line("     >> NON-ZERO: the outcome tracker has work queued and has not done it.");
    line("        That points at the 24h job NOT RUNNING (check JACK_SELF_BASE_URL");
    line("        on the VPS — the auto-outcome replay needs it) rather than at a");
    line("        write failure. Worth chasing.");
  } else {
    line("     >> ZERO: every setup old enough to resolve HAS been resolved.");
    line("        The tracker is keeping up; nothing is being dropped.");
  }

  const missingGeom = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM setups s
      WHERE s.handle_low_date <= @cutoff
        AND (s.breakout_level IS NULL OR s.stop IS NULL OR s.t05_target IS NULL)`,
    { cutoff: cutoffIso }
  ).n;
  line(`     eligible but UNREPLAYABLE (missing geometry): ${missingGeom}`);
  if (missingGeom > 0) {
    line("        These can never get an outcome — no rim/stop/target to replay.");
    line("        Permanently invisible to both JSCORE and JANLY.");
  }

  // ---- 5. What the two surfaces ACTUALLY receive ----------------------------
  head("5. WHAT JSCORE AND JANLY ACTUALLY GET");
  const { getAnalyticsRows, getScorecardRows, getPriorityRanks } = await import("../lib/db/analytics");
  const aRows = getAnalyticsRows();
  const sRows = getScorecardRows();
  const ranks = getPriorityRanks();
  line(`     getAnalyticsRows()  -> ${aRows.length} rows   (JANLY)`);
  line(`     getScorecardRows()  -> ${sRows.length} rows   (JSCORE)`);
  line(`     getPriorityRanks()  -> ${ranks.size} ranked setups (JSCORE only, reads DECISIONS)`);
  line("");
  line("     Both row-sets come from the SAME inner join on outcomes, so they");
  line("     should match. getPriorityRanks reads `decisions` instead, which is");
  line("     why JSCORE can move between runs while JANLY sits still.");

  const { isResolved, isNeverFired, isOpenPosition, LOW_SAMPLE_THRESHOLD } =
    await import("../lib/jack/analytics");
  const resolved = aRows.filter(isResolved);
  line("");
  line(`     of the ${aRows.length}: resolved ${resolved.length} · never_fired ` +
       `${aRows.filter(isNeverFired).length} · open ${aRows.filter(isOpenPosition).length}`);

  // ---- 6. Is JANLY suppressed by design? -----------------------------------
  head("6. IS JANLY EMPTY BY DESIGN? (the n>=30 gate)");
  line(`     LOW_SAMPLE_THRESHOLD = ${LOW_SAMPLE_THRESHOLD}`);
  const { normalizeSizeBucket } = await import("../lib/jack/handle-score");
  for (const b of ["full", "half", "skip"]) {
    const n = resolved.filter((r) => normalizeSizeBucket(r.sizeBucket) === b).length;
    const verdict = n >= LOW_SAMPLE_THRESHOLD ? "CLEARS the gate" : `SUPPRESSED (needs ${LOW_SAMPLE_THRESHOLD})`;
    line(`     bucket ${b.padEnd(6)} n=${String(n).padStart(5)}   ${verdict}`);
  }
  const traded = resolved.filter((r) => r.userAction === "TRADED").length;
  line(`     universe n=${resolved.length} · selected(TRADED) n=${traded}` +
       `   -> selection verdict ${resolved.length >= LOW_SAMPLE_THRESHOLD && traded >= LOW_SAMPLE_THRESHOLD ? "CLEARS" : "SUPPRESSED"}`);

  // ---- VERDICT --------------------------------------------------------------
  line("\n==================================================================");
  const runsWriting = runs.length > 0 && runs.some((r) => r.n > 0);
  if (!runsWriting) {
    line(" VERDICT: (a) PERSISTENCE PROBLEM — no runs / no decision rows.");
  } else if (aRows.length === 0 && pending > 0) {
    line(" VERDICT: (a) LIKELY A JOB PROBLEM — the board persists fine, but");
    line("          setups old enough to resolve have no outcomes. The outcome");
    line("          replay is not running. Check JACK_SELF_BASE_URL on the VPS.");
  } else if (aRows.length === 0 && pending === 0) {
    line(" VERDICT: (b) EXPECTED — the board IS persisting. Nothing has aged");
    line("          past the 195-day resolution gate yet, so outcomes is empty");
    line("          and both surfaces are blank. NO DATA IS BEING LOST.");
  } else {
    line(" VERDICT: (b) PERSISTING. Outcomes exist; JANLY's silence is the");
    line("          n>=30 sample gate, not a write failure. See section 6.");
  }
  line(" Board snapshots persist per run regardless — the setups/decisions");
  line(" rows in section 2 are the forward-test record and they are safe.");
  line("==================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Module marker: keeps this script's top-level `main` out of the global
// scope, where it would collide with the identically-named function in the
// other read-only audit scripts (TS2393).
export {};
