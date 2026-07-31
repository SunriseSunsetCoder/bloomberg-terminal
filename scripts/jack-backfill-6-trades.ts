/*
 * JACK backfill — 6 reconstructed historical trades (correctness test for the replay).
 *
 * Inserts 6 pre-persistence trades as setups (reconstructed, fill-anchored geometry),
 * marks each TRADED with the real fills, then runs the outcome-tracker replay
 * (replaySetup — the SAME pure function /api/jack-outcomes uses) over real Tiingo
 * daily history and compares the computed THEORETICAL outcome to the known result.
 *
 * Run (on the VPS, which has TIINGO_API_KEY in .env.local):
 *     npx tsx scripts/jack-backfill-6-trades.ts
 *
 * Inserts DATA into data/jack.db (idempotent on the natural key ticker+handle_low_date).
 * The replay step needs TIINGO_API_KEY; without it, insertion + user-fill R still run
 * and the replay is SKIPPED with a clear notice (e.g. on the keyless Win10 dev clone).
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import * as write from "../lib/db/write";
import * as read from "../lib/db/read";
import { replaySetup } from "../lib/jack/outcome-tracker";

// NOTE: replaySetup no longer takes a window from callers — it runs the FROZEN parity
// windows (CONFIRM_WINDOW_BARS = 15 confirm, TIME_STOP_BARS = 120 exit) that mirror the
// backtest. The old `RESOLUTION_DAYS = 90` argument here scanned a non-parity window and
// has been removed.

interface Setup {
  ticker: string;
  handleLowDate: string;
  breakout: number;
  entry: number;
  stop: number;
  target: number;
  cupDepthPct: number;
  handleRetrPct: number;
}
interface Fill {
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  note: string;
}
interface Expected {
  reason: "target" | "still_open"; // required theoretical outcome
  approxR: number | null;
  winner: boolean; // correctness gate: winners MUST fire and not stop/never_fire
}

const SETUPS: Setup[] = [
  { ticker: "BNY", handleLowDate: "2026-05-08", breakout: 138.6, entry: 138.74, stop: 130.03, target: 147.95, cupDepthPct: 14.4, handleRetrPct: 45.2 },
  { ticker: "UNM", handleLowDate: "2026-05-07", breakout: 82.21, entry: 82.83, stop: 79.33, target: 88.2, cupDepthPct: 14.9, handleRetrPct: 23.4 },
  { ticker: "WELL", handleLowDate: "2026-05-18", breakout: 221.68, entry: 221.9, stop: 211.57, target: 238.89, cupDepthPct: 16.0, handleRetrPct: 28.7 },
  { ticker: "EXPD", handleLowDate: "2026-06-24", breakout: 168.52, entry: 168.69, stop: 158.8, target: 179.82, cupDepthPct: 14.2, handleRetrPct: 42.3 },
  { ticker: "MET", handleLowDate: "2026-06-24", breakout: 89.62, entry: 90.88, stop: 84.1, target: 99.58, cupDepthPct: 23.0, handleRetrPct: 27.3 },
  { ticker: "MAA", handleLowDate: "2026-06-22", breakout: 140.75, entry: 141.96, stop: 130.81, target: 150.76, cupDepthPct: 14.4, handleRetrPct: 49.0 },
];

const FILLS: Record<string, Fill> = {
  BNY: { entryDate: "2026-05-19", entryPrice: 136.21, exitDate: "2026-07-06", exitPrice: 147.48, note: "closed winner" },
  UNM: { entryDate: "2026-05-19", entryPrice: 82.83, exitDate: "2026-07-06", exitPrice: 91.99, note: "closed winner" },
  WELL: { entryDate: "2026-05-19", entryPrice: 212.93, exitDate: "2026-07-02", exitPrice: 235.0, note: "closed; entered pre-breakout" },
  EXPD: { entryDate: "2026-07-07", entryPrice: 167.89, exitDate: "2026-07-10", exitPrice: 172.3, note: "closed early; setup later hit ~181" },
  MET: { entryDate: "2026-07-07", entryPrice: 90.98, exitDate: null, exitPrice: null, note: "still open, ~+3%" },
  MAA: { entryDate: "2026-07-07", entryPrice: 141.96, exitDate: null, exitPrice: null, note: "still open, ~-5%" },
};

// ⚠ UNVERIFIED AGAINST THE CORRECTED REPLAY MODEL (2026-07-31).
//
// These expectations were derived when replaySetup fired on an intraday HIGH >= rim
// and searched up to 130 bars for it. The replay now mirrors the backtest: a
// confirming CLOSE > rim within 15 bars of the handle low. A winner whose breakout was
// an intraday poke, or which confirmed late, SHOULD now come back never_fired — and
// this table will report FAIL until it is re-derived.
//
// DO NOT loosen these to make the script pass. Re-derive them from
// `npx tsx scripts/jack-recompute-outcomes.ts` (dry run, on the VPS), which prints the
// confirming close / fill / exit per ticker, and hand-check one or two against the
// notebook rule before freezing.
const EXPECTED: Record<string, Expected> = {
  UNM: { reason: "target", approxR: 1.5, winner: true },
  BNY: { reason: "target", approxR: null, winner: true },
  WELL: { reason: "target", approxR: null, winner: true },
  EXPD: { reason: "target", approxR: 1.1, winner: true },
  MET: { reason: "still_open", approxR: null, winner: false },
  MAA: { reason: "still_open", approxR: null, winner: false },
};

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

async function fetchTiingoRaw(ticker: string, startDate: string): Promise<{ bars: Bar[]; error?: string }> {
  const token = process.env.TIINGO_API_KEY;
  if (!token) return { bars: [], error: "no TIINGO_API_KEY" };
  const end = new Date().toISOString().split("T")[0];
  // RAW (unadjusted) OHLC so nominal breakout/stop/target levels line up — same as
  // the /api/tiingo/eod route's raw=1 mode that the outcome tracker uses.
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices?startDate=${startDate}&endDate=${end}&format=json`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) return { bars: [], error: `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}` };
    const data = (await res.json()) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    return { bars: data.map((d) => ({ date: d.date.split("T")[0], open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume })) };
  } catch (e) {
    return { bars: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function fmtR(r: number | null | undefined): string {
  return r == null ? "  —  " : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
}

async function main() {
  const now = new Date().toISOString();

  // ---- 1. validation-run context so the backfilled trades are queryable ----
  const runId = write.insertValidationRun({
    timestamp: now, inputRowCount: SETUPS.length, totalFinalCount: SETUPS.length,
    liveFinalCount: SETUPS.length, pendingFinalCount: 0, liveDroppedStale: 0, pendingDroppedStale: 0,
    liveDroppedOverCap: 0, pendingDroppedOverCap: 0, tiingoAttempted: 0, tiingoSucceeded: 0,
    riskPerTrade: 2000, model: "backfill", parseSuccess: true,
  });

  // ---- setups + decisions ----
  const setupIdMap = new Map<string, number>();
  for (const s of SETUPS) {
    const id = write.upsertSetup(
      { ticker: s.ticker, handleLowDate: s.handleLowDate, status: "just_fired", entry: s.entry, stop: s.stop, t05Target: s.target, breakoutLevel: s.breakout, cupDepthPct: s.cupDepthPct, handleRetrPct: s.handleRetrPct },
      now
    );
    setupIdMap.set(`${s.ticker}|${s.handleLowDate}`, id);
  }
  const { ids } = write.insertDecisions(
    SETUPS.map((s) => ({ ticker: s.ticker, handleLowDate: s.handleLowDate, section: "live" as const, decision: "TRADE" })),
    runId, setupIdMap
  );

  // ---- 2. mark TRADED + log fills (user_R = (exit-entry)/(entry-stop)) ----
  const userR: Record<string, number | null> = {};
  for (const s of SETUPS) {
    const setupId = setupIdMap.get(`${s.ticker}|${s.handleLowDate}`)!;
    const decisionId = ids.find((x) => x.ticker === s.ticker)!.decisionId;
    read.markDecisionUserAction(decisionId, "TRADED");
    const f = FILLS[s.ticker];
    const res = write.updateUserFills(setupId, f.entryPrice, f.entryDate, f.exitPrice, f.exitDate);
    userR[s.ticker] = res.userRRealized;
  }

  console.log("\n=== INSERTED: 6 setups + decisions (TRADED) + fills ===");
  for (const s of SETUPS) {
    const f = FILLS[s.ticker];
    console.log(`  ${s.ticker.padEnd(4)} TRADED  entry ${String(f.entryPrice).padStart(7)} (${f.entryDate})  exit ${f.exitPrice == null ? "  open " : String(f.exitPrice).padStart(7)}${f.exitDate ? ` (${f.exitDate})` : ""}  user_R ${fmtR(userR[s.ticker])}  — ${f.note}`);
  }

  // ---- 3. replay (theoretical outcome) over real Tiingo history ----
  if (!process.env.TIINGO_API_KEY) {
    console.log("\n=== REPLAY SKIPPED — no TIINGO_API_KEY on this machine ===");
    console.log("  Insertion + user-fill R are done. Run this script on the VPS (has the key)");
    console.log("  to compute theoretical outcomes and print the comparison table.");
    return;
  }

  const computed: Record<string, { reason: string; r: number | null; fired: boolean; note?: string }> = {};
  for (const s of SETUPS) {
    const setupId = setupIdMap.get(`${s.ticker}|${s.handleLowDate}`)!;
    const { bars, error } = await fetchTiingoRaw(s.ticker, s.handleLowDate);
    if (error || bars.length === 0) { computed[s.ticker] = { reason: "NO_DATA", r: null, fired: false, note: error }; continue; }
    const setupForReplay = { id: setupId, ticker: s.ticker, handleLowDate: s.handleLowDate, entry: s.entry, stop: s.stop, target: s.target, breakoutLevel: s.breakout };
    const result = replaySetup(setupForReplay, bars);
    if (result.kind === "written") {
      write.insertOutcome(result.outcome);
      computed[s.ticker] = { reason: result.outcome.exitReason ?? "?", r: result.outcome.rRealized ?? null, fired: result.outcome.fired };
    } else {
      // deferred (still resolving — not enough forward bars) or skipped (bad geometry)
      computed[s.ticker] = { reason: result.kind === "deferred" ? "still_open" : "skipped", r: null, fired: result.kind === "deferred", note: result.reason };
    }
  }

  // ---- 4. comparison table + PASS/FAIL ----
  console.log("\n=== REPLAY COMPARISON (computed theoretical vs expected) ===");
  console.log("  ticker | computed        R      | expected     | user_R  | verdict");
  console.log("  -------+-----------------------+--------------+---------+--------");
  let allPass = true;
  for (const s of SETUPS) {
    const c = computed[s.ticker];
    const e = EXPECTED[s.ticker];
    // Correctness gate: winners must fire and NOT stop/never_fire (ideally target).
    // still_open ones must be unresolved (still_open/deferred), NOT stopped.
    let pass: boolean;
    if (e.winner) pass = c.fired && c.reason !== "stop" && c.reason !== "never_fired";
    else pass = c.reason === "still_open";
    if (!pass) allPass = false;
    const compStr = `${c.reason}`.padEnd(12) + fmtR(c.r);
    console.log(`  ${s.ticker.padEnd(6)} | ${compStr.padEnd(21)} | ${e.reason.padEnd(12)} | ${fmtR(userR[s.ticker])} | ${pass ? "PASS" : "*** FAIL ***"}${c.note ? "  (" + c.note + ")" : ""}`);
  }
  console.log(`\n  ${allPass ? "✅ REPLAY VALIDATION PASSED — computed ≈ expected for all 6" : "❌ REPLAY VALIDATION FAILED — see FAIL rows above (investigate replay logic, not paper over)"}`);
  console.log("\n  Note EXPD: theoretical target_hit (~+1.1R, setup ran to ~181) vs your actual");
  console.log("  +0.4R (exited early at 172.30) — the theoretical-vs-execution divergence.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
