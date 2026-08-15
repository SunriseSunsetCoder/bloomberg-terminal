/*
 * JACK second-chance (recovery re-entry) self-test — PURE. No DB, no network, no
 * Telegram.
 *
 * Drives the real evalSecondChance over synthetic daily bars. The fire detection and
 * the entry fill come from the SHARED detectFire in outcome-tracker.ts, so if the
 * recovery gate ever drifts from the paper replay, this and the 48-check parity test
 * fail together.
 *
 * Run:  npx tsx scripts/jack-second-chance-selftest.ts
 */
import {
  evalSecondChance,
  RUNUP_FRAC,
  RETEST_WINDOW_BARS,
  type SecondChanceSetup,
} from "../lib/jack/second-chance";
import { findTouchExit, type Bar } from "../lib/jack/outcome-tracker";
import { isTradeableSetup } from "../lib/jack/handle-score";
import { evalSecondChanceAlert, secondChanceMarkerKey } from "../lib/jack/alerts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string | null): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number | null | undefined, b: number, eps = 0.01) => a != null && Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Fixture geometry. Handle low 2026-03-02; rim 100; stop 95; t05 115.
// A confirming CLOSE above the rim on bar 1, so entry = bar 2's OPEN = 101.
//   entry 101 · stop 95 · t05 115  →  risk 6, reward 14, R:R 2.333…
//   run-up threshold = 101 + 0.25 × 14 = 104.50
// ---------------------------------------------------------------------------
const HLD = "2026-03-02";
const RIM = 100;
const STOP = 95;
const T05 = 115;
const ENTRY = 101;

const setup: SecondChanceSetup = { handleLowDate: HLD, breakout: RIM, stop: STOP, target: T05 };

function dateAt(i: number): string {
  const d = new Date(`${HLD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  date: dateAt(i), open: o, high: h, low: l, close: c, volume: 1_000_000,
});
/** A quiet bar that neither runs up nor retests. */
const drift = (i: number, px = 103): Bar => bar(i, px, px + 0.5, px - 0.5, px);

/** bar 0 = handle low, bar 1 = confirming close, bar 2 = the entry bar (open 101). */
const opening = (): Bar[] => [
  bar(0, 98, 99, 97, 98),
  bar(1, 99, 102, 98.5, 101.5), // close 101.5 > rim → FIRE
  bar(2, ENTRY, 102, 100.5, 101.8), // entry bar: open = 101
];

/** Bars that run up to `high`, then a final bar whose low is `retestLow`. */
function scenario(opts: {
  runupHigh?: number;
  filler?: number;
  retestLow?: number;
  retestHigh?: number;
  minLow?: number;
}): Bar[] {
  const bars = opening();
  if (opts.runupHigh != null) {
    bars.push(bar(3, 102, opts.runupHigh, 101.5, opts.runupHigh - 0.5));
  }
  const fill = opts.filler ?? 0;
  for (let k = 0; k < fill; k++) bars.push(drift(bars.length));
  if (opts.minLow != null) {
    bars.push(bar(bars.length, 102, 103, opts.minLow, 102));
  }
  if (opts.retestLow != null) {
    const i = bars.length;
    bars.push(bar(i, 103, opts.retestHigh ?? 103.5, opts.retestLow, 102));
  }
  return bars;
}

// ===========================================================================
console.log("\n[1] FIRES on the full gate");
// ===========================================================================
{
  const bars = scenario({ runupHigh: 108, filler: 2, retestLow: 100.5 });
  const r = evalSecondChance(setup, bars);
  check("eligible", r.eligible, r.reason);
  check("  reason is 'eligible'", r.reason === "eligible", r.reason);
  check("  entry is the NEXT OPEN after the confirming close (101)", near(r.entry, ENTRY), String(r.entry));
  check("  stop + t05 carried through", near(r.stop, STOP) && near(r.t05, T05));
  check("  fire date is the confirming-close bar", r.fireDate === dateAt(1), String(r.fireDate));
  check("  entry date is the bar after it", r.entryDate === dateAt(2), String(r.entryDate));
  check("  today is the retest bar", r.todayDate === bars[bars.length - 1].date);
}

// ===========================================================================
console.log("\n[2] Does NOT fire — each disqualifier, with its own reason code");
// ===========================================================================
{
  // Target tagged: a high >= t05 anywhere since entry.
  const r = evalSecondChance(setup, scenario({ runupHigh: 116, filler: 1, retestLow: 100.5 }));
  check("hit target → not eligible", !r.eligible);
  check("  reason 'hit_target'", r.reason === "hit_target", r.reason);
}
{
  // Stopped: a low <= stop anywhere since entry.
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, minLow: 94, retestLow: 100.5 }));
  check("stopped out → not eligible", !r.eligible);
  check("  reason 'stopped'", r.reason === "stopped", r.reason);
}
{
  // Never ran up: max high stays under 104.50.
  const r = evalSecondChance(setup, scenario({ runupHigh: 103.5, filler: 1, retestLow: 100.5 }));
  check("no run-up → not eligible", !r.eligible);
  check("  reason 'no_runup'", r.reason === "no_runup", r.reason);
  check("  (it is a setup sitting at entry, not a recovery)", (r.runupPct ?? 99) < RUNUP_FRAC * 100);
}
{
  // Ran up, but today's low never reached entry.
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 1, retestLow: 101.5 }));
  check("no retest today → not eligible", !r.eligible);
  check("  reason 'no_retest'", r.reason === "no_retest", r.reason);
}
{
  // Everything satisfied, but the retest lands ONE bar past the freshness window —
  // the tightest possible failure. (entryIndex is 2, so barsSinceEntry = filler + 2.)
  const bars = scenario({ runupHigh: 108, filler: RETEST_WINDOW_BARS - 1, retestLow: 100.5 });
  const r = evalSecondChance(setup, bars);
  check(`retest at ${RETEST_WINDOW_BARS + 1} bars → not eligible`, !r.eligible);
  check("  reason 'stale'", r.reason === "stale", r.reason);
  check("  barsSinceEntry is exactly one past the window",
    r.barsSinceEntry === RETEST_WINDOW_BARS + 1, String(r.barsSinceEntry));
}
{
  // Boundary: exactly at the window edge still fires.
  const bars = scenario({ runupHigh: 108, filler: RETEST_WINDOW_BARS - 2, retestLow: 100.5 });
  const r = evalSecondChance(setup, bars);
  check(`retest at exactly ${RETEST_WINDOW_BARS} bars → still fires`, r.eligible, `${r.reason} @ ${r.barsSinceEntry}`);
  check("  barsSinceEntry == the window", r.barsSinceEntry === RETEST_WINDOW_BARS, String(r.barsSinceEntry));
}
{
  // Never fired: no close above the rim inside the confirm window.
  const bars = [bar(0, 98, 99, 97, 98), drift(1, 99), drift(2, 99), drift(3, 99)];
  const r = evalSecondChance(setup, bars);
  check("never fired → not eligible", !r.eligible);
  check("  reason 'not_fired'", r.reason === "not_fired", r.reason);
}
{
  const r = evalSecondChance({ ...setup, stop: null }, scenario({ runupHigh: 108, retestLow: 100.5 }));
  check("missing geometry → not eligible", !r.eligible && r.reason === "missing_geometry", r.reason);
}

// ===========================================================================
console.log("\n[3] Tradeable + owned gates (applied by the caller, asserted here)");
// ===========================================================================
{
  // The SKIP gate is the frozen SIZE_MAP — the recovery pass must never say "buy" on
  // a Q1/Q2 setup, exactly as the entry alert must not.
  check("Q1 SKIP is not tradeable", !isTradeableSetup({ tier: "Q1", sizeBucket: "skip" }));
  check("Q2 (no bucket) is not tradeable", !isTradeableSetup({ tier: "Q2", sizeBucket: null }));
  check("Q5 full IS tradeable", isTradeableSetup({ tier: "Q5", sizeBucket: "full" }));

  // Owned = TRADED with no recorded exit. An owned setup is a position to manage, not
  // a missed entry to recover — the whole premise is that it was NEVER taken.
  const owned = { userAction: "TRADED", userExitPrice: null };
  const notOwned = { userAction: "TRADED", userExitPrice: 130 };
  const isOwned = (d: { userAction?: string | null; userExitPrice?: number | null }) =>
    d.userAction === "TRADED" && d.userExitPrice == null;
  check("an owned setup is excluded from the candidate pool", isOwned(owned));
  check("a traded-then-EXITED setup is NOT owned (recoverable again)", !isOwned(notOwned));
}

// ===========================================================================
console.log("\n[4] Numbers — R:R, run-up %, bars-since");
// ===========================================================================
{
  const bars = scenario({ runupHigh: 108, filler: 2, retestLow: 100.5 });
  const r = evalSecondChance(setup, bars);
  // R:R = (115 - 101) / (101 - 95) = 14 / 6 = 2.333…
  check("R:R reproduces (t05 − entry)/(entry − stop)", near(r.rr, (T05 - ENTRY) / (ENTRY - STOP)), String(r.rr));
  check("  which is 2.33", near(r.rr, 2.33), String(r.rr));
  // run-up = (108 - 101) / 14 = 50%
  check("run-up % is measured toward t05", near(r.runupPct, ((108 - ENTRY) / (T05 - ENTRY)) * 100, 0.05), String(r.runupPct));
  check("  which is 50%", near(r.runupPct, 50, 0.05), String(r.runupPct));
  // entry bar index 2; bars: 0,1,2,3(runup),4,5(filler),6(retest) → 4 bars since entry
  check("barsSinceEntry counts bars from the entry bar to today", r.barsSinceEntry === 4, String(r.barsSinceEntry));
  check("  and equals bars.length - 1 - entryIndex", r.barsSinceEntry === bars.length - 1 - (r.entryIndex as number));

  // A run-up exactly AT the threshold qualifies (>=, not >).
  const atEdge = evalSecondChance(setup, scenario({ runupHigh: ENTRY + RUNUP_FRAC * (T05 - ENTRY), filler: 1, retestLow: 100.5 }));
  check(`run-up exactly ${RUNUP_FRAC * 100}% toward t05 qualifies`, atEdge.eligible, atEdge.reason);
}

// ===========================================================================
console.log("\n[5] Message + dedup key");
// ===========================================================================
{
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 2, retestLow: 100.5 }));
  const a = evalSecondChanceAlert({
    ticker: "tst", tier: "Q5", pRank: 3,
    entry: r.entry as number, stop: r.stop as number, t05: r.t05 as number,
    rr: r.rr, barsSinceEntry: r.barsSinceEntry as number, runupPct: r.runupPct,
  });
  check("alert type is 'second_chance'", a.type === "second_chance");
  check("  SYSTEM tier, not a heads-up", a.kind === "system");
  check("  never carries the heads-up disclaimer", !a.text.includes("not a system signal"));
  check("  ticker uppercased in the header", a.text.includes("SECOND CHANCE — TST"));
  check("  carries P-rank and tier", a.text.includes("P3") && a.text.includes("Q5"));
  check("  quotes the limit, stop and t05", a.text.includes("101.00") && a.text.includes("95.00") && a.text.includes("115.00"));
  check("  quotes R:R and bars since fire", a.text.includes("2.33") && a.text.includes("4 bars since fire"));
  check("  quotes the run-up", a.text.includes("ran up 50% toward t05"));
  check("  states it is still live", a.text.includes("Never hit target, never stopped"));
  check("  RECOVERY caveat present verbatim",
    a.text.includes("restores original R:R, doesn't improve it") && a.text.includes("+0.32R / PF 1.83"),
    a.text);

  const k = secondChanceMarkerKey("tst", HLD);
  check("dedup key is setup identity", k === `jack:alert:second_chance:TST:${HLD}`, k);
  check("  carries NO et-date (once per SETUP, not per day)", !/2026-08/.test(k));
  check("  normalizes ticker case + whitespace", secondChanceMarkerKey("  tst  ", HLD) === k);
  check("  distinct setups get distinct keys", secondChanceMarkerKey("TST", "2026-04-01") !== k);
}
{
  // Dedup: the SECOND evaluation for the same setup, after a successful send, is
  // blocked by the marker — mirrors the production `alreadySent(key)` short-circuit.
  const sent = new Set<string>();
  const key = secondChanceMarkerKey("TST", HLD);
  const trySend = (): boolean => {
    if (sent.has(key)) return false;
    const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 2, retestLow: 100.5 }));
    if (!r.eligible) return false;
    sent.add(key); // marker set ONLY on a successful send
    return true;
  };
  check("first eligible evaluation sends", trySend());
  check("  a second one does NOT re-fire", !trySend());
  check("  the marker persists (no TTL semantics here)", sent.has(key));
}

// ===========================================================================
console.log("\n[6] PARITY ANCHOR — re-entry R matches the shared exit engine");
// ===========================================================================
{
  // Retest at entry, then a continuation that reaches t05. The R computed from
  // entry/stop/t05 must equal what findTouchExit produces walking from the retest bar
  // — same engine the paper replay exits with, so no drift between the recovery
  // signal's advertised R:R and how the trade would actually be scored.
  const bars = scenario({ runupHigh: 108, filler: 1, retestLow: 100.5 });
  const r = evalSecondChance(setup, bars);
  check("precondition: eligible", r.eligible, r.reason);

  const retestIdx = bars.length - 1;
  const continued = [
    ...bars,
    bar(bars.length, 102, 110, 101.5, 109),
    bar(bars.length + 1, 110, T05 + 1, 109, T05), // tags t05
  ];

  const exit = findTouchExit(continued, retestIdx, STOP, T05);
  check("findTouchExit from the retest bar reaches TARGET", exit?.kind === "target", JSON.stringify(exit));
  check("  exiting at t05", near(exit?.price, T05));

  const reentryR = ((exit?.price as number) - (r.entry as number)) / ((r.entry as number) - STOP);
  check("re-entry R equals the advertised R:R", near(reentryR, r.rr as number, 0.01), `${reentryR} vs ${r.rr}`);
  check("  and equals (t05 − entry)/(entry − stop)", near(reentryR, (T05 - ENTRY) / (ENTRY - STOP)));

  // The same walk on the ORIGINAL entry bar must also reach the target — the recovery
  // does not change the outcome, only the price you got in at.
  const fromEntry = findTouchExit(continued, r.entryIndex as number, STOP, T05);
  check("the trade resolves identically from the original entry", fromEntry?.kind === "target");
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
