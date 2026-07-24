/**
 * JACK alerts selftest — PURE only (no Telegram, no Redis, no DB, no network).
 * Run: npx tsx scripts/jack-alerts-selftest.ts
 *
 * Covers: the 8 condition evaluators, entry-trigger same-day-cross semantics,
 * tngoLast/prevClose null guards, tradingDaysUntil (weekend + real NYSE-holiday),
 * addCalendarDaysISO, the Redis dedup key scheme, message-format invariants, and
 * parseEarningsCalendar. The orchestration (DB + Telegram + Finnhub I/O) is exercised
 * by the live scripts (jack-telegram-test.ts / jack-finnhub-test.ts).
 */
import {
  evalApproachStop,
  evalApproachTarget,
  evalBigMove,
  evalEntryTrigger,
  evalStopHit,
  evalTargetHit,
  evalTimeStop,
  evalEarnings,
  tradingDaysUntil,
  addCalendarDaysISO,
  alertMarkerKey,
  healthMarkerKey,
  APPROACH_PCT,
} from "@/lib/jack/alerts";
import { parseEarningsCalendar } from "@/lib/jack/finnhub";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── approaching stop (NOW within 3% ABOVE stop) ─────────────────────────────
check("approach_stop fires within band", evalApproachStop("aapl", 102, 100) !== null);
check("approach_stop null just above band", evalApproachStop("aapl", 100 * (1 + APPROACH_PCT) + 0.01, 100) === null);
check("approach_stop null at/below stop", evalApproachStop("aapl", 100, 100) === null && evalApproachStop("aapl", 99, 100) === null);
check("approach_stop null when now null", evalApproachStop("aapl", null, 100) === null);
check("approach_stop null when stop null", evalApproachStop("aapl", 102, null) === null);

// ── approaching target (NOW within 3% BELOW target) ─────────────────────────
check("approach_target fires within band", evalApproachTarget("nvda", 98, 100) !== null);
check("approach_target null at/above target", evalApproachTarget("nvda", 100, 100) === null && evalApproachTarget("nvda", 101, 100) === null);
check("approach_target null below band", evalApproachTarget("nvda", 96, 100) === null);
{
  const a = evalApproachTarget("nvda", 98, 100);
  check("approach_target shows negative delta", !!a && a.text.includes("-2.0%"));
}

// ── big move (|NOW vs prevClose| >= 7%) ─────────────────────────────────────
check("big_move fires +7%", evalBigMove("tsla", 107, 100) !== null);
check("big_move no at +6.9%", evalBigMove("tsla", 106.9, 100) === null);
check("big_move fires -8%", evalBigMove("tsla", 92, 100) !== null);
check("big_move null when prevClose null", evalBigMove("tsla", 107, null) === null);

// ── entry trigger: same-day CROSS only ──────────────────────────────────────
check("entry_trigger fires on cross", evalEntryTrigger("msft", 99, 101, 100) !== null);
check("entry_trigger no when already above (prev>=level)", evalEntryTrigger("msft", 100, 101, 100) === null);
check("entry_trigger no when still below (last<level)", evalEntryTrigger("msft", 99, 99.5, 100) === null);
check("entry_trigger null prevClose", evalEntryTrigger("msft", null, 101, 100) === null);
check("entry_trigger null level", evalEntryTrigger("msft", 99, 101, null) === null);

// ── stop / target hit (close-based) ─────────────────────────────────────────
check("stop_hit at close<=stop", evalStopHit("glng", 44.8, 45) !== null && evalStopHit("glng", 45, 45) !== null);
check("stop_hit null above stop", evalStopHit("glng", 46, 45) === null);
check("target_hit at close>=target", evalTargetHit("homb", 31.2, 31) !== null && evalTargetHit("homb", 31, 31) !== null);
check("target_hit null below target", evalTargetHit("homb", 30.9, 31) === null);

// ── time stop (~110 of 120 calendar days) ───────────────────────────────────
check("time_stop fires at 110", evalTimeStop("roku", 110) !== null);
check("time_stop fires past window", evalTimeStop("roku", 125) !== null);
check("time_stop null at 109", evalTimeStop("roku", 109) === null);
check("time_stop null when daysHeld null", evalTimeStop("roku", null) === null);

// ── earnings (advisory) ─────────────────────────────────────────────────────
check("earnings fires within 5 td", evalEarnings("abc", "2026-07-30", 5) !== null);
check("earnings null at 6 td", evalEarnings("abc", "2026-07-31", 6) === null);
check("earnings fires imminent (0 td)", evalEarnings("abc", "2026-07-24", 0) !== null);
check("earnings null when td null", evalEarnings("abc", "2026-07-30", null) === null);

// ── tradingDaysUntil ────────────────────────────────────────────────────────
const wkStub = (iso: string) => {
  const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
};
check("tradingDaysUntil same-day = 0", tradingDaysUntil("2026-07-24", "2026-07-24", wkStub) === 0);
check("tradingDaysUntil past = 0", tradingDaysUntil("2026-07-24", "2026-07-20", wkStub) === 0);
// Fri 2026-07-24 → Fri 2026-07-31: skip Sat/Sun → 27,28,29,30,31 = 5 trading days
check("tradingDaysUntil skips weekend", tradingDaysUntil("2026-07-24", "2026-07-31", wkStub) === 5, String(tradingDaysUntil("2026-07-24", "2026-07-31", wkStub)));
// Real NYSE holiday set: 2026-07-03 (Independence observed) is a holiday; 7/4–7/5 weekend.
// Wed 7/1 → Mon 7/6: 7/2 trades, 7/3 holiday, 7/4–5 weekend, 7/6 trades → 2.
check("tradingDaysUntil respects NYSE holiday", tradingDaysUntil("2026-07-01", "2026-07-06") === 2, String(tradingDaysUntil("2026-07-01", "2026-07-06")));

// ── addCalendarDaysISO ──────────────────────────────────────────────────────
check("addCalendarDaysISO +14", addCalendarDaysISO("2026-07-24", 14) === "2026-08-07", addCalendarDaysISO("2026-07-24", 14));
check("addCalendarDaysISO month roll", addCalendarDaysISO("2026-01-31", 1) === "2026-02-01");

// ── dedup key scheme ────────────────────────────────────────────────────────
check("alertMarkerKey format + uppercases ticker", alertMarkerKey("stop_hit", "aapl", "2026-07-24") === "jack:alert:stop_hit:AAPL:2026-07-24");
check("healthMarkerKey format", healthMarkerKey("iex_batch", "2026-07-24") === "jack:alert:health:iex_batch:2026-07-24");

// ── message-format invariants ───────────────────────────────────────────────
{
  const hu = evalApproachStop("aapl", 102, 100)!;
  check("heads-up carries the not-a-signal footer", hu.text.includes("heads-up · intraday · not a system signal"));
  check("heads-up kind + uppercased ticker", hu.kind === "heads-up" && hu.ticker === "AAPL" && hu.text.includes("AAPL"));
  const sys = evalStopHit("glng", 44.8, 45)!;
  check("system message has SYSTEM prefix", sys.kind === "system" && sys.text.includes("SYSTEM"));
  check("system message has NO heads-up footer", !sys.text.includes("not a system signal"));
  const er = evalEarnings("abc", "2026-07-30", 3)!;
  check("earnings labeled advisory", er.text.includes("advisory"));
}

// ── parseEarningsCalendar ───────────────────────────────────────────────────
{
  const json = {
    earningsCalendar: [
      { symbol: "aapl", date: "2026-07-30" },
      { symbol: "AAPL", date: "2026-08-15" }, // later dup → keep earliest
      { symbol: "MSFT", date: "2026-07-01" }, // before window → ignored
      { symbol: "NVDA", date: "2026-07-28" },
      { date: "2026-07-29" }, // no symbol → skipped
    ],
  };
  const m = parseEarningsCalendar(json, "2026-07-24");
  check("parse keeps earliest upcoming + uppercases", m.AAPL === "2026-07-30");
  check("parse ignores past dates", !("MSFT" in m));
  check("parse maps NVDA", m.NVDA === "2026-07-28");
  check("parse drops symbol-less rows", Object.keys(m).length === 2, JSON.stringify(m));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
