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

export type AlertType =
  | "approach_stop"
  | "approach_target"
  | "big_move"
  | "entry_trigger"
  | "stop_hit"
  | "target_hit"
  | "time_stop"
  | "earnings";

export type HealthFailure = "intraday_refresh" | "eod_refresh" | "iex_batch" | "finnhub_fetch";

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

const HEALTH_LABEL: Record<HealthFailure, string> = {
  intraday_refresh: "intraday monitor failed",
  eod_refresh: "eod refresh failed",
  iex_batch: "IEX batch unavailable",
  finnhub_fetch: "earnings fetch failed",
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
    alerts.push(evalEntryTrigger(s.ticker, q.prevClose, q.tngoLast, s.breakout ?? s.entry));
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
export async function evaluateEodAlerts(now: Date): Promise<number> {
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
  return fired;
}
