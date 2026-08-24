// =============================================================================
// JACK alerts — read-only observers riding on the price-refresh passes. TWO tiers:
//   · HEADS-UP (intraday monitor, every ~30m in market hours) — informational,
//     ALWAYS labeled "not a system signal".
//   · SYSTEM (EOD pass, close-based) — the mechanical signals + once-a-day checks.
// Plus OPERATIONAL health alerts. Every signal fires at most once per ticker per
// type per ET-day via a Redis marker. NOTHING here changes strategy/sizing/selection
// or the EOD outcome logic — alerts only observe.
//
// Pure evaluators + message builders + tradingDaysUntil are unit-tested; the
// orchestration (DB reads + Telegram + Redis) is exercised by the live selftests.
// =============================================================================
import { redis } from "@/lib/redis";
import { isTradingDay, isMarketOpen, etDateISO } from "./market-hours";
import { computeDaysHeld } from "./position-mgmt";
// The SHARED fire rule + the SAME daily-bar source the paper replay uses. The entry
// alert must never re-derive either one — that is the parity mandate.
import { detectFire, findTouchExit, fetchDailyBars, CONFIRM_WINDOW_BARS, type Bar } from "./outcome-tracker";
import { PRICES_KEY, type IexQuote, type StoredPrices } from "./price-refresh";
import { sendTelegram, alertsEnabled } from "./telegram";
import { fetchEarningsMap, earningsEnabled } from "./finnhub";
// The frozen size map decides what is tradeable — a SKIP setup is never entered, so it
// must never produce an actionable entry signal.
import { isTradeableSetup } from "./handle-score";
// Recovery re-entry gate — pure, shares detectFire with the paper replay.
import { evalSecondChance, RETEST_WINDOW_BARS, RUNUP_FRAC } from "./second-chance";
// The board's LIVE-group rule, so the candidate pool matches what the board shows.
import { isInLiveDisplayGroup, isOwnedPosition } from "./combine-decisions";
// THE alert scope's live half is the Basket Sizer's own feed — not a re-derivation.
// selectBasketCandidates = in the LIVE display group ∧ tradeable ∧ not owned ∧ not
// retired, which is exactly what app/api/jack-basket/route.ts sizes.
import { selectBasketCandidates, type BasketEligibleInput } from "./basket";
// THE promotion predicate — one rule, consumed by the board writer AND the alert.
import { isPromotedToLive } from "./promotion";

// ---- Thresholds (named constants; the only knobs) --------------------------
export const APPROACH_PCT = 0.03; // NOW within 3% of stop/target
export const BIG_MOVE_PCT = 0.07; // |NOW vs prevClose| >= 7%
export const TIME_STOP_DAYS_LEFT = 10; // fire when <= 10 days of the window remain
export const EARNINGS_WITHIN_TRADING_DAYS = 5; // report within 5 trading days
const TIME_STOP_TOTAL_DAYS = 120; // strategy time stop (calendar-day approximation)
const TIME_STOP_TRIGGER_DAYS = TIME_STOP_TOTAL_DAYS - TIME_STOP_DAYS_LEFT; // 110

const HEADS_UP_FOOTER = "heads-up · intraday · not a system signal";
// The deliberate opposite of HEADS_UP_FOOTER: this one IS actionable. Used by the
// close-confirmed entry alert so the operator can tell the two apart at a glance.
const SYSTEM_FOOTER = "SYSTEM SIGNAL · close-confirmed · backtest parity";

export type AlertType =
  | "approach_stop"
  | "approach_target"
  | "big_move"
  | "entry_trigger"
  | "stop_hit"
  | "target_hit"
  | "time_stop"
  | "earnings"
  // EOD close-confirmed entry (backtest parity). Deduped ONCE PER SETUP, not per day
  // — see entryMarkerKey. `late_entry` is the same event surfaced after the fact;
  // `entry_resolved` is a late fire whose trade has ALREADY played out (stop or
  // target touched), so it is reported but must never say "buy".
  | "entry_confirmed"
  | "late_entry"
  | "entry_resolved"
  // Recovery re-entry on a setup that fired, was never taken, and has pulled back to
  // its original entry while still live. SYSTEM tier — backtested, not a heads-up.
  | "second_chance"
  // INTRADAY/EOD TOUCH on a LIVE, NOT-OWNED setup. Deliberately distinct types from
  // target_hit/stop_hit: reaching t05 with no entry taken is NOT a win, and a stop
  // taken before entry is NOT a loss — they are "nothing was enterable" information.
  | "ran_to_target"
  | "setup_invalidated";

/**
 * The four TERMINAL hit semantics, each with its OWN Redis namespace. Never share a
 * key across two of these: the not-owned→owned transition and the fill-lag case both
 * depend on `ran_to_target` and `target_hit` being able to fire independently for the
 * same setup (both stories told, honestly — see hitMarkerKey).
 */
export type HitKind = "target_hit" | "stop_hit" | "ran_to_target" | "setup_invalidated";

export type HealthFailure =
  | "intraday_refresh"
  | "eod_refresh"
  | "iex_batch"
  | "finnhub_fetch"
  | "entry_bars_fetch"
  | "second_chance_bars_fetch";

export interface Alert {
  type: AlertType;
  ticker: string;
  kind: "heads-up" | "system";
  text: string;
}

// ---- formatting ------------------------------------------------------------
const p2 = (n: number) => n.toFixed(2);
const pct1 = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const T = (t: string) => t.toUpperCase();
const mk = (type: AlertType, kind: Alert["kind"], ticker: string, text: string): Alert => ({
  type,
  ticker: T(ticker),
  kind,
  text,
});

// ============================================================
// HEADS-UP evaluators (intraday) — `now` is tngoLast (the live print). Callers must
// suppress these when tngoLast is null (no fabricated alert off a stale close).
// ============================================================

/** NOW within APPROACH_PCT ABOVE stop (still above it — at/below stop is the EOD domain). */
export function evalApproachStop(ticker: string, now: number | null, stop: number | null): Alert | null {
  if (now == null || stop == null || stop <= 0) return null;
  if (now <= stop) return null; // hit → close-based system signal, not a heads-up
  if (now > stop * (1 + APPROACH_PCT)) return null;
  const deltaPct = ((now - stop) / stop) * 100;
  return mk(
    "approach_stop",
    "heads-up",
    ticker,
    `⚠️ HEADS-UP · ${T(ticker)} approaching STOP\nNOW ${p2(now)}  ·  stop ${p2(stop)}  (${pct1(deltaPct)})\n${HEADS_UP_FOOTER}`
  );
}

/** NOW within APPROACH_PCT BELOW target (still below it). */
export function evalApproachTarget(ticker: string, now: number | null, target: number | null): Alert | null {
  if (now == null || target == null || target <= 0) return null;
  if (now >= target) return null; // hit → close-based system signal
  if (now < target * (1 - APPROACH_PCT)) return null;
  const deltaPct = ((now - target) / target) * 100; // negative
  return mk(
    "approach_target",
    "heads-up",
    ticker,
    `⚠️ HEADS-UP · ${T(ticker)} approaching TARGET\nNOW ${p2(now)}  ·  target ${p2(target)}  (${pct1(deltaPct)})\n${HEADS_UP_FOOTER}`
  );
}

/** |NOW vs prevClose| >= BIG_MOVE_PCT. */
export function evalBigMove(ticker: string, now: number | null, prevClose: number | null): Alert | null {
  if (now == null || prevClose == null || prevClose <= 0) return null;
  const movePct = ((now - prevClose) / prevClose) * 100;
  if (Math.abs(movePct) < BIG_MOVE_PCT * 100) return null;
  return mk(
    "big_move",
    "heads-up",
    ticker,
    `⚠️ HEADS-UP · ${T(ticker)} big move ${pct1(movePct)}\nNOW ${p2(now)}  ·  prev close ${p2(prevClose)}\n${HEADS_UP_FOOTER}`
  );
}

/**
 * DORMANT (2026-08-07) — nothing calls this. Intraday alerts are owned-positions-only;
 * the entry signal comes solely from the EOD close-confirmed pass. Kept, exported and
 * unit-tested, so the intraday entry heads-up can be switched back on without being
 * rebuilt. Re-enabling means adding a pending loop back to evaluateIntradayAlerts.
 *
 * Same-day CROSS only: prevClose < level AND tngoLast >= level (not a standing "already above").
 *
 * ⚠️ SHARES THE "entry_trigger" AlertType WITH evalPromotion (below), which is the LIVE
 * one. They are opposites and must never both be wired up:
 *      this  — INTRADAY cross of the BREAKOUT rim, heads-up tier, dormant
 *   evalPromotion — EOD CLOSE at/above ENTRY, system tier, the pending→live promotion
 * The type string is shared because the promotion's Redis namespace is specified as
 * `jack:alert:entry_trigger:{TICKER}:{handle_low_date}`. If this heads-up is ever
 * re-enabled, give it its own type first — an intraday poke must never consume the
 * promotion's once-per-setup marker.
 */
export function evalEntryTrigger(
  ticker: string,
  prevClose: number | null,
  tngoLast: number | null,
  level: number | null
): Alert | null {
  if (prevClose == null || tngoLast == null || level == null) return null;
  if (!(prevClose < level && tngoLast >= level)) return null;
  return mk(
    "entry_trigger",
    "heads-up",
    ticker,
    `⚠️ HEADS-UP · ${T(ticker)} entry trigger hit (pending)\nNOW ${p2(tngoLast)} crossed breakout ${p2(level)}\n${HEADS_UP_FOOTER}`
  );
}

// ============================================================
// SYSTEM evaluators (EOD, close-based)
// ============================================================

export function evalStopHit(ticker: string, close: number | null, stop: number | null): Alert | null {
  if (close == null || stop == null) return null;
  if (close > stop) return null;
  return mk(
    "stop_hit",
    "system",
    ticker,
    `🔴 SYSTEM · ${T(ticker)} stop hit\nclose ${p2(close)} ≤ stop ${p2(stop)}  ·  exit per rules`
  );
}

export function evalTargetHit(ticker: string, close: number | null, target: number | null): Alert | null {
  if (close == null || target == null) return null;
  if (close < target) return null;
  return mk(
    "target_hit",
    "system",
    ticker,
    `🟢 SYSTEM · ${T(ticker)} target hit\nclose ${p2(close)} ≥ target ${p2(target)}`
  );
}

/**
 * PENDING → LIVE PROMOTION message (Fix 3, re-based onto the rim predicate).
 *
 * The CONDITION is not decided here — isPromotedToLive owns it (strict CLOSE > rim,
 * inside the 15-bar confirm window). This is the message builder only, so the alert and
 * the board writer are two consequences of ONE evaluation and cannot diverge.
 *
 * Re-based deliberately: the original Fix 3 condition was `close >= entry` with no
 * window, which is looser than the board's rule in both dimensions and is the class of
 * comparison that announced a breakout on a sub-rim close.
 *
 * CLOSE-CONFIRMED, EOD ONLY — the deliberate opposite convention from the TP/SL touch
 * above: a hit IS a touch event, whereas an entry only ever counts on a close (the
 * strategy's fill is the next open AFTER a daily close through the rim). Price may
 * cross intraday any number of times; every one of those is silent.
 *
 * SYSTEM tier, not heads-up: actionable and on-convention, so no "not a signal" footer.
 */
export function evalPromotionAlert(args: {
  ticker: string;
  fireClose: number;
  rim: number;
  fireBar: number;
  handleLowDate: string;
  /** Fired on an earlier bar in the window, not today. */
  late: boolean;
  /** Conviction quintile Q3/Q4/Q5 — only ever these, per isTradeableSetup. */
  tier?: string | null;
  /** FULL / HALF sizing directive. */
  sizeBucket?: string | null;
}): Alert {
  // Conviction line, same shape ENTRY CONFIRMED uses, so the two alerts about the
  // same setup read alike. "It went live" without the tier forced a board lookup to
  // answer the only question that follows: how big?
  const meta = [
    args.tier ? args.tier.toUpperCase() : null,
    args.sizeBucket ? `size ${args.sizeBucket.toUpperCase()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return mk(
    "entry_trigger",
    "system",
    args.ticker,
    `🚀 PROMOTED — ${T(args.ticker)} is now LIVE\n` +
      `Close ${p2(args.fireClose)} > rim ${p2(args.rim)}  (bar ${args.fireBar}/${CONFIRM_WINDOW_BARS} since handle low ${args.handleLowDate})\n` +
      (args.late
        ? `Fired earlier in the window — entering now is OFF-parity vs the backtest\n`
        : `The setup is tradeable from the next open\n`) +
      (meta ? `${meta}\n` : "") +
      `close-confirmed · pending → live`
  );
}

/**
 * ONCE-PER-SETUP promotion marker. Setup identity, no ET date, no TTL — a setup is
 * promoted once in its life, and the marker is what stops a repeat "it's live" ping on
 * every later run once the ticker legitimately shows up in the live group.
 */
export function promotionMarkerKey(ticker: string, handleLowDate: string): string {
  return `jack:alert:entry_trigger:${T(ticker.trim())}:${handleLowDate.trim()}`;
}

// ============================================================
// FIX 2 — TP/SL *TOUCH* DETECTION (intraday IEX range · EOD consolidated daily bar)
//
// The close-based evaluators above answer "did it END past the level". They cannot see
// a level that was TOUCHED and given back before the close — which is the whole bug:
// a live position reached take-profit intraday and nothing fired, because
// evalApproachTarget bails at the hit and evalTargetHit needs a close.
//
// Touch is evaluated from a session RANGE: the running IEX day high/low intraday, the
// consolidated daily bar at EOD. Same rule for both, so the EOD pass is a strict
// backstop on the intraday one rather than a second opinion.
// ============================================================

/** Which level a session range touched. STOP-FIRST on a tie — see detectTouch. */
export type TouchKind = "stop" | "target";

/**
 * Did this session's range touch the stop or the target?
 *
 * STOP-FIRST ON A TIE, matching the backtest's exit convention. A cumulative day
 * high/low cannot order two events inside the same session, so this is a WHOLE-DAY
 * rule: a day that ran to target and later broke the stop reports the STOP.
 * Deliberately conservative — the alternative silently books wins that were given back.
 */
export function detectTouch(args: {
  dayHigh: number | null;
  dayLow: number | null;
  stop: number | null;
  target: number | null;
}): TouchKind | null {
  const { dayHigh, dayLow, stop, target } = args;
  if (dayLow != null && stop != null && dayLow <= stop) return "stop";
  if (dayHigh != null && target != null && dayHigh >= target) return "target";
  return null;
}

/** The four (owned × touch) semantics. Owned and un-entered are NEVER the same story. */
export function hitKindFor(owned: boolean, touch: TouchKind): HitKind {
  if (owned) return touch === "stop" ? "stop_hit" : "target_hit";
  return touch === "stop" ? "setup_invalidated" : "ran_to_target";
}

/**
 * Build the alert for a touch. Labels are fixed by spec and carry DISTINCT semantics:
 * an un-entered runner that reached t05 is NOT a win (nothing was enterable), and a
 * stop taken before entry is NOT a loss.
 */
export function evalTouchAlert(args: {
  ticker: string;
  owned: boolean;
  touch: TouchKind;
  stop: number | null;
  target: number | null;
  /** intraday = provisional (live IEX); eod = confirmed (consolidated daily bar). */
  source: "intraday" | "eod";
}): Alert {
  const kind = hitKindFor(args.owned, args.touch);
  const tag = args.source === "intraday" ? "[intraday touch]" : "[daily bar]";
  const t05 = args.target != null ? p2(args.target) : "—";
  const stop = args.stop != null ? p2(args.stop) : "—";

  const head =
    kind === "target_hit"
      ? `🎯 TARGET HIT — ${T(args.ticker)} reached t05 (${t05}) ${tag}`
      : kind === "stop_hit"
        ? `🛑 STOP HIT — ${T(args.ticker)} hit stop (${stop}) ${tag}`
        : kind === "ran_to_target"
          ? `⚠️ RAN TO TARGET UN-ENTERED — ${T(args.ticker)} reached t05 (${t05}) but no breakout entry was taken`
          : `❌ SETUP INVALIDATED — ${T(args.ticker)} stop (${stop}) taken before entry`;

  const body =
    kind === "ran_to_target"
      ? `Don't chase — the move happened without an enterable entry.`
      : kind === "setup_invalidated"
        ? `The setup is dead pre-entry; no position was at risk.`
        : `exit per rules`;

  const footer =
    args.source === "intraday"
      ? "provisional · live IEX range · reconciled against the daily bar at the close"
      : "confirmed · consolidated daily bar";

  return mk(kind, "system", args.ticker, `${head}\n${body}\n${footer}`);
}

/**
 * The session range to judge a quote by, with the RTH gate.
 *
 * · RTH 09:30–16:00 ET. IEX quotes can carry extended-hours prints, and a thin
 *   pre/post spike would fake a touch that never happened in the regular session.
 * · Missing timestamp → FAIL OPEN (accept) and LOG. A silently self-disabling gate
 *   that swallows every touch is far worse than a rare ext-hours print; the log line
 *   is what makes the degradation visible.
 * · Missing high/low → fall back to the last print, so a quote without a range can
 *   still report a touch at the level it is trading through.
 */
export function quoteTouchRange(
  q: { ticker: string; tngoLast: number | null; last: number | null; dayHigh: number | null; dayLow: number | null; timestamp: string | null },
  isOpenFn: (d: Date) => boolean = isMarketOpen
): { high: number | null; low: number | null; rejected: "ext_hours" | null } {
  if (q.timestamp == null) {
    console.log(`JACK touch: ${T(q.ticker)} quote has no timestamp — RTH gate failing OPEN for this quote`);
  } else {
    const d = new Date(q.timestamp);
    if (Number.isNaN(d.getTime())) {
      console.log(`JACK touch: ${T(q.ticker)} quote timestamp unparseable (${q.timestamp}) — RTH gate failing OPEN`);
    } else if (!isOpenFn(d)) {
      return { high: null, low: null, rejected: "ext_hours" };
    }
  }
  const fallback = q.tngoLast ?? q.last;
  return { high: q.dayHigh ?? fallback, low: q.dayLow ?? fallback, rejected: null };
}

/** Fire when held >= TIME_STOP_TRIGGER_DAYS (~110) CALENDAR days of the 120-day window. */
export function evalTimeStop(ticker: string, daysHeld: number | null): Alert | null {
  if (daysHeld == null || daysHeld < TIME_STOP_TRIGGER_DAYS) return null;
  return mk(
    "time_stop",
    "system",
    ticker,
    `⏰ SYSTEM · ${T(ticker)} time-stop approaching\nheld ~${daysHeld}d of ${TIME_STOP_TOTAL_DAYS}  ·  review for exit`
  );
}

/**
 * EOD CLOSE-CONFIRMED ENTRY — the one entry signal that is on backtest parity.
 *
 * The fire itself is decided by the SHARED detectFire (lib/jack/outcome-tracker.ts),
 * never re-derived here. This function only renders the message, so it stays pure and
 * testable. Two variants:
 *   · fireDate === today → ENTRY CONFIRMED, buy the next session's open (on-parity)
 *   · fireDate <  today  → LATE ENTRY, honestly labeled OFF-parity, fired once so the
 *     missed entry is surfaced rather than silently dropped
 *
 * Explicitly a SYSTEM signal — the opposite of the intraday entry-trigger's
 * "not a system signal" footer.
 */
export function evalEntryConfirmed(args: {
  ticker: string;
  fireClose: number;
  breakout: number;
  fireBarIndex: number;
  handleLowDate: string;
  fireDate: string;
  etDate: string;
  sessionsAgo: number;
  stop: number | null;
  target: number | null;
  tier: string | null;
  /** P-RANK ORDINAL from getPriorityRanks — the same number the board renders as Pn.
   *  Never the raw scanner priority float. null → the field is omitted. */
  pRank: number | null;
  sizeBucket: string | null;
  /** Set only for a LATE fire whose trade already hit stop or target (findTouchExit). */
  resolved?: { kind: "stop" | "target"; date: string } | null;
}): Alert {
  const late = args.fireDate < args.etDate;
  // A same-day fire cannot have resolved — the fill is the NEXT session's open, which
  // hasn't happened yet. Guard so a caller mistake can't produce a nonsense alert.
  const resolved = late ? args.resolved ?? null : null;

  // Scanner classification line, using the frozen board convention: Pn ordinal.
  const meta = [
    args.tier ? args.tier.toUpperCase() : null,
    args.pRank != null ? `P${args.pRank}` : null,
    args.stop != null ? `stop ${p2(args.stop)}` : null,
    args.target != null ? `t05 ${p2(args.target)}` : null,
    args.sizeBucket ? `size ${args.sizeBucket.toUpperCase()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const sessions = `${args.sessionsAgo} session${args.sessionsAgo === 1 ? "" : "s"} ago`;

  const head = resolved
    ? `🚫 ALREADY RESOLVED — ${T(args.ticker)}  (${resolved.kind} hit ${resolved.date})`
    : late
      ? `⚠️ LATE ENTRY — ${T(args.ticker)}  (fired ${args.fireDate}, ${sessions} — OFF-parity)`
      : `✅ ENTRY CONFIRMED — ${T(args.ticker)}`;

  const action = resolved
    ? `NO ACTION: fired ${args.fireDate} and already ${resolved.kind === "stop" ? "stopped out" : "reached target"} on ${resolved.date} — do NOT enter`
    : late
      ? `ACTION: entering now is OFF-parity vs the backtest (fill was the open after ${args.fireDate})`
      : `ACTION: buy next session's OPEN  (backtest fill)`;

  const text =
    `${head}\n` +
    `Close ${p2(args.fireClose)} > rim ${p2(args.breakout)}  (bar ${args.fireBarIndex}/${CONFIRM_WINDOW_BARS} since handle low ${args.handleLowDate})\n` +
    `${action}\n` +
    (meta ? `${meta}\n` : "") +
    SYSTEM_FOOTER;

  const type: AlertType = resolved ? "entry_resolved" : late ? "late_entry" : "entry_confirmed";
  return mk(type, "system", args.ticker, text);
}

/** Advisory (not a mechanical exit): earnings within EARNINGS_WITHIN_TRADING_DAYS trading days. */
export function evalEarnings(ticker: string, dateISO: string, tradingDaysUntilDate: number | null): Alert | null {
  if (tradingDaysUntilDate == null || tradingDaysUntilDate > EARNINGS_WITHIN_TRADING_DAYS) return null;
  return mk(
    "earnings",
    "system",
    ticker,
    `📅 SYSTEM · ${T(ticker)} earnings within ${EARNINGS_WITHIN_TRADING_DAYS} trading days\nreports ${dateISO}  ·  consider risk into the print (advisory, not a mechanical exit)`
  );
}

// ============================================================
// Trading-day counting (skips weekends + NYSE holidays via market-hours)
// ============================================================

const stepISO = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Noon-ET Date for a YYYY-MM-DD so isTradingDay resolves that exact ET calendar day. */
const isTradingDayISO = (iso: string): boolean => isTradingDay(new Date(`${iso}T16:00:00Z`));

/**
 * Trading days strictly AFTER `fromISO` up to and including `toISO`. Same-day or past
 * → 0 (imminent). `isTradingDayFn` is injectable for deterministic tests.
 */
export function tradingDaysUntil(
  fromISO: string,
  toISO: string,
  isTradingDayFn: (iso: string) => boolean = isTradingDayISO
): number {
  const from = fromISO.slice(0, 10);
  const to = toISO.slice(0, 10);
  if (to <= from) return 0;
  let count = 0;
  let cur = from;
  // hard cap the walk so a bad date can never loop unbounded
  for (let i = 0; i < 400 && cur < to; i++) {
    cur = stepISO(cur);
    if (isTradingDayFn(cur)) count++;
  }
  return count;
}

/**
 * Add n TRADING days to a YYYY-MM-DD, skipping weekends + NYSE holidays. Used for the
 * resting limit's cancel-by date, so the operator's GTC order expires exactly when the
 * backtested window closes rather than n calendar days later.
 */
export function addTradingDaysISO(
  iso: string,
  n: number,
  isTradingDayFn: (iso: string) => boolean = isTradingDayISO
): string {
  let cur = iso.slice(0, 10);
  let added = 0;
  for (let i = 0; i < 400 && added < n; i++) {
    cur = stepISO(cur);
    if (isTradingDayFn(cur)) added++;
  }
  return cur;
}

/** Add n calendar days to a YYYY-MM-DD (for the Finnhub window end). */
export function addCalendarDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// Redis dedup — one send per (type, ticker, ET-day); health per (failure, day).
// Key embeds the ET date, so markers auto-re-arm the next day (EX is just cleanup).
// ============================================================
export function alertMarkerKey(type: AlertType, ticker: string, etDate: string): string {
  return `jack:alert:${type}:${T(ticker)}:${etDate}`;
}
export function healthMarkerKey(failure: HealthFailure, etDate: string): string {
  return `jack:alert:health:${failure}:${etDate}`;
}

/**
 * ONCE-PER-SETUP marker for the close-confirmed entry — deliberately NOT ET-date
 * scoped like alertMarkerKey. A breakout confirmation is a one-time lifetime event
 * per setup, so the key is setup identity (ticker + handle_low_date) and carries NO
 * TTL: the alert fires exactly once, ever, for that setup.
 *
 * Ticker/date normalization matches the ingest + backfill helpers (uppercase, trimmed
 * ticker; ISO date as stored on the setups row).
 */
export function entryMarkerKey(ticker: string, handleLowDate: string): string {
  return `jack:alert:entry_confirmed:${T(ticker.trim())}:${handleLowDate.trim()}`;
}

/**
 * ONCE-PER-SETUP marker for the recovery re-entry. Same shape and discipline as
 * entryMarkerKey: setup identity, no ET date, no TTL. A setup ARMS once — max-high-
 * since-entry crosses the run-up threshold a single time and stays crossed — so this
 * naturally maps to one ping per setup for its lifetime.
 */
export function secondChanceMarkerKey(ticker: string, handleLowDate: string): string {
  return `jack:alert:second_chance:${T(ticker.trim())}:${handleLowDate.trim()}`;
}

/**
 * ONE TERMINAL MARKER PER (SEMANTICS, SETUP) — no ET date, no TTL.
 *
 * A hit is a TERMINAL EVENT, not an ongoing condition: it fires once, ever, per setup.
 * (The old per-ET-day cadence is right for the APPROACH alerts — "you are near" is a
 * persistent state that should re-arm daily — and wrong for a hit, which would then
 * re-fire every day price sat below the stop.)
 *
 * The intraday touch and the EOD close/daily-bar backstop share THIS key, which is what
 * makes the EOD pass idempotent against an intraday fire.
 */
export function hitMarkerKey(kind: HitKind, ticker: string, handleLowDate: string): string {
  return `jack:alert:${kind}:${T(ticker.trim())}:${handleLowDate.trim()}`;
}

/**
 * Markers that must SURVIVE a scope drop (never purged by the Fix-1 sweep).
 *
 * Purging a terminal marker when a ticker falls off the board lets a re-validated setup
 * re-fire a hit it already reported. All four hit namespaces qualify, and so do the two
 * other lifetime markers — entry_confirmed and second_chance are "once per setup, for
 * its lifetime" by the same logic. Everything else is ET-day scoped and self-expires,
 * so purging it only means "may alert again if it returns to the board", which is right.
 */
export function isLifetimeMarker(key: string): boolean {
  return /^jack:alert:(target_hit|stop_hit|ran_to_target|setup_invalidated|entry_confirmed|second_chance|entry_trigger):/.test(
    key
  );
}

// ============================================================
// TRANSPORT SEAM — Redis + Telegram behind one injectable interface.
//
// Production uses the real clients (below). The selftest installs an in-memory
// transport so the whole funnel — scope suppression, purge, dedup, send — is testable
// with no network, no Redis and no Telegram. NOTHING else in this file touches redis
// or sendTelegram directly; that is what makes emitAlert a real chokepoint.
// ============================================================
export interface AlertTransport {
  enabled(): boolean;
  get(key: string): Promise<unknown>;
  set(key: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  send(text: string): Promise<{ ok: boolean }>;
}

const defaultTransport: AlertTransport = {
  enabled: () => alertsEnabled(),
  get: (key) => redis.get(key),
  set: async (key, ttlSeconds) => {
    if (ttlSeconds != null) await redis.set(key, "1", { ex: ttlSeconds });
    else await redis.set(key, "1");
  },
  del: async (key) => {
    await redis.del(key);
  },
  send: (text) => sendTelegram(text),
};

let transport: AlertTransport = defaultTransport;

/** Install a test transport; pass null to restore the real Redis + Telegram one. */
export function setAlertTransport(t: AlertTransport | null): void {
  transport = t ?? defaultTransport;
}

// Err toward SENDING on a Redis read failure (a rare dup beats a missed stop-hit).
async function alreadySent(key: string): Promise<boolean> {
  try {
    return (await transport.get(key)) != null;
  } catch {
    return false;
  }
}
async function markSent(key: string, ttlSeconds?: number): Promise<void> {
  try {
    await transport.set(key, ttlSeconds);
  } catch {
    // non-fatal — worst case the alert can repeat; better than silent Redis coupling
  }
}

// ============================================================
// THE EMISSION CHOKEPOINT
// ============================================================

export interface EmitOptions {
  /** The current-validation in-scope ticker set (buildAlertScope). REQUIRED. */
  scope: Set<string>;
  /** Full Redis dedup key — per-ET-day (alertMarkerKey) or per-setup (hit/entry/second-chance). */
  key: string;
  /** Omitted → no expiry: fires exactly once for the lifetime of the key. */
  ttlSeconds?: number;
}

/** Counters for the per-pass log line — how much staleness was actually suppressed. */
export interface EmitStats {
  sent: number;
  suppressedOutOfScope: number;
  purgedMarkers: number;
  deduped: number;
}
export const newEmitStats = (): EmitStats => ({ sent: 0, suppressedOutOfScope: 0, purgedMarkers: 0, deduped: 0 });

/**
 * THE ONE WAY AN ALERT LEAVES THIS SYSTEM. Every path — approach, big move, entry
 * confirmed/late/resolved, stop/target hit, ran-to-target, setup-invalidated, time
 * stop, earnings, second chance — goes through here.
 *
 * Order matters:
 *   1. SCOPE. Not in the latest validation's board (open ∪ live) → suppressed, full
 *      stop, whatever markers a prior run left behind. This is Fix 1: the guard is
 *      structural, not per-path, so a NEW alert path cannot be added that forgets it —
 *      `scope` is a required argument and there is no other sender.
 *   2. PURGE. A suppressed non-lifetime marker is deleted so it cannot resurrect a
 *      stale dedup state; lifetime markers (hits, entry, second-chance) are exempt —
 *      purging those would let a re-validated setup re-fire a hit it already sent.
 *   3. DEDUP, then send, and mark ONLY on a successful send (a Telegram failure retries
 *      on the next pass instead of silently swallowing the signal).
 *
 * `alertsEnabled()` is checked here too, so a disabled bot can never leave markers.
 */
export async function emitAlert(a: Alert, o: EmitOptions, stats?: EmitStats): Promise<boolean> {
  const ticker = T(a.ticker);
  if (!o.scope.has(ticker)) {
    if (stats) stats.suppressedOutOfScope++;
    console.log(
      `JACK alert SUPPRESSED (stale — ${ticker} not in the latest validation board): ${a.type}`
    );
    if (!isLifetimeMarker(o.key)) {
      try {
        await transport.del(o.key);
        if (stats) stats.purgedMarkers++;
      } catch {
        // non-fatal — the scope guard already stopped the send; the marker can TTL out
      }
    }
    return false;
  }
  if (!transport.enabled()) return false;
  if (await alreadySent(o.key)) {
    if (stats) stats.deduped++;
    return false;
  }
  const res = await transport.send(a.text);
  if (!res.ok) return false;
  await markSent(o.key, o.ttlSeconds);
  if (stats) stats.sent++;
  return true;
}

/**
 * Send one alert deduped PER ET-DAY. Thin wrapper over emitAlert — `scope` is required
 * so this cannot be used to bypass the funnel.
 */
export async function fireAlert(a: Alert, etDate: string, scope: Set<string>, stats?: EmitStats): Promise<boolean> {
  return emitAlert(a, { scope, key: alertMarkerKey(a.type, a.ticker, etDate), ttlSeconds: 36 * 60 * 60 }, stats);
}

/**
 * Send an alert deduped on an EXPLICIT key (per-setup rather than per-day). Same
 * funnel, same discipline; `ttlSeconds` omitted → fires exactly once for the lifetime
 * of the key.
 */
export async function fireOnce(
  a: Alert,
  key: string,
  scope: Set<string>,
  ttlSeconds?: number,
  stats?: EmitStats
): Promise<boolean> {
  return emitAlert(a, { scope, key, ttlSeconds }, stats);
}

/** Clear a marker outright (reconciliation, not emission). Safe if Redis is down. */
export async function purgeMarker(key: string): Promise<void> {
  try {
    await transport.del(key);
  } catch {
    // best-effort
  }
}

const HEALTH_LABEL: Record<HealthFailure, string> = {
  intraday_refresh: "intraday monitor failed",
  eod_refresh: "eod refresh failed",
  iex_batch: "IEX batch unavailable",
  finnhub_fetch: "earnings fetch failed",
  entry_bars_fetch: "entry-alert daily bars fetch failed",
  second_chance_bars_fetch: "second-chance daily bars fetch failed",
};

/**
 * OPERATIONAL health — deliberately OUTSIDE the scope funnel. A health alert has no
 * ticker and must still fire when the board is empty or every ticker is out of scope
 * (that is precisely when the pipeline is broken and you need to hear about it).
 */
export async function fireHealth(failure: HealthFailure, detail: string, etDate: string): Promise<boolean> {
  if (!transport.enabled()) return false;
  const key = healthMarkerKey(failure, etDate);
  if (await alreadySent(key)) return false;
  const text = `🚨 OPS · JACK pipeline issue\n${HEALTH_LABEL[failure]}: ${detail.slice(0, 200)}`;
  const res = await transport.send(text);
  if (res.ok) {
    await markSent(key, 36 * 60 * 60);
    return true;
  }
  return false;
}

// ============================================================
// FIX 1 — THE IN-SCOPE SET (the latest validation's board)
// ============================================================

/** The minimum a row needs to contribute its ticker to the scope. */
export interface ScopeRow extends BasketEligibleInput {
  ticker: string;
}

/**
 * inScope = openTickers ∪ liveTickers — PURE, so the whole guard is unit-testable.
 *
 *   · openTickers — getOpenPositions(): what you actually hold. Deliberately NOT
 *     run-scoped; an open trade stays alertable even when its ticker left the scan.
 *   · liveTickers — selectBasketCandidates() over the CURRENT board (live + pending):
 *     the LIVE display group ∧ tradeable ∧ not owned ∧ not retired. This is the Basket
 *     Sizer's own feed, NOT getPendingSetups() — that one returns section='pending'
 *     rows only, so a validated-LIVE setup never appears in it (the documented feed
 *     bug that also left the Sizer blank while the board showed LIVE).
 *
 * Anything else is stale by construction: it is not in the latest validation.
 */
export function buildAlertScope(open: Array<{ ticker: string }>, boardRows: ScopeRow[]): Set<string> {
  const scope = new Set<string>();
  for (const p of open) scope.add(T(p.ticker));
  for (const r of selectBasketCandidates(boardRows)) scope.add(T(r.ticker));
  return scope;
}

/** The live half alone — the rows (not just tickers) the touch passes iterate. */
export function selectLiveRows<T extends ScopeRow>(boardRows: T[]): T[] {
  return selectBasketCandidates(boardRows);
}

/**
 * THE WIDER SET: everything present in the latest validation — open ∪ live ∪ PENDING.
 *
 * The guard has THREE states, not two:
 *   · not on the board at all        → suppressed (the NOW stale-alert case, unchanged)
 *   · on the board as open/live      → the full alert set, asserted against tradeScope
 *   · on the board as PENDING        → the EOD close-based promotion lane ONLY,
 *                                      asserted against THIS set
 *
 * "Present in the latest validation" is still required, so this does not reopen the
 * stale-alert bug: NOW had LEFT the board, whereas a promoting pending setup is one of
 * the rows the current run is showing — just not in the open∪live subset.
 *
 * Only three emissions may use this set: the promotion alert, the close-confirmed entry
 * family (entry_confirmed / late_entry / entry_resolved — all EOD, all close-based), and
 * the earnings advisory. Everything else keeps asserting against the narrow tradeScope.
 */
export function buildBoardScope(tradeScope: Set<string>, pending: Array<{ ticker: string }>): Set<string> {
  const scope = new Set(tradeScope);
  for (const s of pending) scope.add(T(s.ticker));
  return scope;
}

/**
 * Read the board and build the scope. One place, called at the top of BOTH the
 * intraday pass and the EOD pass, so the two can never disagree about what is current.
 */
export function readAlertScope(dbRead: typeof import("@/lib/db/read")): {
  /** open ∪ live — the full-alert-set scope. */
  scope: Set<string>;
  /** open ∪ live ∪ pending — the EOD close-based lane (promotion + entry family + earnings). */
  boardScope: Set<string>;
  open: ReturnType<typeof import("@/lib/db/read").getOpenPositions>;
  live: import("@/lib/db/read").CurrentBoardRow[];
  pending: ReturnType<typeof import("@/lib/db/read").getPendingSetups>;
} {
  const open = dbRead.getOpenPositions();
  const board = dbRead.getCurrentBoard();
  const live = selectLiveRows([...board.live, ...board.pending]);
  const scope = new Set<string>();
  for (const p of open) scope.add(T(p.ticker));
  for (const r of live) scope.add(T(r.ticker));
  // getPendingSetups() is already owned- and retired-excluded and run-scoped.
  const pending = dbRead.getPendingSetups();
  return { scope, boardScope: buildBoardScope(scope, pending), open, live, pending };
}

// ============================================================
// Orchestration (VPS-only; DB layer lazy-required so better-sqlite3 stays off Vercel)
// ============================================================

/**
 * HEADS-UP evaluation from the intraday IEX quotes — OWNED POSITIONS ONLY.
 *
 * Scope (changed 2026-08-07): intraday alerts cover positions you actually hold —
 * approach-stop, approach-target, big-move. PENDING setups get NO intraday Telegram
 * alerts at all. The entry signal is now solely the 18:00 EOD close-confirmed pass
 * (evaluateEntryConfirmations), which fires on a daily CLOSE above the rim and is on
 * backtest parity — unlike the intraday cross, which frequently reversed before the
 * close and was labeled "not a system signal" for exactly that reason.
 *
 * Pending tickers are still price-refreshed by runIntradayMonitor so the board's NOW
 * price stays live; this is an ALERTING scope change, not a refresh change.
 *
 * evalEntryTrigger and the "entry_trigger" AlertType remain in the file, unit-tested
 * and DORMANT — nothing calls them. They are kept so the intraday entry heads-up can
 * be re-enabled without rebuilding it.
 *
 * tngoLast-null tickers are suppressed (no fabricated alert off a stale close).
 */

/**
 * Pure alert construction for the intraday pass — no Redis, no Telegram, no DB. Split
 * out so the owned-only SCOPE is directly testable: feed it quotes for owned AND
 * pending tickers and the pending ones must produce nothing.
 */
export function buildIntradayAlerts(
  open: Array<{ ticker: string; stop: number | null; target: number | null }>,
  quotes: IexQuote[]
): Array<Alert | null> {
  const qmap = new Map(quotes.map((q) => [q.ticker.toUpperCase(), q]));
  const alerts: Array<Alert | null> = [];
  for (const p of open) {
    const q = qmap.get(p.ticker.toUpperCase());
    if (!q || q.tngoLast == null) continue; // suppression
    const now2 = q.tngoLast;
    alerts.push(evalApproachStop(p.ticker, now2, p.stop));
    alerts.push(evalApproachTarget(p.ticker, now2, p.target));
    alerts.push(evalBigMove(p.ticker, now2, q.prevClose));
  }
  return alerts;
}

/** A setup the touch pass judges: geometry + whether it is a position or a live idea. */
export interface TouchRow {
  ticker: string;
  handleLowDate: string;
  stop: number | null;
  target: number | null;
  owned: boolean;
}

/**
 * PURE touch construction for the intraday pass — no Redis, no Telegram, no DB.
 *
 * Runs over BOTH open positions and live not-owned setups (the two halves of the alert
 * scope). Each result carries its OWN namespaced lifetime key, so an un-entered
 * ran_to_target and a later owned target_hit on the same setup are independent events.
 */
export function buildIntradayTouchAlerts(
  rows: TouchRow[],
  quotes: IexQuote[],
  isOpenFn: (d: Date) => boolean = isMarketOpen
): Array<{ alert: Alert; key: string; kind: HitKind; dayHigh: number | null }> {
  const qmap = new Map(quotes.map((q) => [T(q.ticker), q]));
  const out: Array<{ alert: Alert; key: string; kind: HitKind; dayHigh: number | null }> = [];
  for (const r of rows) {
    const q = qmap.get(T(r.ticker));
    if (!q) continue;
    const range = quoteTouchRange(q, isOpenFn);
    if (range.rejected) continue; // ext-hours print — never a touch
    const touch = detectTouch({ dayHigh: range.high, dayLow: range.low, stop: r.stop, target: r.target });
    if (!touch) continue;
    const kind = hitKindFor(r.owned, touch);
    out.push({
      alert: evalTouchAlert({ ticker: r.ticker, owned: r.owned, touch, stop: r.stop, target: r.target, source: "intraday" }),
      key: hitMarkerKey(kind, r.ticker, r.handleLowDate),
      kind,
      dayHigh: range.high,
    });
  }
  return out;
}

export async function evaluateIntradayAlerts(quotes: IexQuote[], now: Date): Promise<number> {
  if (!transport.enabled()) return 0;
  const etDate = etDateISO(now);
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

  // FIX 1 — the authoritative in-scope set, built at the top of the pass.
  const { scope, open, live } = readAlertScope(dbRead);
  const stats = newEmitStats();

  // HEADS-UP (approach stop/target, big move) — OWNED POSITIONS ONLY, unchanged.
  for (const a of buildIntradayAlerts(open, quotes)) {
    if (a) await fireAlert(a, etDate, scope, stats);
  }

  // FIX 2 — TP/SL touch over BOTH halves of the scope. Lifetime keys (no TTL): a hit
  // is terminal, and the EOD pass dedups against these very keys.
  const rows: TouchRow[] = [
    ...open.map((p) => ({ ticker: p.ticker, handleLowDate: p.handleLowDate, stop: p.stop, target: p.target, owned: true })),
    ...live.map((r) => ({ ticker: r.ticker, handleLowDate: r.handleLowDate, stop: r.stop, target: r.target, owned: false })),
  ];
  const touches = buildIntradayTouchAlerts(rows, quotes);
  for (const t of touches) await emitAlert(t.alert, { scope, key: t.key }, stats);

  console.log(
    `JACK intraday alerts: ${stats.sent} sent · ${touches.length} touch(es) detected · ` +
      `scope ${scope.size} (${open.length} open + ${live.length} live) · ` +
      `${stats.suppressedOutOfScope} suppressed stale (${stats.purgedMarkers} marker(s) purged) · ${stats.deduped} deduped`
  );
  return stats.sent;
}

/**
 * SYSTEM (close-based) evaluation on the EOD pass. Reads closes from jack:prices
 * (the eod refresh just wrote them). Held positions → stop/target-hit + time-stop;
 * held + pending → earnings (one Finnhub call for the whole window).
 */
/**
 * EOD CLOSE-CONFIRMED ENTRY pass — a SEPARATE loop from the exit alerts above.
 *
 * Input set difference that matters: the exit alerts iterate OWNED positions; this
 * iterates the run-scoped, owned-excluded PENDING set (getPendingSetups — the canonical
 * accessor from the 2026-07-26 pending-set fix). Never hand-roll a pending query here:
 * that is what let stale, retired setups alert for months.
 *
 * Per setup: skip a null rim (cannot confirm a close above nothing), pull the SAME
 * daily bars the paper replay uses (official closes — never tngoLast), run the SHARED
 * detectFire, and on `fired` send exactly once via the setup-identity marker.
 *
 * Failure discipline: one setup's failure never aborts the loop or the other EOD
 * alerts. A bars-fetch failure routes to the existing OPERATIONAL health path.
 */
async function evaluateEntryConfirmations(
  now: Date,
  etDate: string,
  scope: Set<string>,
  fetchBars: BarFetcher,
  dbRead: typeof import("@/lib/db/read"),
  stats: EmitStats
): Promise<number> {
  const pending = dbRead.getPendingSetups();
  if (pending.length === 0) return 0;

  // P-rank ordinals, loaded ONCE per pass — the same helper JSCORE uses and the same
  // number the board renders as "Pn". A setup with no ordinal simply omits the field.
  let ranks = new Map<number, number>();
  try {
    const dbAnalytics = require("@/lib/db/analytics") as typeof import("@/lib/db/analytics");
    ranks = dbAnalytics.getPriorityRanks();
  } catch (err) {
    console.warn("JACK entry-confirm: P-rank lookup unavailable, omitting the field:", err);
  }

  let fired = 0;
  let skippedNoRim = 0;
  let skippedNotTradeable = 0;
  let fetchFailures = 0;

  for (const s of pending) {
    try {
      // 1. Rim required — the pre-7/17 rimless cohort simply cannot be confirmed.
      if (s.breakout == null) {
        skippedNoRim++;
        continue;
      }

      // 1b. TRADEABLE ONLY. The frozen SIZE_MAP puts Q1/Q2 in the SKIP bucket, which
      // the strategy never enters — so a SKIP setup closing above its rim must NOT be
      // advertised as "buy next session's open". Checked BEFORE the marker and the
      // bars fetch, so a skip costs no Tiingo call and leaves no marker behind (if it
      // is later re-ingested as tradeable, it can still alert).
      if (!isTradeableSetup(s)) {
        skippedNotTradeable++;
        continue;
      }

      // 4. Cheap short-circuit: already alerted for this setup, ever → skip before
      // spending a Tiingo call.
      const key = entryMarkerKey(s.ticker, s.handleLowDate);
      if (await alreadySent(key)) continue;

      // 2. Official DAILY bars, same source as runOutcomeTracker. NOT tngoLast.
      const { bars, error } = await fetchBars(s.ticker, s.handleLowDate);
      if (error || bars.length === 0) {
        fetchFailures++;
        continue;
      }

      // 3. The SHARED fire rule. Sort once and share the index space with detectFire
      // (which sorts identically) so fireIndex is valid against this array.
      const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
      const fire = detectFire(sorted, s.handleLowDate, s.breakout);
      if (fire.status !== "fired") continue; // deferred → may fire later; never_fired → done

      // 5. Parity vs late-entry: sessions between the confirming close and today,
      // counted in BARS (trading sessions), not calendar days.
      const fireDate = fire.fireDate as string;
      const sessionsAgo = sorted.filter((b) => b.date > fireDate && b.date <= etDate).length;
      const late = fireDate < etDate;

      // 5b. A LATE fire may already have played out. Check with the SHARED intraday-
      // touch rule (stop-first), scanning from the FILL bar — the next session's open
      // after the confirming close, which is where the backtest would have entered.
      // A same-day fire cannot have resolved: its fill hasn't happened yet.
      let resolved: { kind: "stop" | "target"; date: string } | null = null;
      if (late && s.stop != null && s.target != null) {
        const fillIdx = (fire.fireIndex as number) + 1;
        if (fillIdx < sorted.length) {
          const exit = findTouchExit(sorted, fillIdx, s.stop, s.target);
          if (exit) resolved = { kind: exit.kind, date: exit.date };
        }
      }

      const alert = evalEntryConfirmed({
        ticker: s.ticker,
        fireClose: fire.fireClose as number,
        breakout: s.breakout,
        fireBarIndex: fire.fireBarIndex as number,
        handleLowDate: s.handleLowDate,
        fireDate,
        etDate,
        sessionsAgo,
        stop: s.stop,
        target: s.target,
        tier: s.tier,
        pRank: ranks.get(s.setupId) ?? null,
        sizeBucket: s.sizeBucket,
        resolved,
      });

      // No TTL — exactly once per setup, for the setup's lifetime.
      if (await fireOnce(alert, key, scope, undefined, stats)) fired++;

      // NO BOARD WRITE HERE — deliberately. promotePendingToLive owns the fired-state
      // stamp and runs BEFORE this pass, with no Redis read at all.
      //
      // This pass short-circuits on its once-per-setup alert marker (line ~48 above),
      // which sits ABOVE everything. While the board write lived down here, that marker
      // made the stamp unreachable forever after the first alert: TTE alerted on one
      // day, and on the day it genuinely closed above its rim the pass skipped at the
      // marker and never promoted. Alert dedup and board state are now co-equal
      // consequences of ONE predicate; neither gates the other.
    } catch (err) {
      // A single bad setup must never take down the pass.
      console.error(`JACK entry-confirm failed for ${s.ticker}:`, err);
      fetchFailures++;
    }
  }

  if (fetchFailures > 0) {
    await fireHealth(
      "entry_bars_fetch",
      `${fetchFailures}/${pending.length} pending setups could not be checked for a close-confirmed entry`,
      etDate
    );
  }
  console.log(
    `JACK entry confirmations: ${fired} fired · ${pending.length} pending checked · ` +
      `${skippedNoRim} skipped (no rim) · ${skippedNotTradeable} skipped (SKIP bucket / Q1-Q2) · ` +
      `${fetchFailures} fetch failure(s)`
  );
  return fired;
}

/**
 * ARMED — a missed setup has banked its run-up and the pullback is still ahead.
 *
 * Pure message builder (the gate itself is evalSecondChance). SYSTEM tier: backtested,
 * not a heads-up.
 *
 * The message is an INSTRUCTION TO PLACE A RESTING LIMIT, not a report that something
 * happened. That is the entire reason this fires on arming rather than on the retest:
 * the retest is an intraday event, and an EOD alert about it arrives a day late. A GTC
 * limit at `entry`, placed tonight, fills at the exact backtested price whenever the
 * pullback comes.
 *
 * The footer caveat is not decoration — re-entering on a pullback RESTORES the original
 * R:R, it does not improve it, and using it as a substitute for the normal entry is a
 * worse strategy. Say so every time.
 */
export function evalSecondChanceAlert(args: {
  ticker: string;
  tier: string | null;
  pRank: number | null;
  entry: number;
  stop: number;
  t05: number;
  rr: number | null;
  runupPct: number | null;
  /** entryDate + RETEST_WINDOW_BARS trading days — when the resting order should die. */
  cancelBy: string | null;
}): Alert {
  const head = [
    `🔫 ARMED — ${T(args.ticker)}`,
    args.pRank != null || args.tier ? `  (${[args.pRank != null ? `P${args.pRank}` : null, args.tier?.toUpperCase() ?? null].filter(Boolean).join(" · ")})` : "",
  ].join("");

  const text =
    `${head}\n` +
    `Ran up ${args.runupPct != null ? `${args.runupPct.toFixed(0)}%` : `>=${RUNUP_FRAC * 100}%`} toward t05 since firing, still live + un-traded.\n` +
    `Place a resting BUY limit: entry ${p2(args.entry)}  ·  stop ${p2(args.stop)}  ·  target(t05) ${p2(args.t05)}  ·  R:R ${args.rr != null ? args.rr.toFixed(2) : "—"}\n` +
    (args.cancelBy ? `Cancel if unfilled by ${args.cancelBy}.\n` : "") +
    `recovery of a missed entry; restores original R:R, doesn't improve it (backtested +0.33R / PF 1.93)`;

  return mk("second_chance", "system", args.ticker, text);
}

/**
 * EOD recovery pass — fires on ARMING, not on the retest. Runs after the entry
 * confirmations, on the same 18:00 block.
 *
 * A retest is an intraday event; an EOD alert about it lands a day late, after the fill
 * it describes. Arming (max-high-since-entry crossing the run-up threshold) is a
 * persistent state that is reliably visible at EOD, so THAT is what we alert on — and
 * the operator answers it with a resting limit that catches the pullback at the exact
 * backtested price.
 *
 * CANDIDATE POOL — the full run-scoped board (LIVE + pending), owned- and
 * retired-excluded, NOT getPendingSetups(). getPendingSetups() returns only
 * section='pending' rows; sourcing from it is exactly what left the Basket Sizer blank
 * while the board showed LIVE (10), because a validated-LIVE setup never appears there.
 *
 * FIRE GATE — evalSecondChance runs the SHARED detectFire over the bars. We do not
 * gate on the fired_at column: the EOD pass only stamps it on pending rows, so a
 * validated-LIVE setup would be excluded despite having fired.
 *
 * Failure discipline matches the entry pass: per-setup try/catch, a bars-fetch failure
 * routes to the OPERATIONAL health path, and one bad setup never aborts the loop.
 */
async function evaluateSecondChance(
  etDate: string,
  scope: Set<string>,
  fetchBars: BarFetcher,
  dbRead: typeof import("@/lib/db/read"),
  stats: EmitStats
): Promise<number> {
  const board = dbRead.getCurrentBoard();
  const candidates = [...board.live, ...board.pending].filter(
    (r) => !isOwnedPosition(r) && r.retiredAt == null && isTradeableSetup(r) && isInLiveDisplayGroup(r)
  );
  if (candidates.length === 0) return 0;

  let ranks = new Map<number, number>();
  try {
    const dbAnalytics = require("@/lib/db/analytics") as typeof import("@/lib/db/analytics");
    ranks = dbAnalytics.getPriorityRanks();
  } catch (err) {
    console.warn("JACK second-chance: P-rank lookup unavailable, omitting the field:", err);
  }

  let fired = 0;
  let fetchFailures = 0;
  const reasons = new Map<string, number>();

  for (const s of candidates) {
    try {
      if (s.breakout == null || s.stop == null || s.target == null) continue;

      // Dedup BEFORE the fetch — an already-alerted setup costs no Tiingo call.
      const key = secondChanceMarkerKey(s.ticker, s.handleLowDate);
      if (await alreadySent(key)) continue;

      const { bars, error } = await fetchBars(s.ticker, s.handleLowDate);
      if (error || bars.length === 0) {
        fetchFailures++;
        continue;
      }

      const res = evalSecondChance(
        { handleLowDate: s.handleLowDate, breakout: s.breakout, stop: s.stop, target: s.target },
        bars
      );
      reasons.set(res.reason, (reasons.get(res.reason) ?? 0) + 1);
      if (!res.eligible) continue;

      const alert = evalSecondChanceAlert({
        ticker: s.ticker,
        tier: s.tier,
        pRank: ranks.get(s.setupId) ?? null,
        entry: res.entry as number,
        stop: res.stop as number,
        t05: res.t05 as number,
        rr: res.rr,
        runupPct: res.runupPct,
        cancelBy: res.entryDate ? addTradingDaysISO(res.entryDate, RETEST_WINDOW_BARS) : null,
      });

      // No TTL — a setup ARMS once, so it pings once, ever. Routed through the SAME
      // funnel as every other path: the second-chance gate lives in its own file, and
      // this is what stops it firing on a ticker the latest validation dropped.
      if (await fireOnce(alert, key, scope, undefined, stats)) fired++;
    } catch (err) {
      console.error(`JACK second-chance failed for ${s.ticker}:`, err);
      fetchFailures++;
    }
  }

  if (fetchFailures > 0) {
    await fireHealth(
      "second_chance_bars_fetch",
      `${fetchFailures}/${candidates.length} board setups could not be checked for a recovery re-entry`,
      etDate
    );
  }
  console.log(
    `JACK second chance (armed): ${fired} fired · ${candidates.length} candidate(s) checked ` +
      `(runup>=${RUNUP_FRAC * 100}% toward t05, <=${RETEST_WINDOW_BARS} bars, pullback still ahead) · ` +
      `${[...reasons.entries()].map(([r, n]) => `${r}:${n}`).join(" ") || "no evaluations"}` +
      (fetchFailures > 0 ? ` · ${fetchFailures} fetch failure(s)` : "")
  );
  return fired;
}

/**
 * PASS-SCOPED daily-bar memo. The EOD block now reads bars in three places (entry
 * confirmations, second chance, and the live touch backstop) over heavily overlapping
 * tickers; without this the same (ticker, handle_low_date) is fetched up to 3×.
 * Keyed on setup identity, lives for ONE pass only — never a cross-pass cache, so a
 * later pass can never see yesterday's bars.
 */
export type BarFetcher = (ticker: string, handleLowDate: string) => Promise<{ bars: Bar[]; error?: string }>;

export function makeBarFetcher(tiingoBase: string): BarFetcher {
  const memo = new Map<string, Promise<{ bars: Bar[]; error?: string }>>();
  return (ticker, handleLowDate) => {
    const k = `${T(ticker)}|${handleLowDate}`;
    let p = memo.get(k);
    if (!p) {
      p = fetchDailyBars(tiingoBase, ticker, handleLowDate);
      memo.set(k, p);
    }
    return p;
  };
}

/**
 * EOD BACKSTOP for LIVE, NOT-OWNED setups — the IEX-vs-consolidated reconciliation net.
 *
 * A close-based check cannot catch a runner that touched t05 and faded: it never
 * *closes* above t05. So this reads the CONSOLIDATED daily bar (ground truth) and
 * applies the same touch rule to today's high/low. If the intraday IEX pass already
 * fired, the shared lifetime key makes this a no-op — that is the idempotency.
 *
 * This branch is the net for exactly the case that started this fix: a thin IEX feed
 * missed the touch, and the daily bar proves it happened. Every such catch is LOGGED
 * as a mismatch — a ticker that mismatches repeatedly has an IEX feed too thin to trust.
 */
export async function evaluateLiveTouchBackstop(
  live: Array<{ ticker: string; handleLowDate: string; stop: number | null; target: number | null }>,
  scope: Set<string>,
  etDate: string,
  fetchBars: BarFetcher,
  stats: EmitStats
): Promise<{ fired: number; mismatches: string[]; fetchFailures: number }> {
  let fired = 0;
  let fetchFailures = 0;
  const mismatches: string[] = [];

  for (const s of live) {
    try {
      if (s.stop == null && s.target == null) continue;
      const { bars, error } = await fetchBars(s.ticker, s.handleLowDate);
      if (error || bars.length === 0) {
        fetchFailures++;
        continue;
      }
      // TODAY's consolidated bar only. Falling back to the last bar would let a stale
      // feed re-report an old day's touch as if it happened today.
      const today = bars.find((b) => b.date.slice(0, 10) === etDate);
      if (!today) continue;

      const touch = detectTouch({ dayHigh: today.high, dayLow: today.low, stop: s.stop, target: s.target });
      if (!touch) continue;

      const kind = hitKindFor(false, touch);
      const key = hitMarkerKey(kind, s.ticker, s.handleLowDate);
      const alreadyKnown = await alreadySent(key);
      const alert = evalTouchAlert({
        ticker: s.ticker,
        owned: false,
        touch,
        stop: s.stop,
        target: s.target,
        source: "eod",
      });
      if (await emitAlert(alert, { scope, key }, stats)) {
        fired++;
        // Fired HERE and not intraday → the live feed missed a touch the official bar
        // shows. That is the signal-quality datum worth watching.
        if (!alreadyKnown) mismatches.push(`${T(s.ticker)}:${kind}`);
      }
    } catch (err) {
      console.error(`JACK live touch backstop failed for ${s.ticker}:`, err);
      fetchFailures++;
    }
  }
  return { fired, mismatches, fetchFailures };
}

/**
 * PENDING → LIVE PROMOTION pass (Fix 3). EOD only, close-based, once per setup.
 *
 * MOST-RECENT BAR, not today's. Promotion is a STATE ("the latest close is at or above
 * entry"), not a per-day event, so this reads the last available daily bar. That is
 * deliberate on two counts:
 *   · Tiingo may not have published today's bar by the 18:00 ET pass. A today-only
 *     match would miss the promotion permanently — tomorrow's pass looks for tomorrow's
 *     date, and today's bar is never examined again.
 *   · It matches how the entry family already reads bars (detectFire scans for the
 *     state, it does not require a same-day bar).
 * The once-per-setup lifetime marker is what makes re-reading the same bar harmless.
 * (The TP/SL backstop stays today-only on purpose: a touch IS a per-day event.)
 *
 * TRADEABLE ONLY, same gate as the entry-confirmation pass: the frozen SIZE_MAP never
 * enters Q1/Q2, so a SKIP-bucket setup closing above entry must not be announced as
 * "tradeable from the next open".
 */
export interface PromotionRow {
  setupId: number;
  /** The CURRENT run's decision row — the one the stamp lands on. */
  decisionId: number;
  ticker: string;
  handleLowDate: string;
  breakout: number | null;
  stop: number | null;
  target: number | null;
  sizeBucket?: string | null;
  tier?: string | null;
}

export interface PromotionWriter {
  markDecisionFired: (decisionId: number, mark: { firedAt: string; fireClose: number; fireBar: number; firedStatus: "confirmed" | "late" | "resolved" }) => number;
  clearDecisionFired: (setupId: number) => number;
}

export interface PromotionPassResult {
  promoted: number;
  alerted: number;
  unpromoted: number;
  rimless: number;
  notTradeable: number;
  deferred: number;
  resolved: number;
  fetchFailures: number;
}

export async function promotePendingToLive(
  pending: PromotionRow[],
  boardScope: Set<string>,
  etDate: string,
  fetchBars: BarFetcher,
  writer: PromotionWriter,
  stats: EmitStats
): Promise<PromotionPassResult> {
  const r: PromotionPassResult = {
    promoted: 0, alerted: 0, unpromoted: 0, rimless: 0,
    notTradeable: 0, deferred: 0, resolved: 0, fetchFailures: 0,
  };

  for (const s of pending) {
    try {
      // Cheap gates first — neither costs a Tiingo call.
      if (s.breakout == null) {
        r.rimless++; // FAIL CLOSED. Never promoted on a close-only comparison.
        continue;
      }
      if (!isTradeableSetup(s)) {
        r.notTradeable++;
        continue;
      }

      const { bars, error } = await fetchBars(s.ticker, s.handleLowDate);
      if (error || bars.length === 0) {
        r.fetchFailures++;
        continue; // transient — never un-promote on a fetch failure
      }

      // THE predicate, re-derived against the CURRENT run's geometry every pass.
      const verdict = isPromotedToLive(
        { handleLowDate: s.handleLowDate, breakout: s.breakout, stop: s.stop, target: s.target, sizeBucket: s.sizeBucket, tier: s.tier },
        bars,
        etDate
      );

      // ---- BOARD WRITE. Deliberately BEFORE the alert and with NO Redis read of any
      // kind: the alert marker must never gate the DB write. That ordering is what let
      // TTE alert while the board stayed pending — one `if (alreadySent) continue`
      // above markDecisionFired, and the stamp became unreachable forever after.
      if (verdict.promoted) {
        // Set-once in SQL, so a re-run is a no-op rather than a rewrite.
        writer.markDecisionFired(s.decisionId, {
          firedAt: etDate,
          fireClose: verdict.fireClose as number,
          fireBar: verdict.fireBar as number,
          firedStatus: verdict.firedStatus as "confirmed" | "late",
        });
        r.promoted++;
      } else if (verdict.reason === "resolved") {
        // Fired but already played out: recorded for the badge, and excluded from the
        // LIVE group by isFiredActionable. Not a live idea, not un-stamped either.
        writer.markDecisionFired(s.decisionId, {
          firedAt: etDate,
          fireClose: verdict.fireClose as number,
          fireBar: verdict.fireBar as number,
          firedStatus: "resolved",
        });
        r.resolved++;
      } else if (verdict.reason === "not_fired" || verdict.reason === "deferred") {
        // CURRENT-GEOMETRY RE-DERIVATION. We have bars and a rim, and the setup does
        // NOT clear it — so any stamp left by an earlier run was computed against
        // geometry that no longer exists (a re-scan revised the rim upward past the
        // close that fired it). Clearing is what stops a stale fire riding the
        // cross-run read into the LIVE group. No-op when nothing was stamped.
        const cleared = writer.clearDecisionFired(s.setupId);
        if (cleared > 0) r.unpromoted++;
        if (verdict.reason === "deferred") r.deferred++;
      }

      // ---- ALERT. A SEPARATE consequence of the same verdict. Its Redis dedup lives
      // entirely on this side of the board write, so a suppressed alert can never
      // suppress a promotion, and a failed write can never suppress an alert.
      if (verdict.promoted) {
        const alert = evalPromotionAlert({
          ticker: s.ticker,
          fireClose: verdict.fireClose as number,
          rim: s.breakout,
          fireBar: verdict.fireBar as number,
          handleLowDate: s.handleLowDate,
          late: verdict.firedStatus === "late",
          // Already in scope — both are handed to isPromotedToLive just above.
          // The isTradeableSetup gate has already run, so tier here is Q3/Q4/Q5.
          tier: s.tier,
          sizeBucket: s.sizeBucket,
        });
        const key = promotionMarkerKey(s.ticker, s.handleLowDate);
        if (await emitAlert(alert, { scope: boardScope, key }, stats)) r.alerted++;
      }
    } catch (err) {
      console.error(`JACK promotion check failed for ${s.ticker}:`, err);
      r.fetchFailures++;
    }
  }
  return r;
}

export async function evaluateEodAlerts(now: Date, tiingoBase?: string): Promise<number> {
  if (!transport.enabled()) return 0;
  const etDate = etDateISO(now);
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

  // FIX 1 — the same in-scope set the intraday pass builds, built here at the top too.
  // FIX 3 — plus the wider boardScope (adds PENDING) for the EOD close-based lane.
  const { scope, boardScope, open, live, pending } = readAlertScope(dbRead);
  const stats = newEmitStats();
  const held = new Set(open.map((p) => p.ticker.toUpperCase()));

  let store: StoredPrices | null = null;
  try {
    store = (await redis.get(PRICES_KEY)) as StoredPrices | null;
  } catch {
    store = null;
  }
  const closeFor = (t: string): number | null => store?.prices?.[t.toUpperCase()]?.price ?? null;

  // OWNED, CLOSE-BASED hits. These now dedup on the SETUP-scoped hit key — the same
  // key the intraday touch uses — so an intraday TARGET HIT is never repeated at the
  // close, and a hit fires once per setup rather than once per ET-day.
  let fired = 0;
  for (const p of open) {
    const close = closeFor(p.ticker);
    if (close == null) continue;
    for (const [kind, alert] of [
      ["stop_hit", evalStopHit(p.ticker, close, p.stop)],
      ["target_hit", evalTargetHit(p.ticker, close, p.target)],
    ] as Array<[HitKind, Alert | null]>) {
      if (!alert) continue;
      if (await emitAlert(alert, { scope, key: hitMarkerKey(kind, p.ticker, p.handleLowDate) }, stats)) fired++;
    }
  }

  // Per-ET-day alerts (persistent conditions, right to re-arm daily).
  const alerts: Array<Alert | null> = [];
  for (const p of open) {
    alerts.push(evalTimeStop(p.ticker, computeDaysHeld(p.userEntryDate, now)));
  }

  // Earnings — held + pending, one calendar call for the whole window. These are
  // PENDING-eligible (boardScope, below): an advisory on a setup you may buy tomorrow
  // is exactly as useful as one on a position you hold. Fix 1 suppressed them as
  // collateral damage; the widened lane restores them.
  const earningsAlerts: Array<Alert | null> = [];
  const earningsTickers = new Set<string>([...held, ...pending.map((s) => s.ticker.toUpperCase())]);
  if (earningsEnabled() && earningsTickers.size > 0) {
    const fromISO = etDate;
    const toISO = addCalendarDaysISO(etDate, 14);
    const r = await fetchEarningsMap(fromISO, toISO);
    if (r.ok && r.map) {
      let matched = 0;
      let unmatched = 0;
      for (const t of earningsTickers) {
        const d = r.map[t];
        if (!d) {
          unmatched++;
          continue;
        }
        matched++;
        earningsAlerts.push(evalEarnings(t, d, tradingDaysUntil(etDate, d)));
      }
      console.log(
        `JACK earnings check: ${matched} matched / ${unmatched} unmatched of ${earningsTickers.size} tickers`
      );
    } else if (!r.disabled) {
      await fireHealth("finnhub_fetch", r.error ?? "unknown", etDate);
    }
  }

  // Time stops concern OWNED positions only → the narrow scope.
  for (const a of alerts) if (a && (await fireAlert(a, etDate, scope, stats))) fired++;
  // Earnings may name a pending ticker → the widened board scope.
  for (const a of earningsAlerts) if (a && (await fireAlert(a, etDate, boardScope, stats))) fired++;

  // NEW: close-confirmed entry pass over the PENDING set. Runs after the exit alerts
  // and is fully isolated — its failure can never suppress a stop/target/time-stop.
  if (tiingoBase) {
    // ONE memo for the whole EOD block — the four bar-reading passes below overlap
    // heavily on (ticker, handle_low_date).
    const fetchBars = makeBarFetcher(tiingoBase);

    // BOARD FIRST. The promoter stamps fired-state before any alert pass runs, so the
    // board is correct even if every alert below is suppressed, fails, or is deduped.
    try {
      const dbWrite = require("@/lib/db/write") as typeof import("@/lib/db/write");
      const rows: PromotionRow[] = pending.map((s) => ({
        setupId: s.setupId,
        decisionId: s.decisionId,
        ticker: s.ticker,
        handleLowDate: s.handleLowDate,
        breakout: s.breakout,
        stop: s.stop,
        target: s.target,
        sizeBucket: s.sizeBucket,
        tier: s.tier,
      }));
      const pr = await promotePendingToLive(rows, boardScope, etDate, fetchBars, dbWrite, stats);
      fired += pr.alerted;
      console.log(
        `JACK promotions: ${pr.promoted} promoted (${pr.alerted} alerted) · ${pending.length} pending checked · ` +
          `${pr.unpromoted} un-promoted (stale fire vs current rim) · ${pr.rimless} rimless (never promoted) · ` +
          `${pr.notTradeable} SKIP bucket / Q1-Q2 · ${pr.deferred} window open · ${pr.resolved} already resolved` +
          (pr.fetchFailures > 0 ? ` · ${pr.fetchFailures} fetch failure(s)` : "")
      );
      if (pr.fetchFailures > 0) {
        await fireHealth(
          "entry_bars_fetch",
          `${pr.fetchFailures}/${pending.length} pending setups could not be checked for promotion`,
          etDate
        );
      }
    } catch (err) {
      console.error("JACK promotion pass failed:", err);
    }

    try {
      // BOARD SCOPE, not the narrow one. This pass iterates getPendingSetups(), and on
      // the day a setup FIRST closes above its rim its fired_status is still NULL
      // (markDecisionFired runs after the send) — so under the narrow open∪live scope
      // the on-parity "ENTRY CONFIRMED · buy next session's open" was suppressed, the
      // board flag was stamped anyway, and the next evening it re-fired as "LATE ENTRY
      // — OFF-parity". Silently trading a parity signal for an off-parity one.
      fired += await evaluateEntryConfirmations(now, etDate, boardScope, fetchBars, dbRead, stats);
    } catch (err) {
      console.error("JACK entry-confirmation pass failed:", err);
    }
    // RECOVERY pass — isolated from the entry pass for the same reason the entry pass
    // is isolated from the exit alerts: one failing must never suppress the others.
    try {
      fired += await evaluateSecondChance(etDate, scope, fetchBars, dbRead, stats);
    } catch (err) {
      console.error("JACK second-chance pass failed:", err);
    }
    // LIVE not-owned touch backstop — the consolidated-daily-bar net under the IEX feed.
    try {
      const bs = await evaluateLiveTouchBackstop(live, scope, etDate, fetchBars, stats);
      fired += bs.fired;
      if (bs.mismatches.length > 0) {
        console.warn(
          `JACK touch reconciliation: ${bs.mismatches.length} touch(es) the intraday IEX feed MISSED, ` +
            `caught by the consolidated daily bar — ${bs.mismatches.join(" ")} ` +
            `(a ticker that repeats here has an IEX feed too thin to trust)`
        );
      }
      if (bs.fetchFailures > 0) {
        await fireHealth(
          "entry_bars_fetch",
          `${bs.fetchFailures}/${live.length} live setups could not be checked for a daily-bar touch`,
          etDate
        );
      }
    } catch (err) {
      console.error("JACK live touch backstop failed:", err);
    }
  } else {
    console.warn("JACK entry confirmations skipped — no tiingoBase passed to evaluateEodAlerts");
  }

  console.log(
    `JACK eod alerts: ${stats.sent} sent · scope ${scope.size} (${open.length} open + ${live.length} live) · ` +
      `${stats.suppressedOutOfScope} suppressed stale (${stats.purgedMarkers} marker(s) purged) · ${stats.deduped} deduped`
  );
  return fired;
}
