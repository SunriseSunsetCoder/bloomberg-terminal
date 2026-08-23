/*
 * JACK Phase 3 self-test — entry_status boundaries + PREDICATE PARITY.
 *
 * Run:  npx tsx scripts/jack-entry-status-selftest.ts
 *
 * Two halves:
 *
 *   1. BOUNDARIES — FRESH / AGING / PENDING / UNKNOWN against synthetic bar
 *      series, including bar 15 vs bar 16 of the confirm window and the
 *      assertion that AGING has NO upper bound (no STALE — sub-rim fills
 *      validated better, 2026-08-22 handoff).
 *
 *   2. PARITY — the load-bearing half. For every fixture, the stamper's notion of
 *      "confirmed" is asserted IDENTICAL to what lib/jack/promotion.ts's
 *      isPromotedToLive() sees: same fire/no-fire verdict, same confirming date.
 *      Both call the same detectFire, so this is a regression net around that
 *      structural guarantee rather than a comparison of two rules.
 */
import { classifyEntryStatus, stampCsv, calendarDaysBetween } from "./jack-stamp-entry-status";
import { detectFire, CONFIRM_WINDOW_BARS, type Bar } from "../lib/jack/outcome-tracker";
import { isPromotedToLive } from "../lib/jack/promotion";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `   ${detail}` : ""}`);
  }
}

// ---- fixtures ---------------------------------------------------------------
// Trading-day series (weekdays only), so "bars" and "sessions" line up.
function tradingDays(startIso: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startIso}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const RIM = 100;
const HANDLE_LOW_DATE = "2026-08-03"; // a Monday

/**
 * Build a bar series where bar #`fireOn` (1-based, after the handle low) closes
 * above the rim and every other bar closes below. `total` bars after the handle low.
 * fireOn = 0 -> never clears.
 */
function series(total: number, fireOn: number): Bar[] {
  const dates = tradingDays(HANDLE_LOW_DATE, total + 1); // [0] is the handle-low bar
  return dates.map((date, i) => {
    const clears = fireOn > 0 && i === fireOn;
    const close = clears ? RIM + 1.5 : RIM - 2;
    return { date, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1_000 };
  });
}

const lastDate = (bars: Bar[]) => bars[bars.length - 1].date;

console.log("\n=== 1. BOUNDARIES ===\n");

// --- FRESH: confirmed on the most recent close -------------------------------
{
  const bars = series(5, 5); // fires on the LAST bar
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
  check("fire on the most recent close -> FRESH", s.entryStatus === "FRESH", s.entryStatus);
  check("FRESH: bars_since_confirm = 0", s.barsSinceConfirm === 0, String(s.barsSinceConfirm));
  check("FRESH: confirmed_close_date = the last bar", s.confirmedCloseDate === lastDate(bars), String(s.confirmedCloseDate));
  check("FRESH: days_since_confirm = 0", s.daysSinceConfirm === 0, String(s.daysSinceConfirm));
}

// --- AGING: confirmed 3 bars ago, the modeled next-open has passed ------------
{
  const bars = series(8, 5); // fires on bar 5, three more bars follow
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
  check("fire 3 bars ago -> AGING", s.entryStatus === "AGING", s.entryStatus);
  check("AGING: bars_since_confirm = 3", s.barsSinceConfirm === 3, String(s.barsSinceConfirm));
  check("AGING: confirmed_close_date is the fire bar, not the last bar",
    s.confirmedCloseDate === bars[5].date, String(s.confirmedCloseDate));
  check("AGING is flagged, never auto-skipped", s.entryStatus === "AGING");
}

// --- AGING is UNBOUNDED: no entry-window expiry -----------------------------
{
  // The old build turned this into STALE at 16 bars. Sub-rim fills validated
  // BETTER (PF 2.65 vs 2.21), so an aged fire is never expired out of the book.
  for (const age of [15, 16, 40, 120]) {
    const bars = series(1 + age, 1);
    const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
    check(`${age} sessions since confirm -> still AGING (no expiry)`,
      s.entryStatus === "AGING" && s.barsSinceConfirm === age,
      `${s.entryStatus}/${s.barsSinceConfirm}`);
  }
  const ancient = series(200, 1);
  const a = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars: ancient, today: lastDate(ancient) });
  check("a very old fire still carries its confirm date", a.confirmedCloseDate === ancient[1].date);
  check("STALE is not a reachable label", (a.entryStatus as string) !== "STALE");
}

// --- confirm window closed unconfirmed -> PENDING, not a third label --------
{
  const bars = series(CONFIRM_WINDOW_BARS + 4, 0); // never clears, window fully elapsed
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
  check("confirm window elapsed, never cleared -> PENDING", s.entryStatus === "PENDING", s.entryStatus);
  check("unconfirmed has no confirm date", s.confirmedCloseDate === null);
  check("pending expiry is NOT this file's job (no STALE emitted)",
    (s.entryStatus as string) !== "STALE");
}

// --- PENDING: window still open ----------------------------------------------
{
  const bars = series(4, 0); // no clear yet, only 4 of 15 bars elapsed
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
  check("window still open, no clear -> PENDING", s.entryStatus === "PENDING", s.entryStatus);
  check("PENDING has no confirm date", s.confirmedCloseDate === null);
}

// --- the confirm-window edge (inherited from detectFire) ---------------------
{
  const inside = series(CONFIRM_WINDOW_BARS + 3, CONFIRM_WINDOW_BARS);
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars: inside, today: lastDate(inside) });
  check(`clear on bar ${CONFIRM_WINDOW_BARS} (last in-window bar) -> counts as a fire`,
    s.confirmedCloseDate !== null, s.entryStatus);

  const outside = series(CONFIRM_WINDOW_BARS + 3, CONFIRM_WINDOW_BARS + 1);
  const t = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars: outside, today: lastDate(outside) });
  check(`clear on bar ${CONFIRM_WINDOW_BARS + 1} (just outside) -> NOT a fire, PENDING`,
    t.entryStatus === "PENDING" && t.confirmedCloseDate === null, `${t.entryStatus}/${t.confirmedCloseDate}`);
}

// --- strict > , not >= -------------------------------------------------------
{
  const dates = tradingDays(HANDLE_LOW_DATE, 6);
  const exactly: Bar[] = dates.map((date, i) => {
    const close = i === 3 ? RIM : RIM - 2; // closes EXACTLY at the rim
    return { date, open: close, high: close, low: close, close, volume: 1 };
  });
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars: exactly, today: lastDate(exactly) });
  check("close EXACTLY at the rim is NOT a confirmation (strict >)",
    s.confirmedCloseDate === null, String(s.confirmedCloseDate));
}

// --- an intraday poke through the rim is not a breakout ----------------------
{
  const dates = tradingDays(HANDLE_LOW_DATE, 6);
  const poke: Bar[] = dates.map((date) => ({
    date, open: RIM - 2, high: RIM + 5, low: RIM - 3, close: RIM - 2, volume: 1,
  }));
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars: poke, today: lastDate(poke) });
  check("intraday HIGH through the rim is not a fire", s.confirmedCloseDate === null);
}

// --- UNKNOWN: fail closed ----------------------------------------------------
{
  const bars = series(5, 3);
  const noRim = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: null, bars, today: lastDate(bars) });
  check("rimless -> UNKNOWN, never substituted with entry", noRim.entryStatus === "UNKNOWN", noRim.entryStatus);
  const noBars = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars: [], today: "2026-08-20" });
  check("no corpus bars -> UNKNOWN", noBars.entryStatus === "UNKNOWN", noBars.entryStatus);
}

// --- calendar days vs trading bars ------------------------------------------
{
  // Fire on a Friday, last bar the following Wednesday: 3 trading bars, 5 calendar days.
  const bars = series(8, 5);
  const s = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
  check("days_since_confirm counts CALENDAR days, bars_since_confirm counts BARS",
    s.daysSinceConfirm !== null && s.barsSinceConfirm !== null && s.daysSinceConfirm >= s.barsSinceConfirm,
    `days=${s.daysSinceConfirm} bars=${s.barsSinceConfirm}`);
  check("calendarDaysBetween spans a weekend correctly",
    calendarDaysBetween("2026-08-07", "2026-08-10") === 3);
}

console.log("\n=== 2. PREDICATE PARITY vs lib/jack/promotion.ts isPromotedToLive ===\n");

/*
 * Both sides must agree on FIRED / NOT-FIRED and on the confirming DATE for every
 * fixture. isPromotedToLive adds gates the stamper deliberately does not have
 * (tradeable quintile, already-resolved), so parity is asserted on the CONFIRM
 * question only — which is the shared part, and the part that must never diverge.
 */
const parityCases: Array<{ name: string; bars: Bar[] }> = [
  { name: "fires on the last bar", bars: series(5, 5) },
  { name: "fires mid-window", bars: series(8, 3) },
  { name: `fires on bar ${CONFIRM_WINDOW_BARS} (in-window edge)`, bars: series(CONFIRM_WINDOW_BARS + 2, CONFIRM_WINDOW_BARS) },
  { name: `clears on bar ${CONFIRM_WINDOW_BARS + 1} (out-of-window)`, bars: series(CONFIRM_WINDOW_BARS + 3, CONFIRM_WINDOW_BARS + 1) },
  { name: "never clears, window elapsed", bars: series(CONFIRM_WINDOW_BARS + 4, 0) },
  { name: "never clears, window still open", bars: series(4, 0) },
  { name: "fires long ago (deep AGING, no expiry)", bars: series(40, 1) },
];

for (const { name, bars } of parityCases) {
  const today = lastDate(bars);
  const stamp = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today });

  // Board side. sizeBucket 'full' clears the quintile gate; no stop/target so the
  // already-resolved branch is skipped, isolating the confirm question.
  const promo = isPromotedToLive(
    { handleLowDate: HANDLE_LOW_DATE, breakout: RIM, sizeBucket: "full", tier: "Q5" },
    bars,
    today
  );

  const stamperSaysFired = stamp.confirmedCloseDate !== null;
  const boardSawFire = promo.fireDate !== null;

  check(`[${name}] fired verdict agrees`, stamperSaysFired === boardSawFire,
    `stamper=${stamperSaysFired} board=${boardSawFire} (reason=${promo.reason})`);
  check(`[${name}] confirming date agrees`, stamp.confirmedCloseDate === promo.fireDate,
    `stamper=${stamp.confirmedCloseDate} board=${promo.fireDate}`);
}

// Both sides must ALSO agree with detectFire itself — the shared source.
{
  const bars = series(9, 4);
  const raw = detectFire([...bars].sort((a, b) => a.date.localeCompare(b.date)), HANDLE_LOW_DATE, RIM);
  const stamp = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, bars, today: lastDate(bars) });
  const promo = isPromotedToLive({ handleLowDate: HANDLE_LOW_DATE, breakout: RIM, sizeBucket: "full" }, bars, lastDate(bars));
  check("stamper == detectFire == promoter, all three on one fixture",
    stamp.confirmedCloseDate === raw.fireDate && promo.fireDate === raw.fireDate,
    `stamp=${stamp.confirmedCloseDate} raw=${raw.fireDate} promo=${promo.fireDate}`);
}

// The rim FAIL-CLOSED behaviour must match too.
{
  const bars = series(5, 3);
  const stamp = classifyEntryStatus({ handleLowDate: HANDLE_LOW_DATE, breakout: null, bars, today: lastDate(bars) });
  const promo = isPromotedToLive({ handleLowDate: HANDLE_LOW_DATE, breakout: null, sizeBucket: "full" }, bars, lastDate(bars));
  check("rimless: stamper UNKNOWN and promoter no_rim — both refuse to judge",
    stamp.entryStatus === "UNKNOWN" && promo.reason === "no_rim" && !promo.promoted);
}

console.log("\n=== 3. CSV STAMPING ===\n");
{
  const dir = mkdtempSync(join(tmpdir(), "jack-p3-"));
  try {
    const bars = series(6, 6); // FRESH
    const csvBody = bars.map((b) => `${b.date},${b.open},${b.high},${b.low},${b.close},${b.volume}`).join("\n");
    writeFileSync(join(dir, "FRESHCO.csv"), `Date,Open,High,Low,Close,Volume\n${csvBody}\n`, "utf-8");

    const aged = series(9, 3); // AGING
    writeFileSync(
      join(dir, "AGED.csv"),
      "Date,Open,High,Low,Close,Volume\n" +
        aged.map((b) => `${b.date},${b.open},${b.high},${b.low},${b.close},${b.volume}`).join("\n") + "\n",
      "utf-8"
    );

    const today = lastDate(bars);
    const wl =
      "ticker,bucket,status,size_bucket,handle_low_date,breakout_level,entry,stop,t05_target\n" +
      `FRESHCO,just_fired,just_fired,full,${HANDLE_LOW_DATE},${RIM},101,95,110\n` +
      `AGED,just_fired,just_fired,full,${HANDLE_LOW_DATE},${RIM},101,95,110\n` +
      `NOCORP,pending,pending,full,${HANDLE_LOW_DATE},${RIM},101,95,110\n` +
      `RIMLESS,pending,pending,full,${HANDLE_LOW_DATE},,101,95,110\n`;

    const { text, report } = stampCsv(wl, dir, today);
    const rows = text.trim().split("\n");
    const header = rows[0].split(",");

    check("four stamp columns appended", ["confirmed_close_date", "days_since_confirm", "bars_since_confirm", "entry_status"]
      .every((c) => header.includes(c)), header.join(","));
    check("original columns preserved", ["ticker", "size_bucket", "breakout_level", "t05_target"]
      .every((c) => header.includes(c)));
    check("FRESHCO stamped FRESH", rows[1].endsWith(",FRESH"), rows[1]);
    check("AGED stamped AGING", rows[2].endsWith(",AGING"), rows[2]);
    check("missing corpus file -> UNKNOWN", rows[3].endsWith(",UNKNOWN"), rows[3]);
    check("rimless -> UNKNOWN", rows[4].endsWith(",UNKNOWN"), rows[4]);
    check("report counts line up", report.rows === 4 && report.counts.FRESH === 1 && report.counts.AGING === 1
      && report.counts.UNKNOWN === 2, JSON.stringify(report.counts));
    check("rimless tracked separately from missing-corpus",
      report.rimless.includes("RIMLESS") && report.missingCorpus.includes("NOCORP"),
      JSON.stringify({ r: report.rimless, m: report.missingCorpus }));

    // Idempotence: stamping twice must not duplicate the columns.
    const again = stampCsv(text, dir, today);
    const header2 = again.text.trim().split("\n")[0].split(",");
    check("re-stamping replaces the columns, never duplicates them",
      header2.filter((h) => h === "entry_status").length === 1 && header2.length === header.length,
      header2.join(","));
    check("re-stamp is stable (same output)", again.text === text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
