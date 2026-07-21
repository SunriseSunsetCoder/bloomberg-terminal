import { NextRequest, NextResponse } from "next/server";
// Type-only imports compile away — safe on Vercel where the DB layer never loads.
import type { SetupNeedingOutcome } from "@/lib/db/read";
import type { OutcomeRow } from "@/lib/db/write";
// Concrete DB functions are loaded lazily via require() inside the handler so
// better-sqlite3 (native) is never required on Vercel (isPersistenceAvailable() === false).
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";

export const maxDuration = 120; // parallel Tiingo history fetches for many setups
export const dynamic = "force-dynamic";

// ============================================================
// Resolution window — TRADING days. Same value gates "is this setup old enough
// to resolve?" AND bounds the forward scan. Never hardcode a different number in
// one place than the other. Set to 130 (≥120) so the strategy's full 120-trading-
// day time stop is captured; the scheduled job imports THIS exact constant so the
// job and the manual button always run an identical window.
// ============================================================
export const DEFAULT_RESOLUTION_DAYS = 130;

// ---- Modeling assumptions (documented, surfaced in the summary) ----
//  1. TIE (stop and target both touched on the same bar) → assume STOP first.
//     Conservative: we can't see intrabar sequence in daily OHLC, so we assume
//     the worse outcome.
//  2. TIMEOUT (neither stop nor target hit within the window) → mark-to-market:
//     exit at the last close in the window, R = (close - entry) / (entry - stop).
const ASSUMPTION_LABELS = [
  "tie=stop-first (same-bar stop+target → stop, conservative — daily bars hide intrabar order)",
  "timeout=mark-to-market (neither hit in window → exit at last close, R from that close)",
];

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  resolutionDays: number
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

  // --- Fire detection: first bar (within resolutionDays of handle_low_date)
  // whose High >= breakout_level. fire_date == handle_low_date is common. ---
  const fireWindow = Math.min(resolutionDays, sorted.length);
  let fireIdx = -1;
  for (let i = 0; i < fireWindow; i++) {
    if (sorted[i].high >= breakout) {
      fireIdx = i;
      break;
    }
  }

  if (fireIdx === -1) {
    // Never fired within the window → no trade. Excluded from R aggregation later.
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

  // --- Forward scan: up to resolutionDays bars FROM ENTRY (window matches the gate). ---
  const scanEnd = Math.min(entryIdx + resolutionDays, sorted.length);
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

    const stopHit = bar.low <= stop;
    const targetHit = bar.high >= target;

    if (stopHit && targetHit) {
      // TIE → assume STOP first (conservative modeling assumption #1).
      exitReason = "stop";
      exitPrice = stop;
      exitDate = bar.date;
      rRealized = -1;
      break;
    }
    if (stopHit) {
      exitReason = "stop";
      exitPrice = stop;
      exitDate = bar.date;
      rRealized = -1; // (stop - entry) / (entry - stop) === -1
      break;
    }
    if (targetHit) {
      exitReason = "target";
      exitPrice = target;
      exitDate = bar.date;
      rRealized = (target - entry) / risk;
      break;
    }
  }

  if (exitReason === null) {
    const scannedBars = scanEnd - entryIdx;
    if (scannedBars < resolutionDays) {
      // Window not fully elapsed yet (gate approximation was slightly short) —
      // don't lock in a premature 'timeout'. Resolve on a later run.
      return {
        kind: "deferred",
        reason: `only ${scannedBars}/${resolutionDays} forward bars available`,
      };
    }
    // TIMEOUT → mark-to-market at the last close in the window (assumption #2).
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
// Internal Tiingo EOD proxy — reuse the (now-fixed) [ticker] route with the
// Session B startDate + raw params so we get the full post-setup history in
// unadjusted prices (matching nominal breakout/stop/target levels).
// ============================================================

function tiingoBaseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/api/tiingo`;
}

async function fetchHistory(
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
// POST — run the outcome tracker over all setups needing outcomes.
// ============================================================

interface OutcomesSummary {
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
    setups.map((s) => fetchHistory(tiingoBase, s.ticker, s.handleLowDate))
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

    const result = replaySetup(setup, hist.bars, resolutionDays);

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

export async function POST(req: NextRequest) {
  // Vercel guard — never touch the DB layer when persistence is off.
  if (!isPersistenceAvailable()) {
    return NextResponse.json<OutcomesSummary>(
      {
        ok: false,
        resolutionDays: DEFAULT_RESOLUTION_DAYS,
        candidates: 0,
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
        message: `Persistence ${persistenceUnavailableReason()} — outcome tracking runs on the VPS only.`,
        error: persistenceUnavailableReason(),
      },
      { status: 200 }
    );
  }

  // Optional resolutionDays override (smoke tests use a smaller window so
  // not-yet-90-day-old setups resolve). Defaults to 90 — no code edit needed.
  let resolutionDays = DEFAULT_RESOLUTION_DAYS;
  try {
    const body = (await req.json().catch(() => ({}))) as { resolutionDays?: number };
    if (typeof body.resolutionDays === "number" && body.resolutionDays > 0) {
      resolutionDays = Math.floor(body.resolutionDays);
    }
  } catch {
    // no body — use default
  }

  try {
    const summary = await runOutcomeTracker({ resolutionDays, tiingoBase: tiingoBaseUrl(req) });
    return NextResponse.json<OutcomesSummary>(summary, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<OutcomesSummary>(
      {
        ok: false,
        resolutionDays,
        candidates: 0,
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
        message: `Outcome tracker failed: ${msg}`,
        error: msg,
      },
      { status: 500 }
    );
  }
}
