/*
 * JACK EOD close-confirmed ENTRY ALERT self-test.
 *
 * Covers the 12 cases in jack-eod-entry-alert-spec.md. The fire decision is NOT
 * re-implemented here — every case drives the SHARED detectFire (lib/jack/outcome-
 * tracker.ts), the same function replaySetup uses. If the two ever diverge, this test
 * and the 48-check replay-parity test fail together, which is the point of the
 * extraction.
 *
 * Cases 8 + 9 (owned-excluded, not-in-current-board) are properties of the pending
 * ACCESSOR, so they run against a real throwaway SQLite DB rather than a mock.
 *
 * No network, no Redis, no Telegram.
 *
 * Run:  npx tsx scripts/jack-entry-alert-selftest.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFire, findTouchExit, CONFIRM_WINDOW_BARS, type Bar } from "../lib/jack/outcome-tracker";
import { evalEntryConfirmed, entryMarkerKey, alertMarkerKey } from "../lib/jack/alerts";
import { isTradeableSetup } from "../lib/jack/handle-score";

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

const HLD = "2026-03-02"; // a Monday
const RIM = 100;

/** Sequential calendar dates from the handle low (bar 0 == the handle-low bar). */
function dateAt(i: number): string {
  const d = new Date(`${HLD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  date: dateAt(i), open: o, high: h, low: l, close: c, volume: 1_000_000,
});
/** Quiet bar: nowhere near the rim. */
const flat = (i: number, px = 97): Bar => bar(i, px, px + 0.4, px - 0.4, px);
const flats = (from: number, count: number, px = 97): Bar[] =>
  Array.from({ length: count }, (_, k) => flat(from + k, px));

/**
 * The alert's eligibility decision, expressed exactly as the production loop does it:
 * rim guard → marker guard → detectFire. Returns what would happen.
 */
function wouldFire(args: {
  bars: Bar[];
  handleLowDate: string;
  rim: number | null;
  markerAlreadySet?: boolean;
  sizeBucket?: string | null;
  tier?: string | null;
}): { fired: boolean; reason: string; fireDate?: string | null; fireBarIndex?: number | null } {
  if (args.rim == null) return { fired: false, reason: "skipped: no rim" };
  // Mirrors the loop order in evaluateEntryConfirmations: rim -> tradeable -> marker.
  if (!isTradeableSetup({ sizeBucket: args.sizeBucket, tier: args.tier })) {
    return { fired: false, reason: "skipped: not tradeable (SKIP bucket / Q1-Q2)" };
  }
  if (args.markerAlreadySet) return { fired: false, reason: "skipped: already alerted once" };
  const f = detectFire(args.bars, args.handleLowDate, args.rim);
  if (f.status !== "fired") return { fired: false, reason: f.status };
  return { fired: true, reason: "fired", fireDate: f.fireDate, fireBarIndex: f.fireBarIndex };
}

const mkAlert = (
  fireDate: string,
  etDate: string,
  fireBarIndex = 3,
  sessionsAgo = 0,
  resolved: { kind: "stop" | "target"; date: string } | null = null
) =>
  evalEntryConfirmed({
    ticker: "tst", fireClose: 101, breakout: RIM, fireBarIndex, handleLowDate: HLD,
    fireDate, etDate, sessionsAgo, stop: 95, target: 115,
    tier: "Q5", pRank: 2, sizeBucket: "full", resolved,
  });

// ===========================================================================
console.log("\n[1] Close strictly above rim, in window, no marker → FIRES");
// ===========================================================================
{
  // bar 3 (1-based) closes 101 > rim 100
  const bars = [flat(0), flat(1), flat(2), bar(3, 99, 102, 98, 101), ...flats(4, 5)];
  const r = wouldFire({ bars, handleLowDate: HLD, rim: RIM });
  check("fires", r.fired, r.reason);
  check("fire bar index is 3/15 (1-based since handle low)", r.fireBarIndex === 3, String(r.fireBarIndex));
  check("fire date is the confirming bar", r.fireDate === dateAt(3), String(r.fireDate));
}

// ===========================================================================
console.log("\n[2] Close EQUAL to rim → no fire (strict >)");
// ===========================================================================
{
  const bars = [flat(0), ...Array.from({ length: CONFIRM_WINDOW_BARS }, (_, k) => bar(1 + k, 99, 101, 98, 100.0)), ...flats(16, 3)];
  const r = wouldFire({ bars, handleLowDate: HLD, rim: 100.0 });
  check("close 100.00 vs rim 100.00 does NOT fire", !r.fired, r.reason);
  check("resolves never_fired once the window elapses", r.reason === "never_fired", r.reason);
}

// ===========================================================================
console.log("\n[3] Close below rim within window → no fire");
// ===========================================================================
{
  const bars = [flat(0), flat(1, 99.5), flat(2, 99.9), flat(3, 98)];
  const r = wouldFire({ bars, handleLowDate: HLD, rim: RIM });
  check("no fire", !r.fired, r.reason);
  check("deferred while the window is still open", r.reason === "deferred", r.reason);
}

// ===========================================================================
console.log("\n[4] Intraday HIGH above rim but CLOSE below → no fire (the core point)");
// ===========================================================================
{
  // Every bar in the window spikes to 106 intraday and closes at 99.
  const bars = [flat(0), ...Array.from({ length: CONFIRM_WINDOW_BARS }, (_, k) => bar(1 + k, 98, 106, 97, 99)), ...flats(16, 3)];
  const r = wouldFire({ bars, handleLowDate: HLD, rim: RIM });
  check("intraday poke through the rim does NOT confirm", !r.fired, r.reason);
  check("this is the HEADS-UP behaviour the SYSTEM alert replaces", r.reason === "never_fired", r.reason);
}

// ===========================================================================
console.log("\n[5] Close above rim but window ELAPSED (bar 16+) → never_fired");
// ===========================================================================
{
  const bars = [
    flat(0),
    ...flats(1, CONFIRM_WINDOW_BARS),
    bar(CONFIRM_WINDOW_BARS + 1, 99, 103, 98, 101), // bar 16 — too late
    ...flats(CONFIRM_WINDOW_BARS + 2, 3),
  ];
  const r = wouldFire({ bars, handleLowDate: HLD, rim: RIM });
  check("late confirming close does not fire", !r.fired, r.reason);
  check("status is never_fired", r.reason === "never_fired", r.reason);
}

// ===========================================================================
console.log("\n[6] Marker already set → no fire (once per SETUP, not per day)");
// ===========================================================================
{
  const bars = [flat(0), flat(1), bar(2, 99, 102, 98, 101), ...flats(3, 5)];
  const fresh = wouldFire({ bars, handleLowDate: HLD, rim: RIM });
  const dup = wouldFire({ bars, handleLowDate: HLD, rim: RIM, markerAlreadySet: true });
  check("fires when unmarked", fresh.fired);
  check("suppressed when the marker exists", !dup.fired, dup.reason);
}
{
  // The marker must be keyed on setup identity — NOT the ET date, or it would re-fire
  // every day the setup stays above its rim.
  const k = entryMarkerKey("tst", HLD);
  check("marker key is ticker+handle_low_date", k === `jack:alert:entry_confirmed:TST:${HLD}`, k);
  check("marker key carries NO et-date", !/2026-08/.test(k) && k.split(":").length === 5, k);
  check("normalizes ticker case + whitespace", entryMarkerKey("  tst  ", HLD) === k);
  check(
    "differs from the per-day alertMarkerKey scheme",
    alertMarkerKey("entry_confirmed", "TST", "2026-08-07") !== k
  );
  check("distinct setups get distinct keys", entryMarkerKey("TST", "2026-04-01") !== k);
}

// ===========================================================================
console.log("\n[7] Rim NULL → skip, no fire, no throw");
// ===========================================================================
{
  const bars = [flat(0), bar(1, 99, 102, 98, 101), ...flats(2, 5)];
  let threw = false;
  let r: ReturnType<typeof wouldFire> | null = null;
  try {
    r = wouldFire({ bars, handleLowDate: HLD, rim: null });
  } catch {
    threw = true;
  }
  check("does not throw on a null rim", !threw);
  check("skips", r != null && !r.fired, r?.reason);
  check("reason names the missing rim", r?.reason === "skipped: no rim", r?.reason);
}

// ===========================================================================
console.log("\n[10] Anchoring: handle low on a Fri/weekend → first later bar is bar 1");
// ===========================================================================
{
  // Handle low is Friday 2026-03-06; the series starts Monday 2026-03-09. bars[0] is
  // ALREADY the first bar after the handle low, so index-0 anchoring would be wrong.
  const FRI = "2026-03-06";
  const bars: Bar[] = [
    { date: "2026-03-09", open: 99, high: 102, low: 98, close: 101, volume: 1e6 }, // bar 1
    { date: "2026-03-10", open: 101, high: 103, low: 100, close: 102, volume: 1e6 },
    ...flats(20, 5),
  ];
  const f = detectFire(bars, FRI, RIM);
  check("fires on the first bar dated after the handle low", f.status === "fired");
  check("that bar is bar 1/15, not bar 0", f.fireBarIndex === 1, String(f.fireBarIndex));
  check("fire date is the Monday", f.fireDate === "2026-03-09", String(f.fireDate));
}
{
  // Handle-low date itself present in the series must NOT be counted as bar 1.
  const bars = [bar(0, 99, 105, 98, 104), bar(1, 99, 102, 98, 101), ...flats(2, 5)];
  const f = detectFire(bars, HLD, RIM);
  check("the handle-low bar itself cannot confirm (search starts strictly after)", f.fireBarIndex === 1 && f.fireDate === dateAt(1), `${f.fireBarIndex} ${f.fireDate}`);
}
{
  const f = detectFire([flat(0)], HLD, RIM);
  check("no bars after the handle low → deferred, not never_fired", f.status === "deferred", f.status);
}

// ===========================================================================
console.log(`\n[11] Boundary: bar ${CONFIRM_WINDOW_BARS}/15 fires; bar ${CONFIRM_WINDOW_BARS + 1} does not`);
// ===========================================================================
{
  const onLast = [
    flat(0),
    ...flats(1, CONFIRM_WINDOW_BARS - 1),
    bar(CONFIRM_WINDOW_BARS, 99, 103, 98, 101), // bar 15 — last eligible
    ...flats(CONFIRM_WINDOW_BARS + 1, 3),
  ];
  const f1 = detectFire(onLast, HLD, RIM);
  check(`bar ${CONFIRM_WINDOW_BARS} confirms`, f1.status === "fired", f1.status);
  check(`  reported as bar ${CONFIRM_WINDOW_BARS}/${CONFIRM_WINDOW_BARS}`, f1.fireBarIndex === CONFIRM_WINDOW_BARS, String(f1.fireBarIndex));

  const oneLate = [
    flat(0),
    ...flats(1, CONFIRM_WINDOW_BARS),
    bar(CONFIRM_WINDOW_BARS + 1, 99, 103, 98, 101), // bar 16
    ...flats(CONFIRM_WINDOW_BARS + 2, 3),
  ];
  const f2 = detectFire(oneLate, HLD, RIM);
  check(`bar ${CONFIRM_WINDOW_BARS + 1} does NOT confirm`, f2.status === "never_fired", f2.status);
}

// ===========================================================================
console.log("\n[12] Wording: fireDate === today → CONFIRMED; earlier → LATE ENTRY");
// ===========================================================================
{
  const today = dateAt(3);
  const sameDay = mkAlert(today, today, 3, 0);
  check("today's fire → ENTRY CONFIRMED header", sameDay.text.includes("✅ ENTRY CONFIRMED"), sameDay.text.split("\n")[0]);
  check("  type is entry_confirmed", sameDay.type === "entry_confirmed");
  check("  action says buy the NEXT session's open", sameDay.text.includes("buy next session's OPEN"));
  check("  does NOT claim off-parity", !sameDay.text.includes("OFF-parity"));

  const late = mkAlert(dateAt(1), dateAt(3), 1, 2);
  check("earlier fire → LATE ENTRY header", late.text.includes("⚠️ LATE ENTRY"), late.text.split("\n")[0]);
  check("  type is late_entry", late.type === "late_entry");
  check("  names the fire date and session count", late.text.includes(dateAt(1)) && late.text.includes("2 sessions ago"));
  check("  labels it OFF-parity honestly", late.text.includes("OFF-parity"));

  // Shared message contract
  for (const [label, a] of [["confirmed", sameDay], ["late", late]] as const) {
    check(`  ${label}: SYSTEM tier`, a.kind === "system");
    check(`  ${label}: marked a system signal (opposite of the heads-up footer)`, a.text.includes("SYSTEM SIGNAL"));
    check(`  ${label}: never carries the heads-up disclaimer`, !a.text.includes("not a system signal"));
    check(`  ${label}: shows close vs rim`, a.text.includes("Close 101.00 > rim 100.00"));
    check(`  ${label}: shows the bar/window position`, a.text.includes(`/${CONFIRM_WINDOW_BARS} since handle low ${HLD}`));
    check(`  ${label}: carries tier/P-rank/stop/t05/size`, a.text.includes("Q5") && a.text.includes("P2") && a.text.includes("stop 95.00") && a.text.includes("t05 115.00") && a.text.includes("size FULL"));
    check(`  ${label}: uses the board's Pn convention, NOT the raw priority float`, !/prio\s|P7\.5|7\.5/.test(a.text), a.text);
    check(`  ${label}: ticker uppercased`, a.ticker === "TST");
  }
}
{
  // Missing optional fields must not produce "null" in the text.
  const bare = evalEntryConfirmed({
    ticker: "abc", fireClose: 101, breakout: RIM, fireBarIndex: 2, handleLowDate: HLD,
    fireDate: dateAt(2), etDate: dateAt(2), sessionsAgo: 0,
    stop: null, target: null, tier: null, pRank: null, sizeBucket: null,
  });
  check("omits absent metadata rather than printing null", !/null|undefined|NaN/.test(bare.text), bare.text);
  check("still renders the headline", bare.text.includes("✅ ENTRY CONFIRMED — ABC"));
}

// ===========================================================================
console.log("\n[13] LATE ENTRY that already played out → ALREADY RESOLVED, never 'buy'");
// ===========================================================================
{
  const STOP = 95;
  const TARGET = 115;
  // Fire on bar 1 (close 101 > rim 100); the FILL is bar 2's open. Resolution is
  // scanned from the fill bar with the SHARED intraday-touch rule (stop-first).
  const fireThen = (rest: Bar[]) => [flat(0), bar(1, 99, 102, 98, 101), ...rest];
  const scanFrom = 2; // fill bar index = fireIndex + 1

  // --- fired, then STOPPED ---
  {
    const bars = fireThen([
      bar(2, 101, 103, 99, 100), // fill bar, no touch
      bar(3, 100, 101, 94, 96), // low 94 <= stop 95 → STOP
      ...flats(4, 4, 96),
    ]);
    const exit = findTouchExit(bars, scanFrom, STOP, TARGET);
    check("fired-then-stopped is detected", exit?.kind === "stop", JSON.stringify(exit));
    check("  stop date is the touching bar", exit?.date === dateAt(3), String(exit?.date));
    const a = mkAlert(dateAt(1), dateAt(7), 1, 6, exit ? { kind: exit.kind, date: exit.date } : null);
    check("  alert type is entry_resolved", a.type === "entry_resolved", a.type);
    check("  header says ALREADY RESOLVED with the stop date", a.text.includes(`🚫 ALREADY RESOLVED — TST  (stop hit ${dateAt(3)})`), a.text.split("\n")[0]);
    check("  says NO ACTION / do NOT enter", a.text.includes("NO ACTION") && a.text.includes("do NOT enter"));
    check("  NEVER tells the operator to buy", !a.text.includes("buy next session's OPEN") && !/ACTION: buy/.test(a.text), a.text);
    check("  still a visible SYSTEM alert (relabelled, not suppressed)", a.kind === "system" && a.text.includes("SYSTEM SIGNAL"));
    check("  still shows the fire context", a.text.includes(`bar 1/${CONFIRM_WINDOW_BARS} since handle low ${HLD}`));
  }

  // --- fired, then TARGET ---
  {
    const bars = fireThen([
      bar(2, 101, 103, 99, 102),
      bar(3, 103, 116, 102, 114), // high 116 >= target 115 → TARGET
      ...flats(4, 4, 114),
    ]);
    const exit = findTouchExit(bars, scanFrom, STOP, TARGET);
    check("fired-then-target is detected", exit?.kind === "target", JSON.stringify(exit));
    const a = mkAlert(dateAt(1), dateAt(7), 1, 6, exit ? { kind: exit.kind, date: exit.date } : null);
    check("  alert type is entry_resolved", a.type === "entry_resolved");
    check("  header names the target hit", a.text.includes(`🚫 ALREADY RESOLVED — TST  (target hit ${dateAt(3)})`), a.text.split("\n")[0]);
    check("  action says reached target, do NOT enter", a.text.includes("reached target") && a.text.includes("do NOT enter"));
    check("  NEVER tells the operator to buy", !a.text.includes("buy next session's OPEN"));
  }

  // --- fired, STILL OPEN → must remain a normal LATE ENTRY ---
  {
    const bars = fireThen([
      bar(2, 101, 103, 99, 102),
      ...flats(3, 5, 102), // drifts, never touches 95 or 115
    ]);
    const exit = findTouchExit(bars, scanFrom, STOP, TARGET);
    check("fired-still-open has no touch exit", exit === null, JSON.stringify(exit));
    const a = mkAlert(dateAt(1), dateAt(7), 1, 6, exit ? { kind: exit.kind, date: exit.date } : null);
    check("  alert type is late_entry", a.type === "late_entry", a.type);
    check("  header is LATE ENTRY", a.text.includes("⚠️ LATE ENTRY"), a.text.split("\n")[0]);
    check("  still labelled OFF-parity", a.text.includes("OFF-parity"));
    check("  not relabelled as resolved", !a.text.includes("ALREADY RESOLVED"));
  }

  // --- tie on one bar → stop-first, matching the backtest/replay ---
  {
    const bars = fireThen([
      bar(2, 101, 103, 99, 102),
      bar(3, 102, 120, 94, 110), // touches BOTH target and stop
      ...flats(4, 4, 110),
    ]);
    const exit = findTouchExit(bars, scanFrom, STOP, TARGET);
    check("same-bar stop+target resolves to STOP (tie rule preserved)", exit?.kind === "stop", JSON.stringify(exit));
  }

  // --- a touch BEFORE the fill bar must not count ---
  {
    // bar 1 both confirms (close 101) and dips to 94 intraday. The fill is bar 2's
    // open, so that dip predates the position and must be ignored.
    const bars = [flat(0), bar(1, 99, 102, 94, 101), bar(2, 101, 103, 99, 102), ...flats(3, 4, 102)];
    const exit = findTouchExit(bars, scanFrom, STOP, TARGET);
    check("a stop touch on the FIRE bar (pre-fill) is not a resolution", exit === null, JSON.stringify(exit));
  }

  // --- same-day fire can never be resolved, even if a caller passes one ---
  {
    const today = dateAt(3);
    const a = mkAlert(today, today, 3, 0, { kind: "stop", date: today });
    check("same-day fire ignores a resolved payload (fill hasn't happened yet)", a.type === "entry_confirmed", a.type);
    check("  still says buy next session's open", a.text.includes("buy next session's OPEN"));
  }
}

// ===========================================================================
console.log("\n[14] Board FIRED flag mirrors the alert classification exactly");
// ===========================================================================
{
  // The EOD pass derives firedStatus from the SAME `resolved`/`late` branch that
  // picks the alert wording, so the badge and the Telegram text can never disagree.
  // This mirrors that derivation and asserts it against the alert type.
  const firedStatusFor = (
    fireDate: string,
    etDate: string,
    resolved: { kind: "stop" | "target"; date: string } | null
  ): "confirmed" | "late" | "resolved" => {
    const late = fireDate < etDate;
    return late && resolved ? "resolved" : late ? "late" : "confirmed";
  };

  const cases: Array<{
    label: string;
    fireDate: string;
    etDate: string;
    resolved: { kind: "stop" | "target"; date: string } | null;
    expectStatus: "confirmed" | "late" | "resolved";
    expectType: string;
  }> = [
    { label: "same-day fire", fireDate: dateAt(3), etDate: dateAt(3), resolved: null, expectStatus: "confirmed", expectType: "entry_confirmed" },
    { label: "earlier fire, still open", fireDate: dateAt(1), etDate: dateAt(4), resolved: null, expectStatus: "late", expectType: "late_entry" },
    { label: "earlier fire, stopped out", fireDate: dateAt(1), etDate: dateAt(4), resolved: { kind: "stop", date: dateAt(3) }, expectStatus: "resolved", expectType: "entry_resolved" },
    { label: "earlier fire, hit target", fireDate: dateAt(1), etDate: dateAt(4), resolved: { kind: "target", date: dateAt(3) }, expectStatus: "resolved", expectType: "entry_resolved" },
    // A resolved payload on a same-day fire is impossible (the fill hasn't happened);
    // both the alert and the flag must ignore it rather than disagree.
    { label: "same-day fire with a bogus resolved payload", fireDate: dateAt(3), etDate: dateAt(3), resolved: { kind: "stop", date: dateAt(3) }, expectStatus: "confirmed", expectType: "entry_confirmed" },
  ];

  for (const c of cases) {
    const status = firedStatusFor(c.fireDate, c.etDate, c.resolved);
    const alert = mkAlert(c.fireDate, c.etDate, 3, 2, c.resolved);
    check(`${c.label} → firedStatus '${c.expectStatus}'`, status === c.expectStatus, status);
    check(`  alert type is ${c.expectType}`, alert.type === c.expectType, alert.type);
    // The pairing itself is the invariant: one status per alert type, always.
    const pairing: Record<string, string> = {
      entry_confirmed: "confirmed",
      late_entry: "late",
      entry_resolved: "resolved",
    };
    check(`  status and alert type agree`, pairing[alert.type] === status, `${alert.type} vs ${status}`);
  }

  check("every fired classification maps to a persisted status", ["confirmed", "late", "resolved"].every((s) => cases.some((c) => c.expectStatus === s)));
}

// ===========================================================================
console.log("\n[15] SKIP setups produce NO buy alert (frozen SIZE_MAP: Q1/Q2 never traded)");
// ===========================================================================
{
  // A textbook confirming close — the ONLY thing stopping the alert is the size map.
  const bars = [flat(0), flat(1), bar(2, 99, 102, 98, 101), ...flats(3, 5)];

  const cases: Array<{ label: string; sizeBucket?: string | null; tier?: string | null; expectFire: boolean }> = [
    { label: "SKIP bucket", sizeBucket: "skip", tier: "Q2", expectFire: false },
    { label: "Q1, no bucket", sizeBucket: null, tier: "Q1", expectFire: false },
    { label: "Q2, no bucket", sizeBucket: null, tier: "Q2", expectFire: false },
    { label: "SKIP bucket on a Q5 tier (bucket wins)", sizeBucket: "skip", tier: "Q5", expectFire: false },
    { label: "FULL bucket", sizeBucket: "full", tier: "Q5", expectFire: true },
    { label: "HALF bucket", sizeBucket: "half", tier: "Q3", expectFire: true },
    { label: "unclassified (no bucket, no tier)", sizeBucket: null, tier: null, expectFire: true },
    { label: "Q4 tier, no bucket", sizeBucket: null, tier: "Q4", expectFire: true },
  ];

  for (const c of cases) {
    const r = wouldFire({ bars, handleLowDate: HLD, rim: RIM, sizeBucket: c.sizeBucket, tier: c.tier });
    check(`${c.label} -> ${c.expectFire ? "FIRES" : "no alert"}`, r.fired === c.expectFire, r.reason);
  }

  // The suppression is the size map, not a detection failure: detectFire still says
  // "fired" for the very same bars.
  const detected = detectFire(bars, HLD, RIM);
  check("detectFire itself still reports a fire for the SKIP setup's bars", detected.status === "fired");
  check("  so the suppression is the size-map gate, not a missed breakout",
    wouldFire({ bars, handleLowDate: HLD, rim: RIM, sizeBucket: "skip" }).reason.includes("not tradeable"));

  // Gate ordering: a SKIP setup is rejected BEFORE the marker check, so it leaves no
  // marker behind and can still alert if it is later re-ingested as tradeable.
  const skipThenTradeable = wouldFire({ bars, handleLowDate: HLD, rim: RIM, sizeBucket: "full" });
  check("a re-ingested SKIP->FULL setup can still alert", skipThenTradeable.fired);

  // And the rim guard still precedes the size-map gate.
  check("no rim is reported as the no-rim skip, not the size-map skip",
    wouldFire({ bars, handleLowDate: HLD, rim: null, sizeBucket: "skip" }).reason === "skipped: no rim");
}
{
  // The predicate itself, directly.
  check("isTradeableSetup: skip bucket -> false", !isTradeableSetup({ sizeBucket: "skip" }));
  check("isTradeableSetup: SKIP uppercase/padded -> false", !isTradeableSetup({ sizeBucket: "  SKIP  " }));
  check("isTradeableSetup: full -> true", isTradeableSetup({ sizeBucket: "full" }));
  check("isTradeableSetup: half -> true", isTradeableSetup({ sizeBucket: "half" }));
  check("isTradeableSetup: Q1 tier -> false", !isTradeableSetup({ tier: "Q1" }));
  check("isTradeableSetup: q2 lowercase -> false", !isTradeableSetup({ tier: "q2" }));
  check("isTradeableSetup: Q3/Q4/Q5 -> true", ["Q3", "Q4", "Q5"].every((t) => isTradeableSetup({ tier: t })));
  check("isTradeableSetup: empty -> true (no positive skip evidence)", isTradeableSetup({}));
}

// ===========================================================================
// [8] + [9] — properties of the pending ACCESSOR, against a real DB.
// ===========================================================================
const dir = mkdtempSync(join(tmpdir(), "jack-entry-alert-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

async function dbCases(): Promise<void> {
  console.log("\n[8]+[9] Eligibility comes from the run-scoped, owned-excluded pending set");
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");

  const meta = (t: string, n: number) => ({
    timestamp: t, inputRowCount: n, totalFinalCount: n, liveFinalCount: n, pendingFinalCount: n,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, parseSuccess: true,
  });

  function ingest(ts: string, rows: Array<{ t: string; section: "live" | "pending" }>) {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(`${r.t}|${HLD}`, write.upsertSetup({
        ticker: r.t, handleLowDate: HLD, status: r.section === "live" ? "just_fired" : "pending",
        entry: 101, stop: 95, t05Target: 115, breakoutLevel: RIM,
        tier: "Q5", priority: 7.5, sizeBucket: "full",
      }, ts));
    }
    const runId = write.insertValidationRun(meta(ts, rows.length));
    const { ids } = write.insertDecisions(
      rows.map((r) => ({ ticker: r.t, handleLowDate: HLD, section: r.section, decision: "WATCH" })),
      runId, map
    );
    write.retireSupersededSetups([...map.values()], runId, ts);
    return { runId, ids, map };
  }

  // Run 1: OLDPEND is pending. Run 2 (the current board) drops it and adds PEND + OWNED.
  ingest("2026-03-01T12:00:00.000Z", [{ t: "OLDPEND", section: "pending" }]);
  const run2 = ingest("2026-03-08T12:00:00.000Z", [
    { t: "PEND", section: "pending" },
    { t: "OWNED", section: "pending" },
  ]);
  // OWNED is marked TRADED with an entry fill and no exit → currently owned.
  read.markDecisionUserAction(run2.ids.find((i) => i.ticker === "OWNED")!.decisionId, "TRADED");
  write.updateUserFills(run2.map.get(`OWNED|${HLD}`)!, 101, "2026-03-09", null, null);

  const eligible = read.getPendingSetups().map((s) => s.ticker);
  check("[8] currently-OWNED ticker is excluded from the entry loop", !eligible.includes("OWNED"), eligible.join(","));
  check("[9] setup not in the current run-scoped board is excluded", !eligible.includes("OLDPEND"), eligible.join(","));
  check("the genuinely pending setup IS eligible", eligible.includes("PEND"), eligible.join(","));
  check("eligible set is exactly [PEND]", eligible.length === 1 && eligible[0] === "PEND", eligible.join(","));

  // Display fields the message needs must survive the accessor.
  const pend = read.getPendingSetups().find((s) => s.ticker === "PEND")!;
  check("pending row carries the rim", pend.breakout === RIM, String(pend.breakout));
  check("pending row carries tier/priority/sizeBucket for the message", pend.tier === "Q5" && pend.priority === 7.5 && pend.sizeBucket === "full");

  // End-to-end: the eligible setup + real bars → a fired alert, once.
  const bars = [flat(0), flat(1), bar(2, 99, 102, 98, 101), ...flats(3, 5)];
  const decision = wouldFire({ bars, handleLowDate: pend.handleLowDate, rim: pend.breakout });
  check("eligible pending setup with a confirming close fires", decision.fired, decision.reason);
  const alert = evalEntryConfirmed({
    ticker: pend.ticker, fireClose: 101, breakout: pend.breakout as number,
    fireBarIndex: decision.fireBarIndex as number, handleLowDate: pend.handleLowDate,
    fireDate: decision.fireDate as string, etDate: decision.fireDate as string, sessionsAgo: 0,
    stop: pend.stop, target: pend.target, tier: pend.tier,
    pRank: null, sizeBucket: pend.sizeBucket,
  });
  check("end-to-end message is a SYSTEM entry-confirmed alert for PEND", alert.type === "entry_confirmed" && alert.ticker === "PEND" && alert.kind === "system");
}

dbCases()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });
