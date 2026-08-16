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
import { isTradingDay, etDateISO } from "./market-hours";
import { computeDaysHeld } from "./position-mgmt";
// The SHARED fire rule + the SAME daily-bar source the paper replay uses. The entry
// alert must never re-derive either one — that is the parity mandate.
import { detectFire, findTouchExit, fetchDailyBars, CONFIRM_WINDOW_BARS } from "./outcome-tracker";
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
  | "second_chance";

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

// Err toward SENDING on a Redis read failure (a rare dup beats a missed stop-hit).
async function alreadySent(key: string): Promise<boolean> {
  try {
    return (await redis.get(key)) != null;
  } catch {
    return false;
  }
}
async function markSent(key: string): Promise<void> {
  try {
    await redis.set(key, "1", { ex: 36 * 60 * 60 });
  } catch {
    // non-fatal — worst case the alert can repeat; better than silent Redis coupling
  }
}

/** Send one alert with dedup. Marks sent ONLY on a successful send (else retries next cycle). */
export async function fireAlert(a: Alert, etDate: string): Promise<boolean> {
  const key = alertMarkerKey(a.type, a.ticker, etDate);
  if (await alreadySent(key)) return false;
  const res = await sendTelegram(a.text);
  if (res.ok) {
    await markSent(key);
    return true;
  }
  return false;
}

/**
 * Send an alert deduped on an EXPLICIT key (not the per-day one). Same discipline as
 * fireAlert: the marker is set ONLY after a successful send, so a Telegram failure
 * retries on the next pass instead of silently swallowing the signal.
 *
 * `ttlSeconds` omitted → no expiry, i.e. fires exactly once for the lifetime of the key.
 */
export async function fireOnce(a: Alert, key: string, ttlSeconds?: number): Promise<boolean> {
  if (await alreadySent(key)) return false;
  const res = await sendTelegram(a.text);
  if (!res.ok) return false;
  try {
    if (ttlSeconds != null) await redis.set(key, "1", { ex: ttlSeconds });
    else await redis.set(key, "1");
  } catch {
    // non-fatal — worst case the alert can repeat; better than coupling to Redis
  }
  return true;
}

const HEALTH_LABEL: Record<HealthFailure, string> = {
  intraday_refresh: "intraday monitor failed",
  eod_refresh: "eod refresh failed",
  iex_batch: "IEX batch unavailable",
  finnhub_fetch: "earnings fetch failed",
  entry_bars_fetch: "entry-alert daily bars fetch failed",
  second_chance_bars_fetch: "second-chance daily bars fetch failed",
};

export async function fireHealth(failure: HealthFailure, detail: string, etDate: string): Promise<boolean> {
  const key = healthMarkerKey(failure, etDate);
  if (await alreadySent(key)) return false;
  const text = `🚨 OPS · JACK pipeline issue\n${HEALTH_LABEL[failure]}: ${detail.slice(0, 200)}`;
  const res = await sendTelegram(text);
  if (res.ok) {
    await markSent(key);
    return true;
  }
  return false;
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

export async function evaluateIntradayAlerts(quotes: IexQuote[], now: Date): Promise<number> {
  if (!alertsEnabled()) return 0;
  const etDate = etDateISO(now);
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

  // OWNED POSITIONS ONLY — no pending loop. See the doc comment above.
  const alerts = buildIntradayAlerts(dbRead.getOpenPositions(), quotes);

  let fired = 0;
  for (const a of alerts) if (a && (await fireAlert(a, etDate))) fired++;
  return fired;
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
  tiingoBase: string,
  dbRead: typeof import("@/lib/db/read")
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
      const { bars, error } = await fetchDailyBars(tiingoBase, s.ticker, s.handleLowDate);
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
      if (await fireOnce(alert, key)) fired++;

      // BOARD FLAG — same detection that just fired the alert, persisted so the board
      // shows the fire without waiting for the weekly re-VALIDATE. Derived from the
      // SAME `resolved`/`late` branch evalEntryConfirmed used, so the badge and the
      // Telegram text can never disagree.
      //
      // Written AFTER the send and wrapped: a DB hiccup must never throw out of the
      // EOD pass or block an alert. Set-once in SQL (fired_at IS NULL), and because
      // the loop short-circuits on the Redis marker, fired_status is captured at FIRST
      // detection and deliberately not chased afterwards — a 'confirmed' fire that
      // later resolves stays 'confirmed' on the board until the next VALIDATE or until
      // the user trades it. The entry_resolved alert and the outcome tracker cover
      // true resolution; the board's job here is "this fired, act or not".
      try {
        const dbWrite = require("@/lib/db/write") as typeof import("@/lib/db/write");
        dbWrite.markDecisionFired(s.decisionId, {
          firedAt: etDate,
          fireClose: fire.fireClose as number,
          fireBar: fire.fireBarIndex as number,
          firedStatus: resolved ? "resolved" : late ? "late" : "confirmed",
        });
      } catch (err) {
        console.error(`JACK fired-flag persist failed for ${s.ticker} (alert already sent):`, err);
      }
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
  tiingoBase: string,
  dbRead: typeof import("@/lib/db/read")
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

      const { bars, error } = await fetchDailyBars(tiingoBase, s.ticker, s.handleLowDate);
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

      // No TTL — a setup ARMS once, so it pings once, ever.
      if (await fireOnce(alert, key)) fired++;
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

export async function evaluateEodAlerts(now: Date, tiingoBase?: string): Promise<number> {
  if (!alertsEnabled()) return 0;
  const etDate = etDateISO(now);
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

  const open = dbRead.getOpenPositions();
  const held = new Set(open.map((p) => p.ticker.toUpperCase()));

  let store: StoredPrices | null = null;
  try {
    store = (await redis.get(PRICES_KEY)) as StoredPrices | null;
  } catch {
    store = null;
  }
  const closeFor = (t: string): number | null => store?.prices?.[t.toUpperCase()]?.price ?? null;

  const alerts: Array<Alert | null> = [];
  for (const p of open) {
    const close = closeFor(p.ticker);
    if (close != null) {
      alerts.push(evalStopHit(p.ticker, close, p.stop));
      alerts.push(evalTargetHit(p.ticker, close, p.target));
    }
    alerts.push(evalTimeStop(p.ticker, computeDaysHeld(p.userEntryDate, now)));
  }

  // Earnings — held + pending, one calendar call for the whole window.
  const pending = dbRead.getPendingSetups();
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
        alerts.push(evalEarnings(t, d, tradingDaysUntil(etDate, d)));
      }
      console.log(
        `JACK earnings check: ${matched} matched / ${unmatched} unmatched of ${earningsTickers.size} tickers`
      );
    } else if (!r.disabled) {
      await fireHealth("finnhub_fetch", r.error ?? "unknown", etDate);
    }
  }

  let fired = 0;
  for (const a of alerts) if (a && (await fireAlert(a, etDate))) fired++;

  // NEW: close-confirmed entry pass over the PENDING set. Runs after the exit alerts
  // and is fully isolated — its failure can never suppress a stop/target/time-stop.
  if (tiingoBase) {
    try {
      fired += await evaluateEntryConfirmations(now, etDate, tiingoBase, dbRead);
    } catch (err) {
      console.error("JACK entry-confirmation pass failed:", err);
    }
    // RECOVERY pass — isolated from the entry pass for the same reason the entry pass
    // is isolated from the exit alerts: one failing must never suppress the others.
    try {
      fired += await evaluateSecondChance(etDate, tiingoBase, dbRead);
    } catch (err) {
      console.error("JACK second-chance pass failed:", err);
    }
  } else {
    console.warn("JACK entry confirmations skipped — no tiingoBase passed to evaluateEodAlerts");
  }

  return fired;
}
