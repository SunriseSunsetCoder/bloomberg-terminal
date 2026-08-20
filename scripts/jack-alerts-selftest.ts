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
  // Fix 1 — scope + the emission chokepoint
  buildAlertScope,
  emitAlert,
  fireAlert,
  fireOnce,
  newEmitStats,
  setAlertTransport,
  isLifetimeMarker,
  secondChanceMarkerKey,
  entryMarkerKey,
  type AlertTransport,
  // Fix 2 — touch detection
  hitMarkerKey,
  detectTouch,
  hitKindFor,
  evalTouchAlert,
  quoteTouchRange,
  buildIntradayTouchAlerts,
  evaluateLiveTouchBackstop,
  evalSecondChanceAlert,
  type TouchRow,
  // Fix 3 / promoter — pending→live promotion
  buildBoardScope,
  evalPromotionAlert,
  promotionMarkerKey,
  promotePendingToLive,
  evalEntryConfirmed,
} from "@/lib/jack/alerts";
import { isPromotedToLive } from "@/lib/jack/promotion";
import { parseEarningsCalendar } from "@/lib/jack/finnhub";
import type { IexQuote } from "@/lib/jack/price-refresh";

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

// ============================================================================
// FIX 1 (alert scope / emitAlert chokepoint) + FIX 2 (intraday TP-SL touch)
//
// Still no network, no Redis, no Telegram, no DB: the transport is injected and every
// builder is pure. The 9 numbered tests are the spec's acceptance list.
// ============================================================================

const ET = "2026-08-19";
const HLD = "2026-07-06";

// In-memory transport — the whole funnel (scope → purge → dedup → send) is observable.
function memTransport() {
  const store = new Map<string, string>();
  const sent: string[] = [];
  const t: AlertTransport = {
    enabled: () => true,
    get: async (k) => store.get(k) ?? null,
    set: async (k) => {
      store.set(k, "1");
    },
    del: async (k) => {
      store.delete(k);
    },
    send: async (text) => {
      sent.push(text);
      return { ok: true };
    },
  };
  return { t, store, sent };
}

// A board row as getCurrentBoard() returns it (only the fields the scope rules read).
const boardRow = (ticker: string, over: Record<string, unknown> = {}) => ({
  ticker,
  handleLowDate: HLD,
  section: "live" as const,
  sizeBucket: "full",
  tier: "Q5",
  userAction: null,
  userExitPrice: null,
  retiredAt: null,
  stop: 95,
  target: 110,
  ...over,
});

const quote = (ticker: string, over: Partial<IexQuote> = {}): IexQuote => ({
  ticker,
  tngoLast: 100,
  last: 100,
  prevClose: 99,
  price: 100,
  dayHigh: 100,
  dayLow: 100,
  // 14:30 UTC = 10:30 ET on a Wednesday — inside RTH.
  timestamp: "2026-08-19T14:30:00Z",
  ...over,
});

async function asyncTests(): Promise<void> {
  // ── scope construction ────────────────────────────────────────────────────
  {
    const scope = buildAlertScope(
      [{ ticker: "held" }],
      [
        boardRow("LIVEA"),
        boardRow("PENDB", { section: "pending", firedStatus: null }), // pending, un-fired → OUT
        boardRow("OWNEDC", { userAction: "TRADED", userExitPrice: null }), // owned → OUT (open half covers it)
        boardRow("RETIRD", { retiredAt: "2026-08-01" }), // retired → OUT
        boardRow("SKIPQ2", { tier: "Q2", sizeBucket: "skip" }), // never entered → OUT
      ]
    );
    check("scope = open ∪ live, uppercased", scope.has("HELD") && scope.has("LIVEA"));
    check("scope excludes un-fired PENDING (not getPendingSetups)", !scope.has("PENDB"));
    check("scope excludes retired + SKIP-bucket rows", !scope.has("RETIRD") && !scope.has("SKIPQ2"));
    check("a fired-promoted pending row IS live", buildAlertScope([], [boardRow("FIRED", { section: "pending", firedStatus: "confirmed" })]).has("FIRED"));
  }

  // ── 1. stale ticker not in the latest board → zero alerts of ANY type ──────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([{ ticker: "UMBF" }], [boardRow("SPY")]);
    const stats = newEmitStats();
    // NOW: on a previous board, absent from the latest validation. Every path tried.
    const results = [
      await fireAlert(evalApproachStop("NOW", 102, 100)!, ET, scope, stats),
      await fireAlert(evalApproachTarget("NOW", 98, 100)!, ET, scope, stats),
      await fireAlert(evalBigMove("NOW", 108, 100)!, ET, scope, stats),
      await fireAlert(evalStopHit("NOW", 94, 95)!, ET, scope, stats),
      await fireAlert(evalTargetHit("NOW", 111, 110)!, ET, scope, stats),
      await fireAlert(evalTimeStop("NOW", 115)!, ET, scope, stats),
      await fireAlert(evalEarnings("NOW", "2026-08-21", 2)!, ET, scope, stats),
      await fireOnce(evalTouchAlert({ ticker: "NOW", owned: true, touch: "target", stop: 95, target: 110, source: "intraday" }), hitMarkerKey("target_hit", "NOW", HLD), scope, undefined, stats),
    ];
    check("1. stale ticker: every alert path returns false", results.every((r) => r === false), JSON.stringify(results));
    check("1. stale ticker: nothing sent", sent.length === 0, `${sent.length} sent`);
    check("1. stale ticker: suppression counted", stats.suppressedOutOfScope === results.length);
    check("1. an IN-scope ticker still fires (guard isn't blanket-off)", (await fireAlert(evalApproachStop("SPY", 102, 100)!, ET, scope, stats)) === true);
  }

  // ── 2. stale marker present but out of scope → suppressed + purged ─────────
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([], [boardRow("SPY")]);
    const dayKey = alertMarkerKey("approach_stop", "NOW", ET);
    const hitKey = hitMarkerKey("target_hit", "NOW", HLD);
    const entryKey = entryMarkerKey("NOW", HLD);
    store.set(dayKey, "1");
    store.set(hitKey, "1");
    store.set(entryKey, "1");
    await fireAlert(evalApproachStop("NOW", 102, 100)!, ET, scope);
    await fireOnce(evalTouchAlert({ ticker: "NOW", owned: true, touch: "target", stop: 95, target: 110, source: "intraday" }), hitKey, scope);
    await fireOnce(evalTargetHit("NOW", 111, 110)!, entryKey, scope);
    check("2. non-hit marker for an out-of-scope ticker is PURGED", !store.has(dayKey));
    check("2. hit marker is EXEMPT (a fired hit stays deduped on re-entry)", store.has(hitKey));
    check("2. lifetime entry marker is EXEMPT too", store.has(entryKey));
    check("2. nothing was sent while purging", sent.length === 0);
    check("2. isLifetimeMarker classifies the four hit namespaces", ["target_hit", "stop_hit", "ran_to_target", "setup_invalidated"].every((k) => isLifetimeMarker(`jack:alert:${k}:X:${HLD}`)));
    check("2. …and NOT the per-day ones", !isLifetimeMarker(alertMarkerKey("approach_stop", "X", ET)));
  }

  // ── 3. owned: dayHigh >= t05, close < t05 → intraday TARGET-HIT once ───────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([{ ticker: "TPX" }], []);
    const rows: TouchRow[] = [{ ticker: "TPX", handleLowDate: HLD, stop: 95, target: 110, owned: true }];
    // High 111 crossed t05; last print 108 (would close BELOW t05 → close-based blind).
    const touches = buildIntradayTouchAlerts(rows, [quote("TPX", { dayHigh: 111, dayLow: 104, tngoLast: 108 })]);
    check("3. an intraday touch is detected on the running day high", touches.length === 1 && touches[0].kind === "target_hit");
    check("3. …labeled as an intraday touch", touches[0].alert.text.includes("[intraday touch]") && touches[0].alert.text.includes("TARGET HIT"));
    check("3. …and the close-based evaluator alone would have MISSED it", evalTargetHit("TPX", 108, 110) === null);
    const first = await emitAlert(touches[0].alert, { scope, key: touches[0].key });
    const second = await emitAlert(touches[0].alert, { scope, key: touches[0].key });
    check("3. fires once", first === true && second === false);
    // EOD close-based on the SAME setup key → no second alert.
    const eod = evalTargetHit("TPX", 112, 110)!;
    const eodFired = await emitAlert(eod, { scope, key: hitMarkerKey("target_hit", "TPX", HLD) });
    check("3. EOD does not re-fire the same hit", eodFired === false);
    check("3. exactly one message total", sent.length === 1, `${sent.length}`);
  }

  // ── 4. stop-first on a same-day tie ───────────────────────────────────────
  {
    const scope = buildAlertScope([{ ticker: "BOTH" }], []);
    const { t, sent } = memTransport();
    setAlertTransport(t);
    check("4. detectTouch returns STOP when both levels were touched", detectTouch({ dayHigh: 111, dayLow: 94, stop: 95, target: 110 }) === "stop");
    const touches = buildIntradayTouchAlerts(
      [{ ticker: "BOTH", handleLowDate: HLD, stop: 95, target: 110, owned: true }],
      [quote("BOTH", { dayHigh: 111, dayLow: 94 })]
    );
    check("4. one alert only, and it is the STOP", touches.length === 1 && touches[0].kind === "stop_hit");
    check("4. …keyed in the stop_hit namespace", touches[0].key === hitMarkerKey("stop_hit", "BOTH", HLD));
    await emitAlert(touches[0].alert, { scope, key: touches[0].key });
    check("4. no target alert was sent", sent.length === 1 && !sent[0].includes("TARGET HIT"));
  }

  // ── 5. live not-owned reaching t05 → RAN TO TARGET UN-ENTERED, once ───────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([], [boardRow("RUNR")]);
    const touches = buildIntradayTouchAlerts(
      [{ ticker: "RUNR", handleLowDate: HLD, stop: 95, target: 110, owned: false }],
      [quote("RUNR", { dayHigh: 112, dayLow: 101 })]
    );
    check("5. not-owned maps to ran_to_target, not target_hit", touches[0]?.kind === "ran_to_target");
    check("5. distinct label — un-entered, explicitly not a win", touches[0].alert.text.includes("RAN TO TARGET UN-ENTERED") && touches[0].alert.text.includes("no breakout entry was taken"));
    check("5. …and it says don't chase", touches[0].alert.text.includes("Don't chase"));
    const a = await emitAlert(touches[0].alert, { scope, key: touches[0].key });
    const b = await emitAlert(touches[0].alert, { scope, key: touches[0].key });
    check("5. fires exactly once", a === true && b === false && sent.length === 1);
    check("5. owned vs not-owned never share a namespace", hitKindFor(true, "target") !== hitKindFor(false, "target"));
  }

  // ── 6. idempotency: intraday then EOD on the same hit → ONE alert ──────────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([{ ticker: "IDEM" }], []);
    const key = hitMarkerKey("stop_hit", "IDEM", HLD);
    const intraday = buildIntradayTouchAlerts(
      [{ ticker: "IDEM", handleLowDate: HLD, stop: 95, target: 110, owned: true }],
      [quote("IDEM", { dayHigh: 99, dayLow: 94 })]
    );
    await emitAlert(intraday[0].alert, { scope, key: intraday[0].key });
    await emitAlert(evalStopHit("IDEM", 94.5, 95)!, { scope, key }); // the EOD close-based pass
    check("6. intraday + EOD on one hit = one message", sent.length === 1, `${sent.length}`);
    check("6. …and it is the intraday one (fired first)", sent[0].includes("[intraday touch]"));
  }

  // ── 7. IEX missed it, consolidated daily bar catches it (EOD backstop) ─────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([], [boardRow("THIN")]);
    const stats = newEmitStats();
    // Intraday: the thin IEX feed never printed above t05.
    const missed = buildIntradayTouchAlerts(
      [{ ticker: "THIN", handleLowDate: HLD, stop: 95, target: 110, owned: false }],
      [quote("THIN", { dayHigh: 109, dayLow: 101 })]
    );
    check("7. intraday sees no touch (IEX high 109 < t05 110)", missed.length === 0);
    // EOD: the consolidated bar shows the high really was 111.
    const bars = [{ date: ET, open: 105, high: 111, low: 104, close: 106, volume: 1e6 }];
    const res = await evaluateLiveTouchBackstop(
      [{ ticker: "THIN", handleLowDate: HLD, stop: 95, target: 110 }],
      scope,
      ET,
      async () => ({ bars }),
      stats
    );
    check("7. the daily-bar backstop fires the un-entered alert", res.fired === 1 && sent.length === 1);
    // The un-entered head is fixed verbatim by spec (no source tag), so provenance
    // rides in the footer: confirmed by the daily bar, NOT a provisional live print.
    check("7. …labeled as the consolidated daily bar, not a live print", sent[0].includes("confirmed · consolidated daily bar") && !sent[0].includes("provisional"));
    check("7. …and an OWNED daily-bar hit does carry the [daily bar] tag", evalTouchAlert({ ticker: "THIN", owned: true, touch: "target", stop: 95, target: 110, source: "eod" }).text.includes("[daily bar]"));
    check("7. …and the IEX-vs-consolidated mismatch is logged", res.mismatches.length === 1 && res.mismatches[0] === "THIN:ran_to_target");
    // Already fired intraday → the backstop is a no-op (shared lifetime key).
    const again = await evaluateLiveTouchBackstop([{ ticker: "THIN", handleLowDate: HLD, stop: 95, target: 110 }], scope, ET, async () => ({ bars }), stats);
    check("7. backstop is idempotent against its own earlier fire", again.fired === 0 && sent.length === 1);
    // A bar for a DIFFERENT day must not be re-reported as today's touch.
    const stale = await evaluateLiveTouchBackstop(
      [{ ticker: "OLD", handleLowDate: HLD, stop: 95, target: 110 }],
      buildAlertScope([], [boardRow("OLD")]),
      ET,
      async () => ({ bars: [{ date: "2026-08-18", open: 105, high: 999, low: 104, close: 106, volume: 1 }] }),
      stats
    );
    check("7. a stale (non-today) bar never fires", stale.fired === 0);
  }

  // ── 8. fill logged AFTER ran_to_target → owned target_hit still fires ──────
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    const ranKey = hitMarkerKey("ran_to_target", "LAG", HLD);
    const ownedKey = hitMarkerKey("target_hit", "LAG", HLD);
    // While un-entered (fill not yet logged) — fires from the live board.
    const liveScope = buildAlertScope([], [boardRow("LAG")]);
    await emitAlert(evalTouchAlert({ ticker: "LAG", owned: false, touch: "target", stop: 95, target: 110, source: "intraday" }), { scope: liveScope, key: ranKey });
    check("8. ran_to_target fired on the stale not-owned state", sent.length === 1 && store.has(ranKey));
    // The fill is logged → the setup is now OWNED. Different namespace ⇒ still fires.
    const ownedScope = buildAlertScope([{ ticker: "LAG" }], []);
    const ownedFired = await emitAlert(evalTouchAlert({ ticker: "LAG", owned: true, touch: "target", stop: 95, target: 110, source: "intraday" }), { scope: ownedScope, key: ownedKey });
    check("8. owned TARGET HIT still fires — separate namespace, not swallowed", ownedFired === true && sent.length === 2);
    check("8. …and it is the realized-win label", sent[1].includes("TARGET HIT") && !sent[1].includes("UN-ENTERED"));
    check("8. the two keys are genuinely different", ranKey !== ownedKey);
    // The nice-to-have reconciliation the /api/jack-decisions user_fills handler runs.
    const { purgeMarker } = await import("@/lib/jack/alerts");
    await purgeMarker(ranKey);
    check("8. fill-write purge clears the stale un-entered marker", !store.has(ranKey));
    check("8. …and leaves the realized win's marker alone", store.has(ownedKey));
  }

  // ── 9. second-chance for an out-of-scope ticker → suppressed by the funnel ─
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    const scope = buildAlertScope([{ ticker: "UMBF" }], [boardRow("SPY")]);
    const sc = evalSecondChanceAlert({ ticker: "GONE", tier: "Q5", pRank: 2, entry: 100, stop: 95, t05: 110, rr: 2, runupPct: 30, cancelBy: "2026-09-01" });
    const key = secondChanceMarkerKey("GONE", HLD);
    const fired = await fireOnce(sc, key, scope);
    check("9. second-chance on a dropped ticker is suppressed", fired === false && sent.length === 0);
    check("9. …its lifetime marker is not purged either", !store.has(key));
    // Same alert, ticker in scope → fires. Proves the guard is the SCOPE, not the type.
    const inScope = await fireOnce(evalSecondChanceAlert({ ticker: "SPY", tier: "Q5", pRank: 1, entry: 100, stop: 95, t05: 110, rr: 2, runupPct: 30, cancelBy: "2026-09-01" }), secondChanceMarkerKey("SPY", HLD), scope);
    check("9. the same path fires for an in-scope ticker", inScope === true && sent.length === 1);
  }

  // ── RTH gate + range fallbacks ────────────────────────────────────────────
  {
    // 08:00 ET (12:00Z) — pre-market print, must never count as a touch.
    const ext = quoteTouchRange(quote("EXT", { timestamp: "2026-08-19T12:00:00Z", dayHigh: 999, dayLow: 1 }));
    check("RTH: an ext-hours print is rejected", ext.rejected === "ext_hours" && ext.high === null);
    const rth = quoteTouchRange(quote("RTH", { dayHigh: 111, dayLow: 104 }));
    check("RTH: an in-session print is accepted", rth.rejected === null && rth.high === 111);
    const noTs = quoteTouchRange(quote("NOTS", { timestamp: null, dayHigh: 111, dayLow: 104 }));
    check("RTH: a missing timestamp fails OPEN (and logs)", noTs.rejected === null && noTs.high === 111);
    const noRange = quoteTouchRange(quote("NORANGE", { dayHigh: null, dayLow: null, tngoLast: 107 }));
    check("range falls back to the last print when high/low are absent", noRange.high === 107 && noRange.low === 107);
    check("no touch when the quote is missing entirely", buildIntradayTouchAlerts([{ ticker: "ABSENT", handleLowDate: HLD, stop: 95, target: 110, owned: true }], []).length === 0);
    check("no touch when neither level is reached", detectTouch({ dayHigh: 109, dayLow: 96, stop: 95, target: 110 }) === null);
    check("null geometry never fabricates a touch", detectTouch({ dayHigh: 109, dayLow: 96, stop: null, target: null }) === null);
  }

  // ==========================================================================
  // PENDING → LIVE PROMOTION — the RIM predicate (strict close > rim, in-window)
  //
  // Re-based from the original close-≥-entry rule: that one was looser in BOTH
  // dimensions (wrong level, no window) and is the class of comparison that announced
  // a breakout on a sub-rim close. One predicate now, shared with the board writer.
  // ==========================================================================

  // TTE, the acceptance case: rim 89.30, entry 89.39, handle low 2026-08-05.
  const TTE_RIM = 89.3;
  const promoRow = (ticker: string, over: Record<string, unknown> = {}) => ({
    setupId: 302,
    decisionId: 9001,
    ticker,
    handleLowDate: HLD,
    breakout: TTE_RIM,
    stop: 84.5,
    target: 97.0,
    sizeBucket: "full",
    tier: "Q3",
    ...over,
  });
  // Bars from the handle low; `closes` are the post-handle-low session closes.
  const barsFrom = (closes: number[], firstDate = "2026-08-06") => {
    const out = [{ date: HLD, open: 88, high: 88.5, low: 87.5, close: 88, volume: 1e6 }];
    const d = new Date(`${firstDate}T00:00:00Z`);
    for (const c of closes) {
      out.push({ date: d.toISOString().slice(0, 10), open: c - 0.2, high: c + 0.3, low: c - 0.5, close: c, volume: 1e6 });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };
  // No-op writer for the alert-side tests (the DB path is covered in the promoter selftest).
  const noopWriter = { markDecisionFired: () => 1, clearDecisionFired: () => 0 };

  // ── 10. in-window close above the rim → promoted + alerted once ───────────
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "TTE" }]);
    const stats = newEmitStats();
    // 14 bars, the last one 90.07 — TTE's real close, decisively above the 89.30 rim.
    const bars = barsFrom([88.4, 88.6, 88.9, 89.0, 89.1, 88.8, 89.2, 89.0, 89.25, 89.28, 89.29, 89.1, 89.2, 90.07]);
    const r = await promotePendingToLive([promoRow("TTE")], board, ET, async () => ({ bars }), noopWriter, stats);
    check("10. TTE promotes on a close above the rim", r.promoted === 1);
    check("10. …and alerts once", r.alerted === 1 && sent.length === 1);
    check("10. …naming rim + bar position, not entry", sent[0].includes("> rim 89.30") && sent[0].includes("since handle low") && !sent[0].includes("entry"));
    check("10. …in the entry_trigger namespace, per setup", store.has(promotionMarkerKey("TTE", HLD)));
    const again = await promotePendingToLive([promoRow("TTE")], board, ET, async () => ({ bars }), noopWriter, stats);
    check("10. re-running does not re-alert", again.alerted === 0 && sent.length === 1);
    check("10. …but still re-affirms the board (idempotent write)", again.promoted === 1);
  }

  // ── 11. the premature-fire bug cannot recur: sub-rim close stays silent ────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "SUB" }]);
    // 89.2842 — the close that wrongly announced a breakout. Below the 89.30 rim.
    const bars = barsFrom([88.4, 88.9, 89.1, 89.0, 89.2842]);
    const r = await promotePendingToLive([promoRow("SUB")], board, ET, async () => ({ bars }), noopWriter, newEmitStats());
    check("11. a SUB-RIM close does NOT promote", r.promoted === 0 && sent.length === 0);
    check("11. strict >, so a close EXACTLY at the rim does not fire", isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, barsFrom([89.3]), ET).promoted === false);
    check("11. …one cent above does", isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, barsFrom([89.31]), ET).promoted === true);
    check(
      "11. an intraday HIGH above the rim with a sub-rim close is silent",
      isPromotedToLive(
        { handleLowDate: HLD, breakout: TTE_RIM },
        [
          { date: HLD, open: 88, high: 88, low: 87, close: 88, volume: 1 },
          { date: "2026-08-06", open: 89, high: 91.5, low: 88.9, close: 89.2, volume: 1 },
        ],
        ET
      ).promoted === false
    );
  }

  // ── 12. outside the 15-bar confirm window → never promoted ────────────────
  {
    // 16 sub-rim bars, then a breakout on bar 17 — past the window.
    const late = barsFrom([...Array(16).fill(88.9), 92.0]);
    const v = isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, late, ET);
    check("12. a close above the rim AFTER the window does not promote", v.promoted === false && v.reason === "not_fired", v.reason);
    // Inside the window but the window has not elapsed → deferred, not a denial.
    const early = isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, barsFrom([88.9, 89.0]), ET);
    check("12. an open window with no fire yet is deferred, not not_fired", early.reason === "deferred" && early.promoted === false);
  }

  // ── 13. rimless fails closed — never promoted on a close-only comparison ──
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "NORIM" }]);
    // A close far above the ENTRY (89.39) — the old rule would have promoted this.
    const bars = barsFrom([88.4, 89.0, 95.0]);
    const r = await promotePendingToLive([promoRow("NORIM", { breakout: null })], board, ET, async () => ({ bars }), noopWriter, newEmitStats());
    check("13. the ~36 rimless cohort is never promoted", r.promoted === 0 && r.rimless === 1 && sent.length === 0);
    check("13. …and never un-promoted either (a lost rim must not erase a valid stamp)", r.unpromoted === 0);
    check("13. the predicate itself fails closed", isPromotedToLive({ handleLowDate: HLD, breakout: null }, bars, ET).reason === "no_rim");
  }

  // ── 14. quintile double-gate + off-board suppression ──────────────────────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const bars = barsFrom([88.4, 89.0, 90.07]);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "SKIPQ2" }, { ticker: "TTE" }]);
    const q2 = await promotePendingToLive([promoRow("SKIPQ2", { tier: "Q2", sizeBucket: "skip" })], board, ET, async () => ({ bars }), noopWriter, newEmitStats());
    check("14. a Q2 / skip-bucket setup is never promoted", q2.promoted === 0 && q2.notTradeable === 1 && sent.length === 0);
    // Off the board entirely (the NOW case) — the board write still happens, but the
    // ALERT is suppressed by the scope guard. Board and alert are independent.
    const offBoard = buildBoardScope(buildAlertScope([], []), []);
    const stats = newEmitStats();
    const nb = await promotePendingToLive([promoRow("TTE")], offBoard, ET, async () => ({ bars }), noopWriter, stats);
    check("14. an off-board ticker's ALERT is suppressed", nb.alerted === 0 && stats.suppressedOutOfScope === 1);
    check("14. …while the board write still happened (never gated by the alert)", nb.promoted === 1);
  }

  // ── the board write is NEVER gated by the Redis alert marker ──────────────
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "TTE" }]);
    // Pre-seed the alert marker, as a premature alert would have.
    store.set(promotionMarkerKey("TTE", HLD), "1");
    let stamped = 0;
    const writer = {
      markDecisionFired: () => {
        stamped++;
        return 1;
      },
      clearDecisionFired: () => 0,
    };
    const bars = barsFrom([88.4, 89.0, 90.07]);
    const r = await promotePendingToLive([promoRow("TTE")], board, ET, async () => ({ bars }), writer, newEmitStats());
    check("marker set ⇒ alert suppressed", r.alerted === 0 && sent.length === 0);
    check("…but the BOARD IS STILL STAMPED — the TTE bug, structurally prevented", stamped === 1 && r.promoted === 1);
  }

  // ── current-geometry re-derivation: a stale fire is un-promoted ───────────
  {
    const { t } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "REVISED" }]);
    let cleared = 0;
    const writer = {
      markDecisionFired: () => 1,
      clearDecisionFired: () => {
        cleared++;
        return 1;
      },
    };
    // The setup fired against an old rim of 89.30 — but a re-scan revised the rim to
    // 91.00, which the same bars never clear.
    const bars = barsFrom([88.4, 89.0, 90.07]);
    const r = await promotePendingToLive([promoRow("REVISED", { breakout: 91.0 })], board, ET, async () => ({ bars }), writer, newEmitStats());
    check("a stale fire on a REVISED rim does not stay promoted", r.promoted === 0 && r.unpromoted === 1 && cleared === 1);
    check("…the same bars DO promote against the original rim", isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, bars, ET).promoted === true);
    // A transient fetch failure must never un-promote.
    let cleared2 = 0;
    const w2 = {
      markDecisionFired: () => 1,
      clearDecisionFired: () => {
        cleared2++;
        return 1;
      },
    };
    const f = await promotePendingToLive([promoRow("REVISED")], board, ET, async () => ({ bars: [], error: "HTTP 500" }), w2, newEmitStats());
    check("a bars-fetch failure never un-promotes", f.fetchFailures === 1 && cleared2 === 0);
  }

  // ── late vs confirmed vs resolved ─────────────────────────────────────────
  {
    const bars = barsFrom([88.4, 90.07, 90.5, 91.0]); // fired on bar 2, days ago
    const late = isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, bars, ET);
    check("a fire dated before today is late, still promoted", late.promoted === true && late.firedStatus === "late");
    const today = isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM }, barsFrom([88.4, 90.07], "2026-08-18"), "2026-08-19");
    check("a fire dated today is confirmed", today.firedStatus === "confirmed", String(today.firedStatus));
    // Fired, then the trade hit its stop — history, not a live idea.
    const resolvedBars = barsFrom([88.4, 90.07, 89.0, 84.0]);
    const res = isPromotedToLive({ handleLowDate: HLD, breakout: TTE_RIM, stop: 84.5, target: 97 }, resolvedBars, ET);
    check("a fire that already resolved is NOT promoted", res.promoted === false && res.reason === "resolved");
    check("…and it is recorded as resolved (stays out of the LIVE group)", res.firedStatus === "resolved");
  }

  // ── the dormant intraday entry_trigger vs the live promotion ─────────────
  {
    const dormant = evalEntryTrigger("TTE", 89.0, 89.5, TTE_RIM)!;
    const promo = evalPromotionAlert({ ticker: "TTE", fireClose: 90.07, rim: TTE_RIM, fireBar: 14, handleLowDate: HLD, late: false });
    check("both carry the entry_trigger type (shared namespace)", dormant.type === "entry_trigger" && promo.type === "entry_trigger");
    check("…but only the promotion is a SYSTEM signal", promo.kind === "system" && dormant.kind === "heads-up");
    check("…and the dormant one is an INTRADAY cross, not a close", dormant.text.includes("NOW") && promo.text.includes("Close 90.07 > rim"));
  }

  // ── PARITY REPAIR: entry confirmation on a first-detection pending row ────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    // The day GM first closes above its rim, fired_status is still NULL — the board
    // flag is written AFTER the send. Under the narrow scope this was suppressed and
    // came back the next evening as "LATE ENTRY — OFF-parity".
    const firstDetection = boardRow("GM", { section: "pending", firedStatus: null });
    const trade = buildAlertScope([], [firstDetection]);
    check("parity: a first-detection pending row is NOT in the trade scope", !trade.has("GM"));
    const board = buildBoardScope(trade, [{ ticker: "GM" }]);
    check("parity: …but IS in the board scope", board.has("GM"));
    const onParity = evalEntryConfirmed({
      ticker: "GM", fireClose: 92.5, breakout: 91.5, fireBarIndex: 4, handleLowDate: HLD,
      fireDate: ET, etDate: ET, sessionsAgo: 0, stop: 86, target: 105,
      tier: "Q5", pRank: 3, sizeBucket: "full", resolved: null,
    });
    const fired = await fireOnce(onParity, entryMarkerKey("GM", HLD), board);
    check("parity: ENTRY CONFIRMED fires the SAME evening", fired === true && sent.length === 1);
    check("parity: …on-parity, not downgraded to LATE ENTRY", sent[0].includes("ENTRY CONFIRMED") && sent[0].includes("buy next session's OPEN") && !sent[0].includes("OFF-parity"));
    // The stale guard is untouched for this family.
    const stale = await fireOnce(onParity, entryMarkerKey("GONE", HLD), buildBoardScope(new Set(), []));
    check("parity: an off-board ticker is still suppressed", stale === false && sent.length === 1);
  }

  // ── EARNINGS RESTORE: pending advisories fire again ──────────────────────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const trade = buildAlertScope([{ ticker: "HELD" }], []);
    const board = buildBoardScope(trade, [{ ticker: "GM" }]);
    const held = await fireAlert(evalEarnings("HELD", "2026-08-21", 2)!, ET, board);
    const pend = await fireAlert(evalEarnings("GM", "2026-08-21", 2)!, ET, board);
    const gone = await fireAlert(evalEarnings("NOW", "2026-08-21", 2)!, ET, board);
    check("earnings: a HELD ticker still alerts", held === true);
    check("earnings: a PENDING ticker alerts again (Fix 1 had killed it)", pend === true);
    check("earnings: an off-board ticker stays suppressed", gone === false && sent.length === 2);
    check("earnings: pending would still be blocked by the narrow scope", (await fireAlert(evalEarnings("GM", "2026-08-21", 2)!, ET, trade)) === false);
  }

  setAlertTransport(null); // restore the real Redis + Telegram transport
}

asyncTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
