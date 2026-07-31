/*
 * JACK one-time outcome RECOMPUTE — re-resolve rows that were computed under the OLD
 * (pre-parity) replay model, so a single methodology governs the paper PF.
 *
 * The old model fired on an intraday HIGH >= rim and searched up to 130 bars for that
 * touch. The corrected model fires on a confirming CLOSE > rim within 15 bars of the
 * handle low, fills at the next bar's open, and runs a 120-bar time stop. Rows already
 * carrying an exit_reason are EXCLUDED by getSetupsNeedingOutcomes, so they would
 * otherwise keep their stale verdicts forever and sit in the same PF as new rows.
 *
 * DRY RUN BY DEFAULT — prints old vs new per setup, writes nothing.
 *   npx tsx scripts/jack-recompute-outcomes.ts            # report only
 *   npx tsx scripts/jack-recompute-outcomes.ts --apply    # overwrite the theoretical columns
 *
 * Needs TIINGO_API_KEY (VPS). Only the THEORETICAL columns are rewritten — insertOutcome's
 * upsert preserves every user-fill column, so the live-realized arm is untouched.
 *
 * The per-row diagnostic (confirming close, fill bar, exit bar) is printed so the
 * jack-backfill-6-trades.ts EXPECTED table can be re-derived and hand-checked against
 * the notebook rule. Delete this script once that is done.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { replaySetup, CONFIRM_WINDOW_BARS, TIME_STOP_BARS } from "../lib/jack/outcome-tracker";

const APPLY = process.argv.includes("--apply");

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

async function fetchTiingoRaw(ticker: string, startDate: string): Promise<{ bars: Bar[]; error?: string }> {
  const token = process.env.TIINGO_API_KEY;
  if (!token) return { bars: [], error: "no TIINGO_API_KEY" };
  const end = new Date().toISOString().split("T")[0];
  // RAW (unadjusted) OHLC so nominal rim/stop/target levels line up — same as the
  // outcome tracker's raw=1 proxy mode.
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices?startDate=${startDate}&endDate=${end}&format=json`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) return { bars: [], error: `HTTP ${res.status}` };
    const data = (await res.json()) as Array<Bar & { date: string }>;
    return { bars: data.map((d) => ({ date: d.date.split("T")[0], open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume })) };
  } catch (e) {
    return { bars: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const f2 = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(2));
const fR = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`);

async function main(): Promise<number> {
  const { getDb } = await import("../lib/db/init");
  const write = await import("../lib/db/write");
  const db = getDb();

  console.log("\n=================================================================");
  console.log(` JACK outcome recompute — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  console.log(`  model: CLOSE > rim within ${CONFIRM_WINDOW_BARS} bars → fill next open → ${TIME_STOP_BARS}-bar time stop`);
  console.log("=================================================================\n");

  // Rows that already hold a theoretical verdict — i.e. those the normal gate skips.
  const rows = db
    .prepare(
      `SELECT s.id, s.ticker, s.handle_low_date AS handleLowDate,
              s.entry, s.stop, s.t05_target AS target, s.breakout_level AS breakoutLevel,
              o.exit_reason AS oldReason, o.R_realized AS oldR,
              o.entry_price_actual AS oldFill, o.fire_date AS oldFire,
              o.user_entry_price AS userEntry, o.user_exit_price AS userExit
         FROM setups s
         JOIN outcomes o ON o.setup_id = s.id
        WHERE o.exit_reason IS NOT NULL
          AND s.breakout_level IS NOT NULL AND s.stop IS NOT NULL AND s.t05_target IS NOT NULL
        ORDER BY s.handle_low_date, s.ticker`
    )
    .all() as Array<{
    id: number; ticker: string; handleLowDate: string;
    entry: number | null; stop: number | null; target: number | null; breakoutLevel: number | null;
    oldReason: string; oldR: number | null; oldFill: number | null; oldFire: string | null;
    userEntry: number | null; userExit: number | null;
  }>;

  if (rows.length === 0) {
    console.log("Nothing to recompute — no setup carries a theoretical outcome yet.\n");
    return 0;
  }
  if (!process.env.TIINGO_API_KEY) {
    console.error("TIINGO_API_KEY not set — run this on the VPS. Nothing done.\n");
    return 1;
  }

  console.log(`${rows.length} setup(s) hold a theoretical outcome from the old model:\n`);

  let changed = 0;
  const applied: string[] = [];
  for (const r of rows) {
    const { bars, error } = await fetchTiingoRaw(r.ticker, r.handleLowDate);
    if (error || bars.length === 0) {
      console.log(`  ${r.ticker.padEnd(6)} SKIPPED — ${error ?? "no bars"}`);
      continue;
    }

    const result = replaySetup(
      { id: r.id, ticker: r.ticker, handleLowDate: r.handleLowDate, entry: r.entry, stop: r.stop, target: r.target, breakoutLevel: r.breakoutLevel },
      bars
    );

    // Diagnostic: what the corrected rule saw, so the verdict can be hand-checked.
    const firstAfter = bars.findIndex((b) => b.date > r.handleLowDate);
    const windowBars = firstAfter === -1 ? [] : bars.slice(firstAfter, firstAfter + CONFIRM_WINDOW_BARS);
    const confirmBar = windowBars.find((b) => r.breakoutLevel != null && b.close > r.breakoutLevel);
    const maxCloseInWindow = windowBars.length ? Math.max(...windowBars.map((b) => b.close)) : null;
    const maxHighInWindow = windowBars.length ? Math.max(...windowBars.map((b) => b.high)) : null;

    const newReason = result.kind === "written" ? result.outcome.exitReason ?? "?" : result.kind;
    const newR = result.kind === "written" ? result.outcome.rRealized ?? null : null;
    const newFill = result.kind === "written" ? result.outcome.entryPriceActual ?? null : null;
    const differs = newReason !== r.oldReason || (newR ?? -999).toFixed(2) !== (r.oldR ?? -999).toFixed(2);
    if (differs) changed++;

    console.log(`  ${r.ticker.padEnd(6)} rim ${f2(r.breakoutLevel)} · stop ${f2(r.stop)} · target ${f2(r.target)}`);
    console.log(`    OLD (high>=rim, 130-bar search) : ${r.oldReason.padEnd(12)} ${fR(r.oldR).padEnd(8)} fill ${f2(r.oldFill)}  fired ${r.oldFire ?? "—"}`);
    console.log(`    NEW (close>rim, ${CONFIRM_WINDOW_BARS}-bar window)  : ${String(newReason).padEnd(12)} ${fR(newR).padEnd(8)} fill ${f2(newFill)}${result.kind === "written" && result.outcome.fireDate ? `  fired ${result.outcome.fireDate}` : ""}${differs ? "   <-- CHANGED" : ""}`);
    console.log(
      `    window: ${windowBars.length} bars from ${windowBars[0]?.date ?? "—"}` +
        `  max close ${f2(maxCloseInWindow)}  max high ${f2(maxHighInWindow)}` +
        `  → ${confirmBar ? `confirmed ${confirmBar.date} @ close ${f2(confirmBar.close)}` : "NO confirming close"}`
    );
    if (result.kind !== "written") console.log(`    (${result.kind}: ${result.reason})`);
    if (r.userEntry != null) {
      console.log(`    user fills present (entry ${f2(r.userEntry)}${r.userExit != null ? `, exit ${f2(r.userExit)}` : ", open"}) — PRESERVED by the upsert, live-realized arm unaffected`);
    }
    console.log();

    if (APPLY && result.kind === "written") {
      write.insertOutcome(result.outcome);
      applied.push(r.ticker);
    }
  }

  if (!APPLY) {
    console.log(`DRY RUN — nothing written. ${changed}/${rows.length} would change.`);
    console.log(`Re-run with --apply to rewrite the THEORETICAL columns (user fills are preserved).\n`);
    return 0;
  }
  console.log(`APPLIED — rewrote ${applied.length} outcome row(s): ${applied.join(" ")}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });

export {};
