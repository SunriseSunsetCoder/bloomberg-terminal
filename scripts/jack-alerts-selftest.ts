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
  // Fix 3 — pending→live promotion
  buildBoardScope,
  evalPromotion,
  promotionMarkerKey,
  evaluatePendingPromotions,
  evalEntryConfirmed,
} from "@/lib/jack/alerts";
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
  // FIX 3 — PENDING → LIVE PROMOTION (close-confirmed, EOD-only, once per setup)
  //
  // Plus the two things the widened lane repairs: the on-parity entry confirmation
  // and the pending earnings advisory, both of which Fix 1 had suppressed.
  // ==========================================================================

  // A pending row as getPendingSetups() returns it (only the fields these passes read).
  const pendingRow = (ticker: string, over: Record<string, unknown> = {}) => ({
    ticker,
    handleLowDate: HLD,
    entry: 91.94, // GM's entry — the case that motivated this
    stop: 86,
    sizeBucket: "full",
    tier: "Q5",
    ...over,
  });
  const barsWith = (close: number, over: Partial<{ high: number; low: number }> = {}) => [
    { date: "2026-08-18", open: 88, high: 89, low: 87, close: 88, volume: 1e6 },
    { date: ET, open: 90, high: over.high ?? Math.max(close, 92), low: over.low ?? 89, close, volume: 1e6 },
  ];

  // ── scope: the third state ────────────────────────────────────────────────
  {
    const trade = buildAlertScope([{ ticker: "HELD" }], [boardRow("LIVEA")]);
    const board = buildBoardScope(trade, [{ ticker: "GM" }, { ticker: "PENDB" }]);
    check("boardScope keeps everything in the trade scope", board.has("HELD") && board.has("LIVEA"));
    check("boardScope ADDS pending tickers", board.has("GM") && board.has("PENDB"));
    check("…and the narrow trade scope still excludes them", !trade.has("GM"));
    check("neither scope admits a ticker that LEFT the board (NOW)", !board.has("NOW") && !trade.has("NOW"));
  }

  // ── 10. pending, daily close >= entry → promotion fires once ──────────────
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "GM" }]);
    const stats = newEmitStats();
    const res = await evaluatePendingPromotions([pendingRow("GM")], board, async () => ({ bars: barsWith(92.1) }), stats);
    check("10. promotion fires on a close at/above entry", res.fired === 1 && sent.length === 1);
    check("10. …as a SYSTEM signal, not a heads-up", sent[0].includes("PROMOTED") && !sent[0].includes("not a system signal"));
    check("10. …naming the close, the entry, and what to do", sent[0].includes("92.10") && sent[0].includes("91.94") && sent[0].includes("tradeable from the next open"));
    check("10. …keyed in the entry_trigger namespace, per setup", store.has(promotionMarkerKey("GM", HLD)) && promotionMarkerKey("GM", HLD) === `jack:alert:entry_trigger:GM:${HLD}`);
    const again = await evaluatePendingPromotions([pendingRow("GM")], board, async () => ({ bars: barsWith(92.1) }), stats);
    check("10. …and only once", again.fired === 0 && sent.length === 1);
    check("10. a close exactly AT entry counts", evalPromotion("GM", 91.94, 91.94) !== null);
  }

  // ── 11. intraday high >= entry but close < entry → SILENT ─────────────────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "POKE" }]);
    // High 93.20 pierced entry 91.94 during the session; the close gave it back.
    const res = await evaluatePendingPromotions(
      [pendingRow("POKE")],
      board,
      async () => ({ bars: barsWith(91.2, { high: 93.2 }) }),
      newEmitStats()
    );
    check("11. an intraday poke above entry does NOT promote", res.fired === 0 && sent.length === 0);
    check("11. evalPromotion is close-only, never a high", evalPromotion("POKE", 91.2, 91.94) === null);
    check("11. …this is the opposite convention from a TP/SL touch", detectTouch({ dayHigh: 93.2, dayLow: 89, stop: 86, target: 110 }) === null && evalPromotion("POKE", 92.5, 91.94) !== null);
  }

  // ── 12. promoted, then the ticker legitimately shows up LIVE → no dup ─────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const stats = newEmitStats();
    const asPending = buildBoardScope(buildAlertScope([], []), [{ ticker: "GM" }]);
    await evaluatePendingPromotions([pendingRow("GM")], asPending, async () => ({ bars: barsWith(92.1) }), stats);
    check("12. promotion fired on the pending run", sent.length === 1);
    // Next run: the setup is now in the LIVE display group (fired-promoted).
    const asLive = buildAlertScope([], [boardRow("GM", { section: "pending", firedStatus: "confirmed" })]);
    check("12. …and the ticker is now in the LIVE scope", asLive.has("GM"));
    const dup = await evaluatePendingPromotions([pendingRow("GM")], buildBoardScope(asLive, []), async () => ({ bars: barsWith(93.0) }), stats);
    check("12. no repeat 'it's live' ping", dup.fired === 0 && sent.length === 1);
    check("12. the marker is lifetime-exempt from the Fix-1 purge", isLifetimeMarker(promotionMarkerKey("GM", HLD)));
  }

  // ── 13. pending dies below its stop pre-promotion → SILENT ───────────────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "DRIFT" }]);
    // Closes 85.10, below the 86 stop; it never once closed above entry.
    const res = await evaluatePendingPromotions(
      [pendingRow("DRIFT")],
      board,
      async () => ({ bars: barsWith(85.1, { low: 84.5 }) }),
      newEmitStats()
    );
    check("13. a pending setup dying pre-promotion is a NON-EVENT", res.fired === 0 && sent.length === 0);
    check("13. …no setup_invalidated either (that is for promoted LIVE rows)", !sent.some((s) => s.includes("SETUP INVALIDATED")));
  }

  // ── 14. not on the board at all → the NOW guard still holds ──────────────
  {
    const { t, store, sent } = memTransport();
    setAlertTransport(t);
    // NOW is in NEITHER scope — it left the board entirely.
    const board = buildBoardScope(buildAlertScope([{ ticker: "HELD" }], [boardRow("SPY")]), [{ ticker: "GM" }]);
    const stats = newEmitStats();
    const res = await evaluatePendingPromotions([pendingRow("NOW")], board, async () => ({ bars: barsWith(92.1) }), stats);
    check("14. the promotion path suppresses an off-board ticker", res.fired === 0 && sent.length === 0);
    check("14. …counted as a stale suppression", stats.suppressedOutOfScope === 1);
    check("14. …and its lifetime marker is not purged", !store.has(promotionMarkerKey("NOW", HLD)));
    check("14. the SAME pass fires for an on-board pending ticker", (await evaluatePendingPromotions([pendingRow("GM")], board, async () => ({ bars: barsWith(92.1) }), stats)).fired === 1);
  }

  // ── promotion: bar selection + the tradeable gate ─────────────────────────
  {
    const { t, sent } = memTransport();
    setAlertTransport(t);
    const board = buildBoardScope(buildAlertScope([], []), [{ ticker: "LAG" }, { ticker: "SKIPPY" }]);
    // MOST-RECENT bar, not today's: at 18:00 ET Tiingo may not have published today yet.
    const stale = await evaluatePendingPromotions(
      [pendingRow("LAG")],
      board,
      async () => ({ bars: [{ date: "2026-08-18", open: 90, high: 93, low: 89, close: 92.5, volume: 1e6 }] }),
      newEmitStats()
    );
    check("promotion reads the latest bar even if today's isn't published", stale.fired === 1);
    // Q1/Q2 never gets entered, so it must never be announced as tradeable.
    const skip = await evaluatePendingPromotions(
      [pendingRow("SKIPPY", { tier: "Q2", sizeBucket: "skip" })],
      board,
      async () => ({ bars: barsWith(92.1) }),
      newEmitStats()
    );
    check("a SKIP-bucket setup is never promoted", skip.fired === 0 && skip.skippedNotTradeable === 1);
    check("a pending row with no entry level is skipped", (await evaluatePendingPromotions([pendingRow("NOENTRY", { entry: null })], board, async () => ({ bars: barsWith(92.1) }), newEmitStats())).fired === 0);
    check("a bars-fetch failure is counted, not thrown", (await evaluatePendingPromotions([pendingRow("BAD")], buildBoardScope(new Set(), [{ ticker: "BAD" }]), async () => ({ bars: [], error: "HTTP 500" }), newEmitStats())).fetchFailures === 1);
    check("only the promotion messages were sent", sent.every((s) => s.includes("PROMOTED")));
  }

  // ── the dormant intraday entry_trigger vs the live promotion ─────────────
  {
    const dormant = evalEntryTrigger("GM", 91.0, 92.5, 91.94)!;
    const promo = evalPromotion("GM", 92.5, 91.94)!;
    check("both carry the entry_trigger type (shared namespace)", dormant.type === "entry_trigger" && promo.type === "entry_trigger");
    check("…but only the promotion is a SYSTEM signal", promo.kind === "system" && dormant.kind === "heads-up");
    check("…and the dormant one reads the RIM intraday, not the close", dormant.text.includes("crossed breakout") && promo.text.includes("≥ entry"));
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
