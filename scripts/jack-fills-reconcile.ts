/*
 * JACK fills reconciliation — READ-ONLY. Writes nothing, changes nothing.
 *
 *   npx tsx scripts/jack-fills-reconcile.ts
 *
 * ANSWERS: are all my real closed trades captured, and which surfaces can SEE
 * them?
 *
 * THE MECHANISM THIS MEASURES
 * ---------------------------
 * An outcomes row has TWO independent halves:
 *
 *   THEORETICAL (what the setup offered) — exit_reason, R_realized, written ONLY
 *     by the replay (insertOutcome, outcome_source='tiingo_replay'), and only
 *     once a setup is past the 195-day resolution gate.
 *
 *   USER FILL (what you actually got) — user_entry_price, user_exit_price,
 *     user_R_realized, written IMMEDIATELY when you log a fill
 *     (updateUserFills, outcome_source='user_fill'). It does NOT set exit_reason
 *     or R_realized.
 *
 * The two surfaces key off DIFFERENT halves:
 *
 *   JSCORE  isRealizedTrade (scorecard.ts:61)
 *             userAction==='TRADED' && userRRealized != null && userExitPrice != null
 *           -> sees your fills the moment you log them.
 *
 *   JANLY   isResolved (analytics.ts:26)
 *             exitReason != null && RESOLVED_REASONS.has(exitReason) && rRealized != null
 *           -> needs the THEORETICAL half. A user-fill-only row has exit_reason
 *              NULL, so it is invisible: not resolved, not never_fired, and not
 *              "open" either (isOpenPosition requires userExitPrice == null).
 *              It falls into NO bucket and is counted nowhere.
 *
 * So a closed real trade shows in JSCORE immediately and does NOT reach JANLY
 * until the replay resolves that setup ~195 days after its handle low.
 *
 * NOTE ON outcome_source: insertOutcome's upsert overwrites outcome_source to
 * 'tiingo_replay' but does NOT touch the user_* columns. The source therefore
 * records which writer touched the row LAST, not what data it holds — a
 * 'tiingo_replay' row can still carry your fills. Count columns, not sources.
 *
 * Run on the VPS (needs jack.db).
 */

async function main(): Promise<void> {
  const { getDb } = await import("../lib/db/init");
  const db = getDb();
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const many = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  const line = (s = "") => console.log(s);
  const head = (s: string) => {
    line();
    line(`--- ${s} ${"-".repeat(Math.max(0, 66 - s.length))}`);
  };
  const q = (sql: string) => line(`     SQL: ${sql.replace(/\s+/g, " ").trim()}`);

  line("\n==================================================================");
  line(" JACK fills reconciliation — my real trades vs what is captured");
  line("==================================================================");

  // ---- 1. What have I marked? ----------------------------------------------
  head("1. WHAT I MARKED — setups flagged TRADED");
  const tradedSql = `SELECT COUNT(DISTINCT setup_id) AS n FROM decisions WHERE user_action = 'TRADED'`;
  q(tradedSql);
  const traded = one<{ n: number }>(tradedSql).n;
  line(`     setups marked TRADED: ${traded}`);

  // ---- 2. What fill data exists? -------------------------------------------
  head("2. FILL DATA in outcomes (written the moment you log a fill)");
  const fillSql = `
    SELECT
      COUNT(*)                                                        AS rows_total,
      COALESCE(SUM(CASE WHEN user_entry_price IS NOT NULL THEN 1 ELSE 0 END), 0)   AS with_entry,
      COALESCE(SUM(CASE WHEN user_exit_price  IS NOT NULL THEN 1 ELSE 0 END), 0)   AS with_exit,
      COALESCE(SUM(CASE WHEN user_R_realized  IS NOT NULL THEN 1 ELSE 0 END), 0)   AS with_userR,
      COALESCE(SUM(CASE WHEN exit_reason      IS NOT NULL THEN 1 ELSE 0 END), 0)   AS with_exit_reason,
      COALESCE(SUM(CASE WHEN R_realized       IS NOT NULL THEN 1 ELSE 0 END), 0)   AS with_theoR
    FROM outcomes`;
  q(fillSql);
  const f = one<Record<string, number>>(fillSql);
  line(`     outcomes rows total          : ${f.rows_total}`);
  line(`     with user ENTRY logged       : ${f.with_entry}`);
  line(`     with user EXIT logged        : ${f.with_exit}    <- your CLOSED trades`);
  line(`     with user_R_realized         : ${f.with_userR}`);
  line(`     with exit_reason (theoretical): ${f.with_exit_reason}`);
  line(`     with R_realized  (theoretical): ${f.with_theoR}    <- what JANLY needs`);

  // ---- 3. Source vs content -------------------------------------------------
  head("3. outcome_source vs ACTUAL CONTENT (source can mislead)");
  const srcSql = `
    SELECT outcome_source,
           COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN user_exit_price IS NOT NULL THEN 1 ELSE 0 END), 0) AS closed_fills,
           COALESCE(SUM(CASE WHEN exit_reason     IS NOT NULL THEN 1 ELSE 0 END), 0) AS theoretical
      FROM outcomes GROUP BY outcome_source`;
  q(srcSql);
  line(`     ${"source".padEnd(16)}${"rows".padEnd(8)}${"my closed fills".padEnd(18)}theoretical`);
  for (const r of many<Record<string, string | number>>(srcSql)) {
    line(`     ${String(r.outcome_source).padEnd(16)}${String(r.n).padEnd(8)}` +
         `${String(r.closed_fills).padEnd(18)}${r.theoretical}`);
  }
  line("");
  line("     insertOutcome overwrites outcome_source to 'tiingo_replay' but does");
  line("     NOT clear the user_* columns, so a replay row can still hold fills.");

  // ---- 4. THE GAP -----------------------------------------------------------
  head("4. THE GAP — marked TRADED but no fill captured");
  const gapSql = `
    SELECT s.id, s.ticker, s.handle_low_date,
           CASE WHEN o.setup_id IS NULL THEN 'NO OUTCOMES ROW'
                WHEN o.user_entry_price IS NULL THEN 'no entry logged'
                WHEN o.user_exit_price  IS NULL THEN 'entry only, still open'
                WHEN o.user_R_realized  IS NULL THEN 'entry+exit but R not computed'
                ELSE 'complete' END AS state
      FROM decisions d
      JOIN setups s   ON s.id = d.setup_id
      LEFT JOIN outcomes o ON o.setup_id = s.id
     WHERE d.user_action = 'TRADED'
     GROUP BY s.id
     ORDER BY state, s.handle_low_date`;
  q(gapSql);
  const gaps = many<{ id: number; ticker: string; handle_low_date: string; state: string }>(gapSql);
  const byState = new Map<string, number>();
  for (const g of gaps) byState.set(g.state, (byState.get(g.state) ?? 0) + 1);
  for (const [state, n] of [...byState.entries()].sort()) {
    line(`     ${state.padEnd(32)} ${n}`);
  }
  const problems = gaps.filter((g) => g.state !== "complete" && g.state !== "entry only, still open");
  if (problems.length > 0) {
    line("");
    line("     >> TRADES WITH A CAPTURE PROBLEM:");
    for (const p of problems.slice(0, 40)) {
      line(`        ${p.ticker.padEnd(8)} ${p.handle_low_date}   ${p.state}`);
    }
    if (problems.length > 40) line(`        ...and ${problems.length - 40} more`);
    line("");
    line("     'no entry logged' / 'R not computed' usually means the fill form was");
    line("     saved with a missing price, or entry == stop (R is undefined then).");
  } else {
    line("");
    line("     >> No capture gaps. Every TRADED setup has the fill data it should.");
  }

  // ---- 5. What each surface actually counts ---------------------------------
  head("5. WHAT EACH SURFACE COUNTS (the predicates, applied for real)");
  const { getScorecardRows, getAnalyticsRows } = await import("../lib/db/analytics");
  const { isRealizedTrade, isOpenRow } = await import("../lib/jack/scorecard");
  const { isResolved, isNeverFired, isOpenPosition } = await import("../lib/jack/analytics");
  const sRows = getScorecardRows();
  const aRows = getAnalyticsRows();

  const jscoreLive = sRows.filter(isRealizedTrade).length;
  const jscoreOpen = sRows.filter(isOpenRow).length;
  const janlyResolved = aRows.filter(isResolved).length;
  const janlyNever = aRows.filter(isNeverFired).length;
  const janlyOpen = aRows.filter(isOpenPosition).length;

  line(`     JSCORE live-realized (your closed fills) : ${jscoreLive}`);
  line(`     JSCORE open positions                    : ${jscoreOpen}`);
  line("");
  line(`     JANLY resolved                           : ${janlyResolved}`);
  line(`     JANLY never_fired                        : ${janlyNever}`);
  line(`     JANLY open                               : ${janlyOpen}`);
  const invisible = aRows.length - janlyResolved - janlyNever - janlyOpen;
  line(`     JANLY counted NOWHERE                    : ${invisible}   <- the blind spot`);
  line("");
  line("     Rows counted nowhere are user-fill-only: exit_reason is NULL so they");
  line("     are not 'resolved', and user_exit_price is set so they are not 'open'.");

  // ---- 6. The closed trades, one line each ----------------------------------
  head("6. YOUR CLOSED TRADES — and whether JANLY can see each one");
  const closedSql = `
    SELECT s.ticker, s.handle_low_date, o.user_entry_date, o.user_exit_date,
           o.user_R_realized, o.exit_reason, o.R_realized, o.outcome_source
      FROM outcomes o JOIN setups s ON s.id = o.setup_id
     WHERE o.user_exit_price IS NOT NULL
     ORDER BY o.user_exit_date DESC`;
  q(closedSql);
  const closed = many<Record<string, string | number | null>>(closedSql);
  line(`     ${closed.length} closed trade(s)`);
  if (closed.length > 0) {
    line("");
    line(`     ${"TICKER".padEnd(8)}${"EXITED".padEnd(12)}${"userR".padEnd(8)}` +
         `${"exit_reason".padEnd(13)}${"theoR".padEnd(8)}JANLY?`);
    for (const c of closed) {
      const visible = c.exit_reason != null && c.R_realized != null;
      line(
        `     ${String(c.ticker ?? "?").padEnd(8)}` +
        `${String(c.user_exit_date ?? "-").padEnd(12)}` +
        `${(c.user_R_realized == null ? "-" : Number(c.user_R_realized).toFixed(2)).padEnd(8)}` +
        `${String(c.exit_reason ?? "(null)").padEnd(13)}` +
        `${(c.R_realized == null ? "-" : Number(c.R_realized).toFixed(2)).padEnd(8)}` +
        `${visible ? "yes" : "NO"}`
      );
    }
  }

  line("\n==================================================================");
  line(` Marked TRADED: ${traded} · closed fills: ${f.with_exit} · JSCORE sees ${jscoreLive} · JANLY sees ${janlyResolved}`);
  if (f.with_exit > 0 && janlyResolved < f.with_exit) {
    line("");
    line(" Your closed trades ARE saved — JSCORE reads them. JANLY needs the");
    line(" THEORETICAL half (exit_reason + R_realized), which only the replay");
    line(" writes, and only ~195 days after a setup's handle low. Until then");
    line(" those trades are recorded but invisible to JANLY. Nothing is lost.");
  }
  line("==================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
