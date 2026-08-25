/*
 * JACK tier-gate audit — READ-ONLY diagnostics. Writes nothing, changes nothing.
 *
 *   npx tsx scripts/jack-tier-gate-audit.ts
 *
 * WHAT THIS ANSWERS
 * -----------------
 * isTradeableSetup() checks the size bucket BEFORE the tier:
 *
 *     if (bucket === "skip")               return false;
 *     if (bucket === "full" || "half")     return true;   // <-- short-circuits
 *     if (tier === "Q1" || tier === "Q2")  return false;  // <-- never reached
 *
 * So a setup carrying tier Q1/Q2 AND a full/half bucket is reported TRADEABLE,
 * which contradicts the frozen rule ("Q1/Q2 are never traded — breakout or not")
 * and is how a Q1/Q2 setup can raise a PROMOTED / ENTRY CONFIRMED alert.
 *
 * Moving the tier veto above the bucket check fixes it — but isTradeableSetup
 * also gates the Basket Sizer, the LIVE display group and the alert scope set.
 * This script measures that blast radius BEFORE anything is changed: how many
 * rows actually sit in the leak set, and exactly which ones would move.
 *
 * Run it on the VPS (it needs jack.db). Nothing here mutates state.
 */

type Row = {
  setupId: number;
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending";
  tier: string | null;
  sizeBucket: string | null;
  handleScore: number | null;
  entryStatus?: string | null;
  retiredAt: string | null;
  firedStatus: "confirmed" | "late" | "resolved" | null;
};

/**
 * The proposed rule — tier Q1/Q2 vetoes, whatever the bucket says.
 *
 * "Today's rule" is NOT restated here: the audit imports the REAL
 * isTradeableSetup, so it can never drift from what actually ships. That also
 * makes this script self-verifying — run it again AFTER the fix and the leak set
 * must be empty, because the two functions will then agree.
 */
function isTradeableFixed(s: { sizeBucket?: string | null; tier?: string | null }): boolean {
  const t = (s.tier ?? "").toUpperCase().trim();
  if (t === "Q1" || t === "Q2") return false;
  const b = (s.sizeBucket ?? "").toLowerCase().trim();
  if (b === "skip") return false;
  return true;
}

async function main(): Promise<void> {
  const { getDb } = await import("../lib/db/init");
  const { isTradeableSetup: isTradeableNow } = await import("../lib/jack/handle-score");
  const db = getDb();
  const many = <T>(sql: string, ...p: unknown[]): T[] => db.prepare(sql).all(...p) as T[];
  const line = (s = "") => console.log(s);
  const head = (s: string) => {
    line();
    line(`--- ${s} ${"-".repeat(Math.max(0, 62 - s.length))}`);
  };

  line("\n=================================================================");
  line(" JACK tier-gate audit (read-only) — impact of the Q1/Q2 veto fix");
  line("=================================================================");

  // ---- the CURRENT board, the set the alerts and the basket actually see -----
  const { getCurrentBoard } = await import("../lib/db/read");
  const board = getCurrentBoard();
  if (board.runId === null) {
    line("\nNo current run — jack.db has no board to audit. Nothing to report.");
    return;
  }
  const rows = [...board.live, ...board.pending] as unknown as Row[];
  line(`\ncurrent run #${board.runId} · ${rows.length} rows (${board.live.length} live + ${board.pending.length} pending)`);

  // ---- cross-tab: tier x bucket, so the SHAPE is visible ---------------------
  head("tier x size_bucket (current board)");
  const tab = new Map<string, number>();
  for (const r of rows) {
    const t = (r.tier ?? "(null)").toUpperCase().trim() || "(empty)";
    const b = (r.sizeBucket ?? "(null)").toLowerCase().trim() || "(empty)";
    const k = `${t} | ${b}`;
    tab.set(k, (tab.get(k) ?? 0) + 1);
  }
  [...tab.entries()].sort().forEach(([k, n]) => line(`  ${k.padEnd(24)} ${n}`));

  // ---- THE LEAK SET ---------------------------------------------------------
  head("LEAK SET — rows whose tradeability CHANGES under the fix");
  const leak = rows.filter((r) => isTradeableNow(r) !== isTradeableFixed(r));
  if (leak.length === 0) {
    line("  NONE. The fix is behaviour-neutral on the current board:");
    line("  no row carries a Q1/Q2 tier together with a full/half bucket.");
    line("  (It still closes the hole for future scans.)");
  } else {
    line(`  ${leak.length} row(s) are TRADEABLE today and would become SKIP:\n`);
    line(
      "  " +
        "TICKER".padEnd(8) +
        "TIER".padEnd(6) +
        "BUCKET".padEnd(8) +
        "SECTION".padEnd(9) +
        "ENTRY_ST".padEnd(10) +
        "FIRED".padEnd(11) +
        "HSCORE"
    );
    for (const r of leak) {
      line(
        "  " +
          (r.ticker ?? "?").padEnd(8) +
          (r.tier ?? "-").padEnd(6) +
          (r.sizeBucket ?? "-").padEnd(8) +
          (r.section ?? "-").padEnd(9) +
          (r.entryStatus ?? "-").padEnd(10) +
          (r.firedStatus ?? "-").padEnd(11) +
          (r.handleScore != null ? r.handleScore.toFixed(3) : "-")
      );
    }
  }

  // ---- per-consumer impact --------------------------------------------------
  head("WHAT MOVES, per consumer");
  const firedLeak = leak.filter((r) => r.firedStatus === "confirmed" || r.firedStatus === "late");
  const liveLeak = leak.filter((r) => r.section === "live");
  const freshLeak = leak.filter((r) => {
    const s = (r.entryStatus ?? "").toUpperCase();
    return s === "FRESH" || s === "AGING";
  });
  line(`  alerts (PROMOTED / ENTRY CONFIRMED) : ${firedLeak.length} row(s) would stop alerting`);
  line(`  LIVE display group                  : ${liveLeak.length} row(s) would leave`);
  line(`  Basket Sizer (isBasketEligible)     : ${leak.filter((r) => r.retiredAt == null).length} row(s) would leave`);
  line(`  P5 nightly digest FRESH/AGING lists : ${freshLeak.length} row(s) would be suppressed+counted`);

  // ---- the P5 digest problem, measured INDEPENDENTLY of the leak set --------
  // The digest buckets purely on entry_status, which the Phase 3 stamper sets for
  // EVERY setup regardless of tier. So it lists Q1/Q2 rows even where
  // isTradeableSetup is behaving correctly — a separate bug from the gate leak.
  head("P5 DIGEST — Q1/Q2 rows carrying a FRESH/AGING entry_status");
  const digestBad = rows.filter((r) => {
    const t = (r.tier ?? "").toUpperCase().trim();
    const s = (r.entryStatus ?? "").toUpperCase();
    return (t === "Q1" || t === "Q2") && (s === "FRESH" || s === "AGING");
  });
  if (digestBad.length === 0) {
    line("  NONE on the current board.");
  } else {
    line(`  ${digestBad.length} row(s) the digest would list as takeable but must not:`);
    for (const r of digestBad) {
      line(
        `    ${(r.ticker ?? "?").padEnd(8)} ${(r.tier ?? "-").padEnd(4)} ` +
          `${(r.entryStatus ?? "-").padEnd(8)} bucket=${r.sizeBucket ?? "-"}`
      );
    }
    line("\n  NOTE: these are listed by entry_status alone. Fixing the TS gate does");
    line("  NOT fix this — the digest needs its own mirrored gate.");
  }

  // ---- historical shape, beyond the current run -----------------------------
  head("HISTORICAL — every setup ever stored (not just this run)");
  const hist = many<{ tier: string | null; size_bucket: string | null; n: number }>(
    `SELECT tier, size_bucket, COUNT(*) AS n
       FROM setups
      GROUP BY tier, size_bucket
      ORDER BY tier, size_bucket`
  );
  let histLeak = 0;
  for (const h of hist) {
    const t = (h.tier ?? "").toUpperCase().trim();
    const b = (h.size_bucket ?? "").toLowerCase().trim();
    const bad = (t === "Q1" || t === "Q2") && (b === "full" || b === "half");
    if (bad) histLeak += h.n;
    line(`  ${(h.tier ?? "(null)").padEnd(8)} ${(h.size_bucket ?? "(null)").padEnd(8)} ${String(h.n).padStart(6)}${bad ? "   <-- LEAK" : ""}`);
  }
  line(`\n  historical leak rows: ${histLeak}`);

  line("\n=================================================================");
  line(
    leak.length === 0 && digestBad.length === 0
      ? " VERDICT: the gate fix is behaviour-neutral on the current board."
      : " VERDICT: the fix CHANGES the current board — review the rows above."
  );
  line("=================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Module marker: keeps this script's top-level `main` out of the global scope,
// where it collided with an ambient declaration and broke `tsc --noEmit`
// (TS2393). Every other script under scripts/ is already a module; this file
// was the sole exception.
export {};
