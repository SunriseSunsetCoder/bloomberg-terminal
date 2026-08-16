/*
 * JACK second-chance (ARMED recovery) self-test — PURE. No DB, no network, no Telegram.
 *
 * Drives the real evalSecondChance over synthetic daily bars. The fire detection and the
 * entry fill come from the SHARED detectFire in outcome-tracker.ts, so if the recovery
 * gate ever drifts from the paper replay, this and the 48-check parity test fail together.
 *
 * ARMED semantics: the alert fires the evening the run-up crosses the threshold with the
 * pullback STILL AHEAD — not on the retest, which is an intraday event an EOD pass can
 * only ever report a day late. The economics are unchanged (same 0.25 / 10-bar config,
 * same entry/stop/t05); §6 pins that down.
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
import { evalSecondChanceAlert, secondChanceMarkerKey, addTradingDaysISO } from "../lib/jack/alerts";

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
//   arming threshold = 101 + 0.25 × 14 = 104.50
// ---------------------------------------------------------------------------
const HLD = "2026-03-02";
const RIM = 100;
const STOP = 95;
const T05 = 115;
const ENTRY = 101;
const ARM_AT = ENTRY + RUNUP_FRAC * (T05 - ENTRY); // 104.50

const setup: SecondChanceSetup = { handleLowDate: HLD, breakout: RIM, stop: STOP, target: T05 };

function dateAt(i: number): string {
  const d = new Date(`${HLD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  date: dateAt(i), open: o, high: h, low: l, close: c, volume: 1_000_000,
});
/** A quiet bar: low 102.5, strictly ABOVE entry, so it never counts as a retest. */
const drift = (i: number, px = 103): Bar => bar(i, px, px + 0.5, px - 0.5, px);

/**
 * bar 0 = handle low, bar 1 = confirming close, bar 2 = the entry bar (open 101).
 *
 * NOTE the entry bar's low of 100.5 — BELOW entry. That is deliberate: a bar that opens
 * at `entry` almost always trades under it, and if the entry bar counted as a retest
 * nothing would ever arm. §2 asserts it does not.
 */
const opening = (): Bar[] => [
  bar(0, 98, 99, 97, 98),
  bar(1, 99, 102, 98.5, 101.5), // close 101.5 > rim → FIRE
  bar(2, ENTRY, 102, 100.5, 101.8), // entry bar: open = 101, low 100.5 (< entry)
];

/**
 * Bars from the opening, optionally running up, drifting, and finally dipping.
 * `dipLow` produces a POST-entry bar that trades down to that low — the "pullback has
 * already come and gone" case (or, low enough, the stop-out case).
 */
function scenario(opts: {
  runupHigh?: number;
  filler?: number;
  dipLow?: number;
  midLow?: number;
}): Bar[] {
  const bars = opening();
  if (opts.runupHigh != null) {
    bars.push(bar(3, 102, opts.runupHigh, 101.5, opts.runupHigh - 0.5));
  }
  const fill = opts.filler ?? 0;
  for (let k = 0; k < fill; k++) bars.push(drift(bars.length));
  if (opts.midLow != null) {
    bars.push(bar(bars.length, 102, 103, opts.midLow, 102));
  }
  if (opts.dipLow != null) {
    const i = bars.length;
    bars.push(bar(i, 103, 103.5, opts.dipLow, 102));
  }
  return bars;
}

// ===========================================================================
console.log("\n[1] FIRES on the ARMED state — run-up banked, pullback still ahead");
// ===========================================================================
{
  const bars = scenario({ runupHigh: 108, filler: 2 });
  const r = evalSecondChance(setup, bars);
  check("eligible", r.eligible, r.reason);
  check("  reason is 'eligible'", r.reason === "eligible", r.reason);
  check("  armed flag is set", r.armed === true);
  check("  entry is the NEXT OPEN after the confirming close (101)", near(r.entry, ENTRY), String(r.entry));
  check("  stop + t05 carried through", near(r.stop, STOP) && near(r.t05, T05));
  check("  fire date is the confirming-close bar", r.fireDate === dateAt(1), String(r.fireDate));
  check("  entry date is the bar after it", r.entryDate === dateAt(2), String(r.entryDate));
  check("  today is the last bar supplied", r.todayDate === bars[bars.length - 1].date);

  // The point of the whole change: no bar after entry has traded back to it yet.
  const postEntryLows = bars.slice((r.entryIndex as number) + 1).map((b) => b.low);
  check("  every POST-entry low is still above entry (pullback ahead)",
    postEntryLows.every((l) => l > ENTRY), JSON.stringify(postEntryLows));
  check("  …while the ENTRY bar's own low is below it, and does not disqualify",
    bars[r.entryIndex as number].low < ENTRY);
}

// ===========================================================================
console.log("\n[2] Does NOT fire — each disqualifier, with its own reason code");
// ===========================================================================
{
  // Target tagged: a high >= t05 anywhere since entry. Nothing left to recover.
  const r = evalSecondChance(setup, scenario({ runupHigh: 116, filler: 1 }));
  check("hit target → not eligible", !r.eligible);
  check("  reason 'hit_target'", r.reason === "hit_target", r.reason);
}
{
  // Stopped: a low <= stop anywhere since entry. Checked BEFORE the retest gate, so a
  // bar that blows through entry and the stop reads 'stopped', not 'already_retested'.
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, midLow: 94 }));
  check("stopped out → not eligible", !r.eligible);
  check("  reason 'stopped'", r.reason === "stopped", r.reason);
}
{
  // Never armed: max high stays under 104.50, so nothing has decayed yet.
  const r = evalSecondChance(setup, scenario({ runupHigh: 103.5, filler: 1 }));
  check("run-up below the threshold → not eligible", !r.eligible);
  check("  reason 'not_armed'", r.reason === "not_armed", r.reason);
  check("  armed flag is false", r.armed === false);
  check("  (it is a setup sitting near entry, not a recovery)", (r.runupPct ?? 99) < RUNUP_FRAC * 100);
}
{
  // Armed, but the pullback ALREADY came — a resting limit placed tonight would be
  // chasing an event that is already in the past. This is the case the old
  // retest-day trigger used to fire on, one day too late.
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 1, dipLow: 100.5 }));
  check("pullback already happened → not eligible", !r.eligible);
  check("  reason 'already_retested'", r.reason === "already_retested", r.reason);
  check("  it WAS armed — it just armed too long ago to act on", r.armed === true);
}
{
  // Boundary: a post-entry low EXACTLY at entry counts as retested (<=, not <), because
  // a resting limit at entry would have filled there.
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 1, dipLow: ENTRY }));
  check("post-entry low exactly == entry counts as retested", r.reason === "already_retested", r.reason);

  // …and a hair above it does not.
  const above = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 1, dipLow: ENTRY + 0.01 }));
  check("  a low one cent above entry still fires", above.eligible, above.reason);
}
{
  // Freshness. With the run-up bar at index 3, barsSinceEntry = filler + 1.
  const stale = evalSecondChance(setup, scenario({ runupHigh: 108, filler: RETEST_WINDOW_BARS }));
  check(`armed ${RETEST_WINDOW_BARS + 1} bars after entry → not eligible`, !stale.eligible);
  check("  reason 'stale'", stale.reason === "stale", stale.reason);
  check("  barsSinceEntry is exactly one past the window",
    stale.barsSinceEntry === RETEST_WINDOW_BARS + 1, String(stale.barsSinceEntry));

  const edge = evalSecondChance(setup, scenario({ runupHigh: 108, filler: RETEST_WINDOW_BARS - 1 }));
  check(`armed at exactly ${RETEST_WINDOW_BARS} bars → still fires`, edge.eligible, `${edge.reason} @ ${edge.barsSinceEntry}`);
  check("  barsSinceEntry == the window", edge.barsSinceEntry === RETEST_WINDOW_BARS, String(edge.barsSinceEntry));
}
{
  // Never fired: no close above the rim inside the confirm window.
  const bars = [bar(0, 98, 99, 97, 98), drift(1, 99), drift(2, 99), drift(3, 99)];
  const r = evalSecondChance(setup, bars);
  check("never fired → not eligible", !r.eligible);
  check("  reason 'not_fired'", r.reason === "not_fired", r.reason);
}
{
  const r = evalSecondChance({ ...setup, stop: null }, scenario({ runupHigh: 108 }));
  check("missing geometry → not eligible", !r.eligible && r.reason === "missing_geometry", r.reason);
}

// ===========================================================================
console.log("\n[3] Tradeable + owned gates (applied by the caller, asserted here)");
// ===========================================================================
{
  // The SKIP gate is the frozen SIZE_MAP — the recovery pass must never say "place a
  // limit" on a Q1/Q2 setup, exactly as the entry alert must not.
  check("Q1 SKIP is not tradeable", !isTradeableSetup({ tier: "Q1", sizeBucket: "skip" }));
  check("Q2 (no bucket) is not tradeable", !isTradeableSetup({ tier: "Q2", sizeBucket: null }));
  check("Q5 full IS tradeable", isTradeableSetup({ tier: "Q5", sizeBucket: "full" }));

  // Owned = TRADED with no recorded exit. An owned setup is a position to manage, not a
  // missed entry to recover — the whole premise is that it was NEVER taken.
  const owned = { userAction: "TRADED", userExitPrice: null };
  const notOwned = { userAction: "TRADED", userExitPrice: 130 };
  const isOwned = (d: { userAction?: string | null; userExitPrice?: number | null }) =>
    d.userAction === "TRADED" && d.userExitPrice == null;
  check("an owned setup is excluded from the candidate pool", isOwned(owned));
  check("a traded-then-EXITED setup is NOT owned (recoverable again)", !isOwned(notOwned));
}

// ===========================================================================
console.log("\n[4] Numbers — R:R, run-up %, bars-since, arming threshold");
// ===========================================================================
{
  const bars = scenario({ runupHigh: 108, filler: 2 });
  const r = evalSecondChance(setup, bars);
  // R:R = (115 - 101) / (101 - 95) = 14 / 6 = 2.333…
  check("R:R reproduces (t05 − entry)/(entry − stop)", near(r.rr, (T05 - ENTRY) / (ENTRY - STOP)), String(r.rr));
  check("  which is 2.33", near(r.rr, 2.33), String(r.rr));
  // run-up = (108 - 101) / 14 = 50%
  check("run-up % is measured toward t05", near(r.runupPct, ((108 - ENTRY) / (T05 - ENTRY)) * 100, 0.05), String(r.runupPct));
  check("  which is 50%", near(r.runupPct, 50, 0.05), String(r.runupPct));
  // entry bar index 2; bars: 0,1,2,3(runup),4,5(filler) → 3 bars since entry
  check("barsSinceEntry counts bars from the entry bar to today", r.barsSinceEntry === 3, String(r.barsSinceEntry));
  check("  and equals bars.length - 1 - entryIndex", r.barsSinceEntry === bars.length - 1 - (r.entryIndex as number));

  // Arming is >=, not >. Exactly at the line arms.
  const atEdge = evalSecondChance(setup, scenario({ runupHigh: ARM_AT, filler: 1 }));
  check(`run-up exactly ${RUNUP_FRAC * 100}% toward t05 ARMS`, atEdge.eligible, `${atEdge.reason} @ ${atEdge.runupPct}%`);
  check(`  run-up % sits exactly on ${RUNUP_FRAC * 100}`, near(atEdge.runupPct, RUNUP_FRAC * 100, 0.05), String(atEdge.runupPct));

  const underEdge = evalSecondChance(setup, scenario({ runupHigh: ARM_AT - 0.01, filler: 1 }));
  check("  one cent under the line does NOT arm", underEdge.reason === "not_armed", underEdge.reason);
}

// ===========================================================================
console.log("\n[5] Cancel-by date, message + dedup key");
// ===========================================================================
{
  // The resting limit must die when the backtested window closes — TRADING days, not
  // calendar days, or a GTC order outlives the edge by a weekend every time.
  const weekdaysOnly = (iso: string): boolean => {
    const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
    return d !== 0 && d !== 6;
  };
  check("addTradingDaysISO skips weekends", addTradingDaysISO("2026-03-04", 10, weekdaysOnly) === "2026-03-18",
    addTradingDaysISO("2026-03-04", 10, weekdaysOnly));
  check("  which is NOT +10 calendar days", addTradingDaysISO("2026-03-04", 10, weekdaysOnly) !== "2026-03-14");
  check("  the real NYSE calendar agrees for this stretch (no holidays)",
    addTradingDaysISO("2026-03-04", 10) === "2026-03-18", addTradingDaysISO("2026-03-04", 10));
  check("  n=0 is a no-op", addTradingDaysISO("2026-03-04", 0, weekdaysOnly) === "2026-03-04");
}
{
  const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler: 2 }));
  const cancelBy = addTradingDaysISO(r.entryDate as string, RETEST_WINDOW_BARS);
  const a = evalSecondChanceAlert({
    ticker: "tst", tier: "Q5", pRank: 3,
    entry: r.entry as number, stop: r.stop as number, t05: r.t05 as number,
    rr: r.rr, runupPct: r.runupPct, cancelBy,
  });
  check("alert type is 'second_chance'", a.type === "second_chance");
  check("  SYSTEM tier, not a heads-up", a.kind === "system");
  check("  never carries the heads-up disclaimer", !a.text.includes("not a system signal"));
  check("  header says ARMED, ticker uppercased", a.text.includes("ARMED — TST"));
  check("  no longer claims a pullback already happened", !a.text.includes("pulled back to entry"));
  check("  carries P-rank and tier", a.text.includes("P3") && a.text.includes("Q5"));
  check("  states the run-up is banked and the setup is still live + un-traded",
    a.text.includes("toward t05 since firing, still live + un-traded"), a.text);
  check("  quotes the actual run-up", a.text.includes("Ran up 50%"));
  check("  INSTRUCTS a resting BUY limit (the whole point of firing early)",
    a.text.includes("Place a resting BUY limit"), a.text);
  check("  quotes entry, stop and target(t05)",
    a.text.includes("entry 101.00") && a.text.includes("stop 95.00") && a.text.includes("target(t05) 115.00"), a.text);
  check("  quotes R:R", a.text.includes("R:R 2.33"));
  check("  tells the operator when to cancel", a.text.includes(`Cancel if unfilled by ${cancelBy}`), a.text);
  check("  …which is 10 trading days past the entry date", cancelBy === "2026-03-18", cancelBy);
  check("  RECOVERY caveat present verbatim",
    a.text.includes("restores original R:R, doesn't improve it") && a.text.includes("+0.33R / PF 1.93"),
    a.text);

  const noCancel = evalSecondChanceAlert({
    ticker: "TST", tier: null, pRank: null, entry: ENTRY, stop: STOP, t05: T05,
    rr: r.rr, runupPct: null, cancelBy: null,
  });
  check("  a missing cancel-by omits the line rather than printing null",
    !noCancel.text.includes("Cancel if unfilled") && !noCancel.text.includes("null"), noCancel.text);
  check("  and an unknown run-up falls back to the threshold",
    noCancel.text.includes(`>=${RUNUP_FRAC * 100}%`), noCancel.text);

  const k = secondChanceMarkerKey("tst", HLD);
  check("dedup key is setup identity", k === `jack:alert:second_chance:TST:${HLD}`, k);
  check("  carries NO et-date (once per SETUP, not per day)", !/2026-08/.test(k));
  check("  normalizes ticker case + whitespace", secondChanceMarkerKey("  tst  ", HLD) === k);
  check("  distinct setups get distinct keys", secondChanceMarkerKey("TST", "2026-04-01") !== k);
}
{
  // Dedup: a setup ARMS once (max-high only crosses the threshold once and stays
  // crossed), so the marker naturally yields one ping per setup for its lifetime.
  const sent = new Set<string>();
  const key = secondChanceMarkerKey("TST", HLD);
  const trySend = (filler: number): boolean => {
    if (sent.has(key)) return false;
    const r = evalSecondChance(setup, scenario({ runupHigh: 108, filler }));
    if (!r.eligible) return false;
    sent.add(key); // marker set ONLY on a successful send
    return true;
  };
  check("first armed evaluation sends", trySend(2));
  check("  the next evening — still armed — does NOT re-fire", !trySend(3));
  check("  the marker persists (no TTL semantics here)", sent.has(key));
}

// ===========================================================================
console.log("\n[6] PARITY ANCHOR — the trade economics did not move, only the alert");
// ===========================================================================
{
  // The armed alert instructs a limit at `entry`. Continue the fixture through the
  // pullback it is anticipating and on to t05: the fill price, the exit and the R must
  // all be what the alert advertised, computed by the SHARED exit engine the paper
  // replay uses. If they ever disagree, the alert is quoting a trade the book won't score.
  const bars = scenario({ runupHigh: 108, filler: 1 });
  const r = evalSecondChance(setup, bars);
  check("precondition: armed + eligible", r.eligible, r.reason);

  const pullbackIdx = bars.length;
  const continued = [
    ...bars,
    bar(pullbackIdx, 103, 103.5, 100.5, 102), // the pullback the resting limit catches
    bar(pullbackIdx + 1, 102, 110, 101.5, 109),
    bar(pullbackIdx + 2, 110, T05 + 1, 109, T05), // tags t05
  ];
  check("the anticipated pullback trades through the resting limit",
    continued[pullbackIdx].low <= (r.entry as number),
    `${continued[pullbackIdx].low} vs ${r.entry}`);

  const exit = findTouchExit(continued, pullbackIdx, STOP, T05);
  check("findTouchExit from the fill bar reaches TARGET", exit?.kind === "target", JSON.stringify(exit));
  check("  exiting at t05", near(exit?.price, T05));

  const reentryR = ((exit?.price as number) - (r.entry as number)) / ((r.entry as number) - STOP);
  check("re-entry R equals the advertised R:R", near(reentryR, r.rr as number, 0.01), `${reentryR} vs ${r.rr}`);
  check("  and equals (t05 − entry)/(entry − stop)", near(reentryR, (T05 - ENTRY) / (ENTRY - STOP)));

  // The same walk from the ORIGINAL entry bar resolves identically — the recovery
  // changes only the price you got in at, never the outcome.
  const fromEntry = findTouchExit(continued, r.entryIndex as number, STOP, T05);
  check("the trade resolves identically from the original entry", fromEntry?.kind === "target");
  check("  at the same exit price", near(fromEntry?.price, exit?.price as number));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
