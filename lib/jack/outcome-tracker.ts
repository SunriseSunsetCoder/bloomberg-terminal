// =============================================================================
// JACK outcome tracker — the SHARED replay core behind the "UPDATE OUTCOMES"
// button (/api/jack-outcomes POST), the scheduled daily job (outcomes-refresh),
// and the eod price refresh (price-refresh). Pure replay + Tiingo history fetch +
// SQLite write. Lives in lib/ (NOT the route) so other modules can import it:
// Next route files may only export handlers + config, so cross-module helpers must
// not live in a route module. The route imports from here and adds only the HTTP
// handler + req→base plumbing.
// =============================================================================

// Type-only imports compile away — safe on Vercel where the DB layer never loads.
import type { SetupNeedingOutcome } from "@/lib/db/read";
import type { OutcomeRow } from "@/lib/db/write";

// ============================================================
// ELIGIBILITY GATE — trading days. This bounds NOTHING inside the replay; it only
// answers "is this setup old enough that its trade has certainly finished?" (see
// getSetupsNeedingOutcomes). It is deliberately LARGER than TIME_STOP_BARS so the
// full 120 exit bars are guaranteed to exist before a setup is ever resolved. The
// scheduled job imports THIS exact constant so the job and the manual button gate
// identically.
// ============================================================
export const DEFAULT_RESOLUTION_DAYS = 130;

// ============================================================
// PARITY CONSTANTS — these mirror the frozen backtest (cup_handle_15yr_history_1
// .ipynb) that produced the raw-R reference in lib/jack/backtest-reference.ts.
// Changing either one silently invalidates every live-vs-backtest comparison on
// the scorecard. Do NOT tune them.
//
//   Cell 3 (entry):  for j in range(h_idx+1, min(h_idx+1+15, n)):
//                        if C[j] > breakout: confirm = j; break
//                    e_idx = confirm + 1;  e_px = O[e_idx]
//   Cell 1 (exit):   TIME_STOP_DAYS = 120
// ============================================================

/** Bars AFTER handle_low_date in which a confirming CLOSE must appear, else no trade. */
export const CONFIRM_WINDOW_BARS = 15;

/** Bars the trade is allowed to run from entry before the time stop marks it to market. */
export const TIME_STOP_BARS = 120;

// ---- Modeling assumptions (documented, surfaced in the summary + on JSCORE) ----
//  1. FIRE = a confirmed CLOSE above the rim within CONFIRM_WINDOW_BARS bars of the
//     handle low. An intraday high poking through the rim is NOT a breakout — the
//     backtest discarded those, and so do we.
//  2. FILL = the NEXT bar's OPEN after the confirming close (never the rim, never the
//     scanner's projected entry) — gap slippage included, as the backtest ate it.
//  3. EXIT = intraday touch: stop on the bar LOW, target on the bar HIGH, stop checked
//     FIRST (daily bars hide intrabar order, so the tie resolves to the worse outcome).
//     A stop-out is exactly -1R because the fill is modeled AT the stop price.
//  4. TIMEOUT = mark-to-market at the last close within TIME_STOP_BARS.
export const ASSUMPTION_LABELS = [
  `fire=confirmed CLOSE above the rim within ${CONFIRM_WINDOW_BARS} bars of the handle low (unconfirmed → never_fired; an intraday poke is not a breakout)`,
  "fill=next day's OPEN after the confirming close (matches the frozen backtest — gap slippage included)",
  "exit=intraday touch, stop-first (stop on the bar low, target on the bar high; same-bar tie → stop, conservative)",
  `timeout=${TIME_STOP_BARS}-bar mark-to-market (neither hit in window → exit at last close, R from that close)`,
  // KNOWN LIMITATION — second-order, deliberately not closed. Would need the scanner
  // to also emit ATR + the raw stop base before it could be re-derived honestly.
  "known gap: the paper stop is the SCANNER's stop, anchored to its projected entry — the backtest re-derived the stop from the realized fill + ATR, so paper R carries a small stop-placement difference",
];

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================
// FIRE DETECTION — the ONE definition of "did this setup break out?"
//
// Extracted from replaySetup so the JSCORE paper arm and the EOD entry alert cannot
// drift apart. Both call THIS function; there is no second implementation of the rule
// anywhere in the codebase, and there must never be one. Re-implementing it is how the
// 2026-07-31 parity bug (intraday-high fire, 130-bar search) got in.
//
// The rule, mirroring the notebook's
//     for j in range(h_idx+1, min(h_idx+1+15, n)): if C[j] > breakout: confirm = j
//   · search starts at the first bar dated STRICTLY AFTER handle_low_date — NOT index
//     0, because bars[0] is only the handle-low bar when that date was a trading day
//     (a weekend/holiday handle low makes bars[0] already h_idx+1)
//   · CONFIRM_WINDOW_BARS bars wide
//   · STRICT close > breakout — an intraday high through the rim is NOT a confirmation
// ============================================================

export type FireStatus =
  | "fired" // a confirming close was found inside the window
  | "deferred" // window not fully elapsed yet — a later bar may still confirm
  | "never_fired"; // window fully elapsed with no confirming close — terminal

export interface FireDetection {
  status: FireStatus;
  /** Absolute index into the DATE-SORTED bars. null unless fired. */
  fireIndex: number | null;
  /** 1-based bars since the handle low (1 = first bar dated after it). null unless fired. */
  fireBarIndex: number | null;
  fireClose: number | null;
  fireDate: string | null;
  /** How many of CONFIRM_WINDOW_BARS have elapsed (for display + deferred reasons). */
  barsInWindow: number;
  /** Populated on `deferred` — why we refuse to call it yet. */
  reason?: string;
}

/**
 * Detect the confirming close. Callers MUST guard a null rim before calling — a setup
 * with no breakout_level cannot be confirmed and is skipped upstream (the paper replay
 * bails as "missing geometry"; the entry alert skips and counts it).
 *
 * Sorts defensively by date; the returned `fireIndex` refers to that sorted order.
 * replaySetup sorts identically before calling, so the index is valid against its array.
 */
export function detectFire(bars: Bar[], handleLowDate: string, breakout: number): FireDetection {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));

  const firstAfter = sorted.findIndex((b) => b.date > handleLowDate);
  if (firstAfter === -1) {
    return {
      status: "deferred",
      fireIndex: null,
      fireBarIndex: null,
      fireClose: null,
      fireDate: null,
      barsInWindow: 0,
      reason: "no bars after handle_low_date yet",
    };
  }

  const windowEnd = firstAfter + CONFIRM_WINDOW_BARS;
  const scanEnd = Math.min(windowEnd, sorted.length);
  const barsInWindow = scanEnd - firstAfter;

  for (let i = firstAfter; i < scanEnd; i++) {
    // STRICT >, and CLOSE.
    if (sorted[i].close > breakout) {
      return {
        status: "fired",
        fireIndex: i,
        fireBarIndex: i - firstAfter + 1, // 1-based bars since the handle low
        fireClose: sorted[i].close,
        fireDate: sorted[i].date,
        barsInWindow,
      };
    }
  }

  if (sorted.length < windowEnd) {
    // Window hasn't fully elapsed — don't lock in a 'never_fired' a later bar would
    // contradict.
    return {
      status: "deferred",
      fireIndex: null,
      fireBarIndex: null,
      fireClose: null,
      fireDate: null,
      barsInWindow,
      reason: `confirm window not elapsed (${barsInWindow}/${CONFIRM_WINDOW_BARS} bars)`,
    };
  }

  return {
    status: "never_fired",
    fireIndex: null,
    fireBarIndex: null,
    fireClose: null,
    fireDate: null,
    barsInWindow,
  };
}

// ============================================================
// EXIT DETECTION — the ONE definition of "did this trade hit stop or target?"
//
// Same discipline as detectFire: extracted so the paper replay and the EOD entry
// alert's already-resolved check cannot drift. INTRADAY TOUCH, stop checked FIRST —
// mirroring _sim_trade:
//     if bl <= stop_price:   -> stop
//     if bh >= target_price: -> target
// The stop-first ordering IS the tie rule: a bar touching both resolves to the stop,
// conservatively, because daily bars hide intrabar sequence.
// ============================================================

/** Per-bar intraday-touch test. Returns the exit this bar produces, if any. */
export function exitOnBar(bar: Bar, stop: number, target: number): "stop" | "target" | null {
  if (bar.low <= stop) return "stop"; // checked first — also resolves the same-bar tie
  if (bar.high >= target) return "target";
  return null;
}

export interface TouchExit {
  kind: "stop" | "target";
  date: string;
  /** The modeled fill: the level itself, matching the replay. */
  price: number;
  /** Absolute index into the date-sorted bars. */
  barIndex: number;
}

/**
 * First intraday touch at or after `fromIndex`, bounded by `maxBars`. Used by the EOD
 * entry alert to tell a still-actionable LATE ENTRY from one that already played out.
 * `bars` must be date-sorted (the caller sorts once and shares the index space).
 */
export function findTouchExit(
  bars: Bar[],
  fromIndex: number,
  stop: number,
  target: number,
  maxBars: number = TIME_STOP_BARS
): TouchExit | null {
  const end = Math.min(fromIndex + maxBars, bars.length);
  for (let i = Math.max(0, fromIndex); i < end; i++) {
    const hit = exitOnBar(bars[i], stop, target);
    if (hit === "stop") return { kind: "stop", date: bars[i].date, price: stop, barIndex: i };
    if (hit === "target") return { kind: "target", date: bars[i].date, price: target, barIndex: i };
  }
  return null;
}

// ============================================================
// Pure replay — no DB, no network. Deterministic + unit-testable.
// bars must be ASCENDING by date and start at/after the setup's handle_low_date.
// ============================================================

type ReplayResult =
  | { kind: "written"; outcome: OutcomeRow }
  | { kind: "deferred"; reason: string } // resolvable later when more bars exist
  | { kind: "skipped"; reason: string }; // bad geometry / no data — never resolves

export function replaySetup(
  setup: SetupNeedingOutcome,
  bars: Bar[],
  // Exit-scan length. Defaults to the parity constant — callers should NOT pass this
  // (runOutcomeTracker deliberately doesn't). It exists only so the self-test can
  // drive short windows. The eligibility gate's resolutionDays is a DIFFERENT number
  // and must never be threaded in here.
  timeStopBars: number = TIME_STOP_BARS
): ReplayResult {
  const breakout = setup.breakoutLevel;
  const stop = setup.stop;
  const target = setup.target;

  if (breakout == null || stop == null || target == null) {
    return { kind: "skipped", reason: "missing geometry (breakout/stop/target)" };
  }
  if (bars.length === 0) {
    return { kind: "skipped", reason: "no price history returned" };
  }

  // Ensure ascending by date (defensive — Tiingo returns ascending already).
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));

  // --- Fire detection (backtest parity) — delegated to the SHARED detectFire so the
  // paper replay and the EOD entry alert can never disagree. Do not inline this rule
  // again. `sorted` is ordered identically to detectFire's own sort, so fireIndex is
  // a valid index into it.
  const fire = detectFire(sorted, setup.handleLowDate, breakout);

  if (fire.status === "deferred") {
    return { kind: "deferred", reason: fire.reason ?? "confirm window not elapsed" };
  }
  if (fire.status === "never_fired") {
    // Window fully elapsed with no confirming close → terminal: no trade ever
    // happened. Counted, and excluded from R aggregation, on every arm.
    return {
      kind: "written",
      outcome: {
        setupId: setup.id,
        fired: false,
        exitReason: "never_fired",
        rRealized: null,
        outcomeSource: "tiingo_replay",
      },
    };
  }
  const fireIdx = fire.fireIndex as number;

  // --- Entry: next trading day's Open after the fire day. ---
  const entryIdx = fireIdx + 1;
  if (entryIdx >= sorted.length) {
    // Fired on the last available bar — no next-day open yet. Resolve next run.
    return { kind: "deferred", reason: "fired on last available bar; awaiting next-day open" };
  }
  const entry = sorted[entryIdx].open;
  const entryDate = sorted[entryIdx].date;
  const fireDate = sorted[fireIdx].date;

  const risk = entry - stop;
  if (risk <= 0 || target <= entry) {
    // Degenerate geometry: stop at/above the entry open, or target at/below entry
    // (e.g. an opening gap). R would be meaningless — skip rather than fabricate.
    return {
      kind: "skipped",
      reason: `degenerate geometry at entry (entry=${entry.toFixed(2)}, stop=${stop.toFixed(
        2
      )}, target=${target.toFixed(2)})`,
    };
  }

  // --- Forward scan: TIME_STOP_BARS bars FROM ENTRY (the backtest's TIME_STOP_DAYS).
  // Exit test is INTRADAY TOUCH, stop checked first — unchanged, and matching
  // _sim_trade exactly: `if bl <= stop_price: ... ; if bh >= target_price: ...`. ---
  const scanEnd = Math.min(entryIdx + timeStopBars, sorted.length);
  let maxHigh = -Infinity;
  let minLow = Infinity;
  let exitReason: "target" | "stop" | "timeout" | null = null;
  let exitPrice = 0;
  let exitDate = "";
  let rRealized = 0;

  for (let j = entryIdx; j < scanEnd; j++) {
    const bar = sorted[j];
    if (bar.high > maxHigh) maxHigh = bar.high;
    if (bar.low < minLow) minLow = bar.low;

    // Delegated to the SHARED exitOnBar — stop-first ordering IS the tie rule.
    const hit = exitOnBar(bar, stop, target);
    if (hit === "stop") {
      exitReason = "stop";
      exitPrice = stop;
      exitDate = bar.date;
      rRealized = -1; // (stop - entry) / (entry - stop) === -1
      break;
    }
    if (hit === "target") {
      exitReason = "target";
      exitPrice = target;
      exitDate = bar.date;
      rRealized = (target - entry) / risk;
      break;
    }
  }

  if (exitReason === null) {
    const scannedBars = scanEnd - entryIdx;
    if (scannedBars < timeStopBars) {
      // Window not fully elapsed yet (gate approximation was slightly short) —
      // don't lock in a premature 'timeout'. Resolve on a later run.
      return {
        kind: "deferred",
        reason: `only ${scannedBars}/${timeStopBars} forward bars available`,
      };
    }
    // TIME STOP → mark-to-market at the last close in the window.
    const last = sorted[scanEnd - 1];
    exitReason = "timeout";
    exitPrice = last.close;
    exitDate = last.date;
    rRealized = (last.close - entry) / risk;
  }

  const maxFavorablePct = ((maxHigh - entry) / entry) * 100;
  const maxAdversePct = ((minLow - entry) / entry) * 100;

  return {
    kind: "written",
    outcome: {
      setupId: setup.id,
      fired: true,
      fireDate,
      entryPriceActual: entry,
      entryDateActual: entryDate,
      exitPrice,
      exitDate,
      exitReason,
      rRealized,
      maxFavorablePct,
      maxAdversePct,
      outcomeSource: "tiingo_replay",
    },
  };
}

// ============================================================
// Tiingo EOD proxy — reuse the (now-fixed) [ticker] route with the Session B
// startDate + raw params so we get the full post-setup history in unadjusted prices
// (matching nominal breakout/stop/target levels).
//
// EXPORTED because the EOD entry alert needs the SAME daily bars this replay uses —
// official daily closes, never the intraday tngoLast. One fetch path, one source.
// ============================================================

export async function fetchDailyBars(
  base: string,
  ticker: string,
  startDate: string
): Promise<{ bars: Bar[]; error?: string }> {
  const url = `${base}/eod/${encodeURIComponent(ticker)}?startDate=${startDate}&raw=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { bars: [], error: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { bars?: Bar[]; error?: string };
    if (data.error) return { bars: [], error: data.error };
    return { bars: data.bars ?? [] };
  } catch (err) {
    return { bars: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// Summary shape returned by runOutcomeTracker (and the route's HTTP responses).
// ============================================================
export interface OutcomesSummary {
  ok: boolean;
  resolutionDays: number;
  candidates: number; // setups the gate returned
  processed: number; // outcome rows written
  fired: number;
  target: number;
  stop: number;
  timeout: number;
  never_fired: number;
  deferred: number; // not enough data yet — will retry on a later run
  skipped: number; // bad geometry / no history — won't resolve
  assumptions: string[];
  details: Array<{ ticker: string; handleLowDate: string; result: string; note?: string }>;
  message: string;
  error?: string;
}

// ============================================================
// Shared replay core — the SAME work the "UPDATE OUTCOMES" button and the
// scheduled daily job both run. Assumes persistence is available (callers guard)
// and takes an explicit `tiingoBase` (the HTTP route derives it from req headers;
// the scheduled job derives it from JACK_SELF_BASE_URL). Throws on fatal error —
// callers decide how to surface it.
// ============================================================
export async function runOutcomeTracker({
  resolutionDays,
  tiingoBase,
}: {
  resolutionDays: number;
  tiingoBase: string;
}): Promise<OutcomesSummary> {
  // Lazy-load the DB layer so better-sqlite3 stays off Vercel.
  const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
  const dbWrite = require("@/lib/db/write") as typeof import("@/lib/db/write");

  const setups = dbRead.getSetupsNeedingOutcomes(resolutionDays);

  // Fetch histories in parallel (Tiingo), then replay + write sequentially (SQLite).
  const histories = await Promise.all(
    setups.map((s) => fetchDailyBars(tiingoBase, s.ticker, s.handleLowDate))
  );

  const summary: OutcomesSummary = {
    ok: true,
    resolutionDays,
    candidates: setups.length,
    processed: 0,
    fired: 0,
    target: 0,
    stop: 0,
    timeout: 0,
    never_fired: 0,
    deferred: 0,
    skipped: 0,
    assumptions: ASSUMPTION_LABELS,
    details: [],
    message: "",
  };

  for (let i = 0; i < setups.length; i++) {
    const setup = setups[i];
    const hist = histories[i];

    if (hist.error || hist.bars.length === 0) {
      summary.skipped++;
      summary.details.push({
        ticker: setup.ticker,
        handleLowDate: setup.handleLowDate,
        result: "skipped",
        note: hist.error ?? "no bars",
      });
      continue;
    }

    // NO third argument: the replay always runs the parity windows
    // (CONFIRM_WINDOW_BARS / TIME_STOP_BARS). resolutionDays is the ELIGIBILITY gate
    // only — threading it in here is what previously let the fire search run 130 bars
    // wide instead of 15.
    const result = replaySetup(setup, hist.bars);

    if (result.kind === "deferred") {
      summary.deferred++;
      summary.details.push({
        ticker: setup.ticker,
        handleLowDate: setup.handleLowDate,
        result: "deferred",
        note: result.reason,
      });
      continue;
    }
    if (result.kind === "skipped") {
      summary.skipped++;
      summary.details.push({
        ticker: setup.ticker,
        handleLowDate: setup.handleLowDate,
        result: "skipped",
        note: result.reason,
      });
      continue;
    }

    // written
    dbWrite.insertOutcome(result.outcome);
    summary.processed++;
    const reason = result.outcome.exitReason;
    if (result.outcome.fired) summary.fired++;
    if (reason === "target") summary.target++;
    else if (reason === "stop") summary.stop++;
    else if (reason === "timeout") summary.timeout++;
    else if (reason === "never_fired") summary.never_fired++;

    summary.details.push({
      ticker: setup.ticker,
      handleLowDate: setup.handleLowDate,
      result: reason ?? "written",
      note:
        result.outcome.rRealized != null ? `R=${result.outcome.rRealized.toFixed(2)}` : undefined,
    });
  }

  summary.message =
    `${summary.processed}/${summary.candidates} resolved · ` +
    `${summary.target} target · ${summary.stop} stop · ${summary.timeout} timeout · ` +
    `${summary.never_fired} never_fired` +
    (summary.deferred > 0 ? ` · ${summary.deferred} deferred` : "") +
    (summary.skipped > 0 ? ` · ${summary.skipped} skipped` : "") +
    (resolutionDays !== DEFAULT_RESOLUTION_DAYS ? ` · [window=${resolutionDays}d]` : "");

  return summary;
}
