/*
 * JACK Q3 re-bucket — relabel already-stored Q3 setups from `full` back to `half`.
 *
 *   npx tsx scripts/jack-rebucket-q3-to-half.ts            # DRY RUN (default)
 *   npx tsx scripts/jack-rebucket-q3-to-half.ts --apply    # actually writes
 *
 * WHY
 * ---
 * The 2026-07-20 promotion (0329ab5) moved Q3 half→full. Reverting SIZE_MAP fixes
 * every setup ingested FROM NOW ON, but rows already in the DB keep the bucket they
 * were stored with. Without this, `half` refills only as new Q3 setups arrive, while
 * `full` stays inflated by past Q3 trades — so the full-vs-half comparison JANLY
 * makes would be contaminated for months.
 *
 * WHAT IT CHANGES — AND WHAT IT DOES NOT
 * --------------------------------------
 * Changes ONE COLUMN: setups.size_bucket, 'full' -> 'half', for Q3 rows only.
 *
 * It does NOT touch:
 *   · outcomes  — no R, no exit_reason, no exit price. How a trade resolved is
 *     untouched; size_bucket never entered replaySetup or the notebook's _sim_trade
 *     (it is applied AFTER the simulation, as a grouping label).
 *   · decisions.size_bucket_at_mark — the FROZEN decision-time snapshot of what the
 *     operator was shown when they marked the trade. Rewriting it would falsify the
 *     record, and it is what JSCORE's AI-overlay arm reads. Deliberately left alone.
 *
 *     NOTE the consequence: getAnalyticsRows resolves the bucket as
 *     COALESCE(m.size_bucket_at_mark, s.size_bucket), so MARKED rows keep showing
 *     `full` even after this runs. That is intended — a marked row is graded as it
 *     was decided. This re-bucket therefore moves UNMARKED rows only, and the script
 *     reports both counts so the split is visible rather than surprising.
 *
 *   · handle_score, tier, priority, geometry — untouched.
 *   · TIER_RISK_PCT (basket.ts) — untouched. Q3 stays at 0.30% risk. This is a
 *     GRADING LABEL change, not a risk-dollar change.
 *
 * HOW Q3 IS IDENTIFIED
 * --------------------
 * Primary: handle_score -> quintileForScore() against the frozen HSCORE_EDGES, which
 * is exactly how the bucket was derived in the first place. Index 2 == Q3.
 * Fallback: the scanner's `tier` column == 'Q3' when handle_score is NULL.
 * A row matching neither is left alone and counted as unclassifiable.
 */
import { quintileForScore, SIZE_MAP } from "../lib/jack/handle-score";

type Row = {
  id: number;
  ticker: string;
  handle_low_date: string;
  handle_score: number | null;
  tier: string | null;
  size_bucket: string | null;
};

function isQ3(r: Row): { q3: boolean; how: string } {
  if (r.handle_score != null && Number.isFinite(r.handle_score)) {
    const q = quintileForScore(r.handle_score); // 0..4
    return { q3: q === 2, how: `hscore ${r.handle_score.toFixed(3)} -> Q${q + 1}` };
  }
  const t = (r.tier ?? "").toUpperCase().trim();
  if (t) return { q3: t === "Q3", how: `tier ${t} (no hscore)` };
  return { q3: false, how: "no hscore, no tier — UNCLASSIFIABLE" };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { getDb } = await import("../lib/db/init");
  const db = getDb();
  const line = (s = "") => console.log(s);

  line("\n==================================================================");
  line(` JACK Q3 re-bucket  full -> half     ${apply ? "*** APPLY ***" : "DRY RUN"}`);
  line("==================================================================");

  if (SIZE_MAP[2] !== "half") {
    line(`\nABORT: SIZE_MAP[2] is "${SIZE_MAP[2]}", not "half".`);
    line("Revert SIZE_MAP first — this script exists to make the DB agree with it,");
    line("not to introduce a labelling the code does not itself apply.");
    process.exit(2);
  }

  const rows = db
    .prepare(
      `SELECT id, ticker, handle_low_date, handle_score, tier, size_bucket
         FROM setups
        WHERE size_bucket = 'full'
        ORDER BY handle_low_date ASC`
    )
    .all() as Row[];

  line(`\nsetups currently bucketed 'full': ${rows.length}`);

  const targets: Row[] = [];
  let notQ3 = 0;
  let unclassifiable = 0;
  for (const r of rows) {
    const { q3, how } = isQ3(r);
    if (how.includes("UNCLASSIFIABLE")) unclassifiable++;
    if (q3) targets.push(r);
    else notQ3++;
  }

  line(`  Q3 (would move to half) : ${targets.length}`);
  line(`  Q4/Q5 (left as full)    : ${notQ3 - unclassifiable}`);
  line(`  unclassifiable          : ${unclassifiable}`);

  // Marked rows keep showing `full` via size_bucket_at_mark — surface the split.
  const markedIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT setup_id AS id FROM decisions WHERE size_bucket_at_mark IS NOT NULL`
        )
        .all() as Array<{ id: number }>
    ).map((x) => x.id)
  );
  const marked = targets.filter((t) => markedIds.has(t.id)).length;
  line("");
  line(`  of those Q3 rows, ${marked} carry a frozen size_bucket_at_mark and will`);
  line(`  STILL be graded 'full' by JANLY (COALESCE prefers the mark). ${targets.length - marked}`);
  line("  will actually move buckets in the analytics.");

  if (targets.length > 0) {
    line("\n  first 15:");
    line(`    ${"TICKER".padEnd(8)}${"HANDLE LOW".padEnd(13)}${"HOW".padEnd(28)}MARKED`);
    for (const t of targets.slice(0, 15)) {
      line(
        `    ${t.ticker.padEnd(8)}${t.handle_low_date.padEnd(13)}` +
          `${isQ3(t).how.padEnd(28)}${markedIds.has(t.id) ? "yes" : "-"}`
      );
    }
    if (targets.length > 15) line(`    ...and ${targets.length - 15} more`);
  }

  if (!apply) {
    line("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    line("==================================================================\n");
    return;
  }

  const upd = db.prepare(`UPDATE setups SET size_bucket = 'half' WHERE id = ?`);
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) upd.run(id);
  });
  tx(targets.map((t) => t.id));
  line(`\nAPPLIED: ${targets.length} setups relabelled full -> half.`);

  // ---- report the new bucket ns, the whole point of the exercise -------------
  const { getAnalyticsRows } = await import("../lib/db/analytics");
  const { isResolved, LOW_SAMPLE_THRESHOLD } = await import("../lib/jack/analytics");
  const { normalizeSizeBucket } = await import("../lib/jack/handle-score");
  const resolved = getAnalyticsRows().filter(isResolved);
  line("\nRESOLVED counts per bucket (what JANLY's n>=30 gate now sees):");
  for (const b of ["full", "half", "skip"]) {
    const n = resolved.filter((r) => normalizeSizeBucket(r.sizeBucket) === b).length;
    line(`  ${b.padEnd(6)} n=${String(n).padStart(5)}   ${n >= LOW_SAMPLE_THRESHOLD ? "CLEARS the gate" : `short of ${LOW_SAMPLE_THRESHOLD}`}`);
  }
  const allClear = ["full", "half", "skip"].every(
    (b) => resolved.filter((r) => normalizeSizeBucket(r.sizeBucket) === b).length >= LOW_SAMPLE_THRESHOLD
  );
  line("");
  line(
    allClear
      ? "  ALL THREE CLEAR — JANLY's handle-score verdict will now render."
      : "  Not all buckets clear yet — the verdict stays suppressed, correctly."
  );
  line("==================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
