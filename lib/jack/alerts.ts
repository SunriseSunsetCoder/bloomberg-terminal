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
  | "entry_resolved";

export type HealthFailure =
  | "intraday_refresh"
  | "eod_refresh"
  | "iex_batch"
  | "finnhub_fetch"
  | "entry_bars_fetch";

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

/** Same-day CROSS only: prevClose < level AND tngoLast >= level (not a standing "already above"). */
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
 * HEADS-UP evaluation from the intraday IEX quotes. Open positions get
 * approach-stop/target + big-move; pending setups (held-wins → excluded if also held)
 * get entry-trigger + big-move. tngoLast-null tickers are suppressed.
 */
export async function evaluateIntradayAlerts(quotes: IexQuote[], now: Date): Promise<number> {
  if (!alertsEnabled()) return 0;
  const etDate = etDateISO(now);
  const qmap = new Map(quotes.map((q) => [q.ticker.toUpperCase(), q]));
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

  const open = dbRead.getOpenPositions();
  const held = new Set(open.map((p) => p.ticker.toUpperCase()));
  const alerts: Array<Alert | null> = [];

  for (const p of open) {
    const q = qmap.get(p.ticker.toUpperCase());
    if (!q || q.tngoLast == null) continue; // suppression
    const now2 = q.tngoLast;
    alerts.push(evalApproachStop(p.ticker, now2, p.stop));
    alerts.push(evalApproachTarget(p.ticker, now2, p.target));
    alerts.push(evalBigMove(p.ticker, now2, q.prevClose));
  }

  const pending = dbRead.getPendingSetups().filter((s) => !held.has(s.ticker.toUpperCase()));
  for (const s of pending) {
    const q = qmap.get(s.ticker.toUpperCase());
    if (!q || q.tngoLast == null) continue;
    // Once the EOD close-confirmed entry has fired for this setup, the intraday
    // HEADS-UP entry-trigger is redundant noise about an entry already signalled by
    // the system-tier alert — suppress it. Guarded: a Redis hiccup just means the
    // heads-up still sends, which is the safe direction.
    let entryConfirmed = false;
    try {
      entryConfirmed = await alreadySent(entryMarkerKey(s.ticker, s.handleLowDate));
    } catch {
      entryConfirmed = false;
    }
    if (!entryConfirmed) {
      alerts.push(evalEntryTrigger(s.ticker, q.prevClose, q.tngoLast, s.breakout ?? s.entry));
    }
    alerts.push(evalBigMove(s.ticker, q.tngoLast, q.prevClose));
  }

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
  let fetchFailures = 0;

  for (const s of pending) {
    try {
      // 1. Rim required — the pre-7/17 rimless cohort simply cannot be confirmed.
      if (s.breakout == null) {
        skippedNoRim++;
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
      `${skippedNoRim} skipped (no rim) · ${fetchFailures} fetch failure(s)`
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
  } else {
    console.warn("JACK entry confirmations skipped — no tiingoBase passed to evaluateEodAlerts");
  }

  return fired;
}
