/*
 * JACK outcome-replay self-test — BACKTEST PARITY.
 *
 * Locks replaySetup to the frozen backtest (cup_handle_15yr_history_1.ipynb) that
 * produced the raw-R reference in lib/jack/backtest-reference.ts:
 *
 *   Cell 3 (entry):  for j in range(h_idx+1, min(h_idx+1+15, n)):
 *                        if C[j] > breakout: confirm = j; break
 *                    e_idx = confirm + 1;  e_px = O[e_idx]
 *   Cell 1 (exit):   TIME_STOP_DAYS = 120
 *   _sim_trade:      if low <= stop -> stop @ stop, R = -1
 *                    if high >= target -> target @ target
 *                    else at end -> mark to last close
 *
 * The two bugs this guards against (both inflated the fire count with trades the
 * 2.90 reference never contained):
 *   · firing on an intraday HIGH poke instead of a confirming CLOSE
 *   · searching 130 bars for the confirmation instead of 15
 *
 * Pure — synthetic bars, no network, no DB.
 *
 * Run:  npx tsx scripts/jack-outcome-replay-selftest.ts
 */
import {
  replaySetup,
  CONFIRM_WINDOW_BARS,
  TIME_STOP_BARS,
  ASSUMPTION_LABELS,
} from "../lib/jack/outcome-tracker";
import type { SetupNeedingOutcome } from "../lib/db/read";

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
const near = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

const HLD = "2026-01-05";
const RIM = 100;
const STOP = 95;
const TARGET = 115;

const setup = (p: Partial<SetupNeedingOutcome> = {}): SetupNeedingOutcome => ({
  id: 1,
  ticker: "TST",
  handleLowDate: HLD,
  entry: 101, // deliberately present — the replay must NOT use it
  stop: STOP,
  target: TARGET,
  breakoutLevel: RIM,
  ...p,
});

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

/** Sequential trading-day-ish dates from the handle low (calendar days are fine here). */
function dateAt(i: number): string {
  const d = new Date(`${HLD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
/** bar(0) is the handle-low bar itself; bar(1) is the first bar eligible to confirm. */
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  date: dateAt(i), open: o, high: h, low: l, close: c, volume: 1_000_000,
});
/** A quiet bar that neither confirms nor exits. */
const flat = (i: number, px = 98): Bar => bar(i, px, px + 0.5, px - 0.5, px);
/** N quiet bars starting at index `from`. */
const flats = (from: number, count: number, px = 98): Bar[] =>
  Array.from({ length: count }, (_, k) => flat(from + k, px));

// ===========================================================================
console.log("\n[1] FIRE — confirming CLOSE, not an intraday poke");
// ===========================================================================
{
  // bar 1 pokes to 105 intraday but CLOSES at 99 (below the rim) → not a breakout.
  // bar 2 closes at 101 → confirms. Fill = bar 3's open.
  const bars = [
    flat(0),
    bar(1, 98, 105, 97, 99), // high > rim, close < rim → NOT a fire
    bar(2, 99, 102, 98, 101), // close > rim → FIRE
    bar(3, 103, 104, 102, 103), // fill @ open 103
    ...flats(4, TIME_STOP_BARS + 5, 104),
  ];
  const r = replaySetup(setup(), bars);
  check("written", r.kind === "written", r.kind);
  if (r.kind === "written") {
    check("fired", r.outcome.fired === true);
    check("fire date = the CONFIRMING CLOSE bar, not the poke bar", r.outcome.fireDate === dateAt(2), r.outcome.fireDate);
    check("fill = NEXT bar's open (103)", near(r.outcome.entryPriceActual, 103), String(r.outcome.entryPriceActual));
    check("fill is NOT the rim (100)", !near(r.outcome.entryPriceActual, RIM));
    check("fill is NOT the scanner entry (101)", !near(r.outcome.entryPriceActual, 101));
    check("entry date = fill bar", r.outcome.entryDateActual === dateAt(3), r.outcome.entryDateActual);
  }
}
{
  // ONLY an intraday poke, never a confirming close, for the whole window → no trade.
  const bars = [
    flat(0),
    ...Array.from({ length: CONFIRM_WINDOW_BARS }, (_, k) => bar(1 + k, 98, 106, 97, 99)),
    ...flats(1 + CONFIRM_WINDOW_BARS, 5),
  ];
  const r = replaySetup(setup(), bars);
  check("high-only pokes for the whole window → never_fired", r.kind === "written" && r.outcome.exitReason === "never_fired");
  check("never_fired carries fired=false and no R", r.kind === "written" && r.outcome.fired === false && r.outcome.rRealized == null);
}
{
  // close EXACTLY at the rim is not > rim (strict comparison, matching C[j] > breakout)
  const bars = [
    flat(0),
    ...Array.from({ length: CONFIRM_WINDOW_BARS }, (_, k) => bar(1 + k, 99, 101, 98, RIM)),
    ...flats(1 + CONFIRM_WINDOW_BARS, 5),
  ];
  const r = replaySetup(setup(), bars);
  check("close == rim does NOT confirm (strict >)", r.kind === "written" && r.outcome.exitReason === "never_fired");
}

// ===========================================================================
console.log(`\n[2] CONFIRM WINDOW — ${CONFIRM_WINDOW_BARS} bars after the handle low`);
// ===========================================================================
{
  // Confirming close on the LAST bar of the window (bar 15) → fires.
  const bars = [
    flat(0),
    ...flats(1, CONFIRM_WINDOW_BARS - 1),
    bar(CONFIRM_WINDOW_BARS, 99, 102, 98, 101), // bar 15 = last eligible
    bar(CONFIRM_WINDOW_BARS + 1, 103, 104, 102, 103),
    ...flats(CONFIRM_WINDOW_BARS + 2, TIME_STOP_BARS + 5, 104),
  ];
  const r = replaySetup(setup(), bars);
  check(`close above rim on bar ${CONFIRM_WINDOW_BARS} → FIRES`, r.kind === "written" && r.outcome.fired === true);
  if (r.kind === "written") {
    check("fire date is that last-eligible bar", r.outcome.fireDate === dateAt(CONFIRM_WINDOW_BARS));
  }
}
{
  // Confirming close one bar LATE (bar 16) → the backtest discarded it; so do we.
  const bars = [
    flat(0),
    ...flats(1, CONFIRM_WINDOW_BARS),
    bar(CONFIRM_WINDOW_BARS + 1, 99, 102, 98, 101), // bar 16 — too late
    bar(CONFIRM_WINDOW_BARS + 2, 103, 104, 102, 103),
    ...flats(CONFIRM_WINDOW_BARS + 3, 10, 104),
  ];
  const r = replaySetup(setup(), bars);
  check(`close above rim on bar ${CONFIRM_WINDOW_BARS + 1} → never_fired (window closed)`, r.kind === "written" && r.outcome.exitReason === "never_fired");
}
{
  // REGRESSION: the old code searched resolutionDays (130) bars wide. A confirm at
  // bar 60 must NOT fire.
  const bars = [flat(0), ...flats(1, 59), bar(60, 99, 102, 98, 101), ...flats(61, 10, 103)];
  const r = replaySetup(setup(), bars);
  check("confirm at bar 60 → never_fired (no 130-bar fire search)", r.kind === "written" && r.outcome.exitReason === "never_fired");
}
{
  // A handle low on a non-trading day: bars[0] is ALREADY the first bar after it.
  // Anchoring on the date (not index 0) must still allow a bar-1 confirmation.
  const bars = [
    bar(1, 99, 102, 98, 101), // first bar in the series, dated AFTER the handle low
    bar(2, 103, 104, 102, 103),
    ...flats(3, TIME_STOP_BARS + 5, 104),
  ];
  const r = replaySetup(setup(), bars);
  check("weekend/holiday handle low (bars start after it) still fires", r.kind === "written" && r.outcome.fired === true);
  if (r.kind === "written") check("  fill = 103", near(r.outcome.entryPriceActual, 103));
}

// ===========================================================================
console.log("\n[3] DEFERRED — never lock in a premature verdict");
// ===========================================================================
{
  // Only 5 bars of the 15-bar window exist → deferred, NOT never_fired.
  const bars = [flat(0), ...flats(1, 5)];
  const r = replaySetup(setup(), bars);
  check("short series inside the confirm window → deferred", r.kind === "deferred", r.kind);
  if (r.kind === "deferred") check("  reason names the window", r.reason.includes("confirm window"), r.reason);
}
{
  // Confirms on the very last bar → no next-day open yet → deferred.
  const bars = [flat(0), flat(1), bar(2, 99, 102, 98, 101)];
  const r = replaySetup(setup(), bars);
  check("confirm on the last available bar → deferred (awaiting the open)", r.kind === "deferred", r.kind);
}
{
  // Fires, but fewer than TIME_STOP_BARS forward bars → deferred, not a fake timeout.
  const bars = [flat(0), bar(1, 99, 102, 98, 101), bar(2, 103, 104, 102, 103), ...flats(3, 10, 104)];
  const r = replaySetup(setup(), bars);
  check("fired but window not elapsed → deferred, not a premature timeout", r.kind === "deferred", r.kind);
  if (r.kind === "deferred") check(`  reason names the ${TIME_STOP_BARS}-bar window`, r.reason.includes(String(TIME_STOP_BARS)), r.reason);
}
{
  // No bars after the handle low at all.
  const r = replaySetup(setup(), [flat(0)]);
  check("no bars after the handle low → deferred", r.kind === "deferred");
}

// ===========================================================================
console.log("\n[4] EXIT — intraday touch, stop first, exact -1R");
// ===========================================================================
{
  // Fill 103; target 115 touched intraday on bar 5 (high 116, close below it).
  const bars = [
    flat(0),
    bar(1, 99, 102, 98, 101),
    bar(2, 103, 104, 102, 103), // fill @ 103
    flat(3, 105), flat(4, 108),
    bar(5, 110, 116, 109, 112), // HIGH >= target → exit @ target, even though close < target
    ...flats(6, TIME_STOP_BARS + 5, 112),
  ];
  const r = replaySetup(setup(), bars);
  check("target exits on the bar HIGH (intraday touch, not the close)", r.kind === "written" && r.outcome.exitReason === "target");
  if (r.kind === "written") {
    check("  exit price = target", near(r.outcome.exitPrice, TARGET));
    // R == (target - next_open) / (next_open - stop) == (115-103)/(103-95) == 1.5
    check("  R = (target - next_open)/(next_open - stop) = 1.50", near(r.outcome.rRealized, (TARGET - 103) / (103 - STOP)));
  }
}
{
  // Stop touched on the bar LOW → exactly -1R, exit AT the stop price.
  const bars = [
    flat(0),
    bar(1, 99, 102, 98, 101),
    bar(2, 103, 104, 102, 103),
    bar(3, 102, 103, 94, 97), // LOW <= stop
    ...flats(4, TIME_STOP_BARS + 5, 97),
  ];
  const r = replaySetup(setup(), bars);
  check("stop exits on the bar LOW", r.kind === "written" && r.outcome.exitReason === "stop");
  if (r.kind === "written") {
    check("  exit price = stop", near(r.outcome.exitPrice, STOP));
    check("  R is exactly -1", near(r.outcome.rRealized, -1));
  }
}
{
  // Same bar touches BOTH → stop wins (conservative tie rule).
  const bars = [
    flat(0),
    bar(1, 99, 102, 98, 101),
    bar(2, 103, 104, 102, 103),
    bar(3, 103, 120, 94, 110), // high >= target AND low <= stop
    ...flats(4, TIME_STOP_BARS + 5, 110),
  ];
  const r = replaySetup(setup(), bars);
  check("same-bar stop+target → STOP first (tie rule)", r.kind === "written" && r.outcome.exitReason === "stop");
  if (r.kind === "written") check("  tie still yields exactly -1R", near(r.outcome.rRealized, -1));
}

// ===========================================================================
console.log(`\n[5] TIME STOP — ${TIME_STOP_BARS} bars, mark-to-market`);
// ===========================================================================
{
  // Fill @ 103, then TIME_STOP_BARS quiet bars that never touch stop or target.
  const bars = [
    flat(0),
    bar(1, 99, 102, 98, 101),
    bar(2, 103, 104, 102, 103), // fill @ 103, index 2 = entryIdx
    ...Array.from({ length: TIME_STOP_BARS + 3 }, (_, k) => flat(3 + k, 107)),
  ];
  const r = replaySetup(setup(), bars);
  check("neither hit within the window → timeout", r.kind === "written" && r.outcome.exitReason === "timeout");
  if (r.kind === "written") {
    // The window is [entryIdx, entryIdx + TIME_STOP_BARS); its last bar is index 121.
    check("  marks to the last close IN the window", near(r.outcome.exitPrice, 107));
    check("  exit date = the window's last bar", r.outcome.exitDate === dateAt(2 + TIME_STOP_BARS - 1), r.outcome.exitDate);
    check("  R = (close - fill)/(fill - stop)", near(r.outcome.rRealized, (107 - 103) / (103 - STOP)));
  }
}
{
  // A target touched one bar PAST the window must not count.
  const bars = [
    flat(0),
    bar(1, 99, 102, 98, 101),
    bar(2, 103, 104, 102, 103),
    ...Array.from({ length: TIME_STOP_BARS - 1 }, (_, k) => flat(3 + k, 107)),
    bar(2 + TIME_STOP_BARS, 107, 130, 106, 129), // first bar OUTSIDE the window
    ...flats(3 + TIME_STOP_BARS, 5, 129),
  ];
  const r = replaySetup(setup(), bars);
  check(`target touched at bar ${TIME_STOP_BARS} after entry → still a timeout`, r.kind === "written" && r.outcome.exitReason === "timeout");
}

// ===========================================================================
console.log("\n[6] GEOMETRY BAILS");
// ===========================================================================
{
  const bars = [flat(0), bar(1, 99, 102, 98, 101), bar(2, 103, 104, 102, 103), ...flats(3, TIME_STOP_BARS + 5, 104)];
  const noStop = replaySetup(setup({ stop: null }), bars);
  check("null stop → skipped", noStop.kind === "skipped", noStop.kind);
  const noTarget = replaySetup(setup({ target: null }), bars);
  check("null target → skipped", noTarget.kind === "skipped", noTarget.kind);
  const noRim = replaySetup(setup({ breakoutLevel: null }), bars);
  check("null breakout_level → skipped (the rim IS required)", noRim.kind === "skipped", noRim.kind);
  const noBars = replaySetup(setup(), []);
  check("no bars → skipped", noBars.kind === "skipped");
}
{
  // Fill opens below the stop → degenerate, refuse rather than fabricate an R.
  const bars = [flat(0), bar(1, 99, 102, 98, 101), bar(2, 90, 91, 89, 90), ...flats(3, TIME_STOP_BARS + 5, 90)];
  const r = replaySetup(setup(), bars);
  check("fill gapped below the stop → skipped (degenerate)", r.kind === "skipped", r.kind);
}
{
  // A gap-up fill is honored as-is (the backtest ate the gap too).
  const bars = [
    flat(0),
    bar(1, 99, 102, 98, 101),
    bar(2, 112, 113, 111, 112), // opens far above the rim
    ...flats(3, TIME_STOP_BARS + 5, 113),
  ];
  const r = replaySetup(setup(), bars);
  check("gap-up open is the fill (slippage kept, not clamped to the rim)", r.kind === "written" && near(r.outcome.entryPriceActual, 112));
  if (r.kind === "written") {
    check("  R computed off the gapped fill", near(r.outcome.rRealized, (113 - 112) / (112 - STOP)));
  }
}

// ===========================================================================
console.log("\n[7] ASSUMPTION LABELS state the real model");
// ===========================================================================
check("labels mention the confirming CLOSE", ASSUMPTION_LABELS.some((l) => /confirmed CLOSE/i.test(l)));
check("labels mention the 15-bar window", ASSUMPTION_LABELS.some((l) => l.includes(String(CONFIRM_WINDOW_BARS))));
check("labels mention the next-day OPEN fill", ASSUMPTION_LABELS.some((l) => /next day's OPEN/i.test(l)));
check("labels mention intraday-touch, stop-first", ASSUMPTION_LABELS.some((l) => /intraday touch/i.test(l) && /stop-first/i.test(l)));
check(`labels mention the ${TIME_STOP_BARS}-bar time stop`, ASSUMPTION_LABELS.some((l) => l.includes(`${TIME_STOP_BARS}-bar`)));
check("labels disclose the scanner-stop known gap", ASSUMPTION_LABELS.some((l) => /known gap/i.test(l)));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
