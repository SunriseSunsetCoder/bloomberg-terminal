import { getDb } from "./init";

export function countValidationRuns(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM validation_runs`).get() as { c: number };
  return row.c;
}

export function countSetups(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM setups`).get() as { c: number };
  return row.c;
}

export function countDecisions(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM decisions`).get() as { c: number };
  return row.c;
}

export function getLatestRunSummary(): {
  runId: number;
  timestamp: string;
  liveDecisions: number;
  pendingDecisions: number;
  parseSuccess: boolean;
} | null {
  const db = getDb();
  const run = db
    .prepare(`SELECT id, timestamp, parse_success FROM validation_runs ORDER BY id DESC LIMIT 1`)
    .get() as { id: number; timestamp: string; parse_success: number } | undefined;
  if (!run) return null;

  const counts = db
    .prepare(
      `SELECT section, COUNT(*) AS c
       FROM decisions WHERE validation_run_id = ?
       GROUP BY section`
    )
    .all(run.id) as Array<{ section: string; c: number }>;

  const live = counts.find((c) => c.section === "live")?.c ?? 0;
  const pending = counts.find((c) => c.section === "pending")?.c ?? 0;

  return {
    runId: run.id,
    timestamp: run.timestamp,
    liveDecisions: live,
    pendingDecisions: pending,
    parseSuccess: run.parse_success === 1,
  };
}

export interface SetupNeedingOutcome {
  id: number;
  ticker: string;
  handleLowDate: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakoutLevel: number | null;
}

/**
 * Setups that are ready for a THEORETICAL outcome replay and don't have one yet.
 *
 * A setup qualifies when:
 *   - its handle_low_date is old enough that a full resolution window has elapsed
 *     (resolutionDays TRADING days; we gate with a conservative calendar
 *     approximation — ~1.5 calendar days per trading day — so we never resolve a
 *     setup prematurely and lock in a wrong 'timeout'), AND
 *   - it carries the geometry the replay needs (breakout_level + stop + target),
 *     AND
 *   - it has no theoretical outcome yet: either no outcomes row at all, or a row
 *     that only holds user fills (exit_reason IS NULL). A user-fills-only row must
 *     still get its theoretical outcome computed.
 *
 * Note: resolutionDays is the same window used by the forward scan in the replay
 * (default 90). Do NOT hardcode a different number — the gate and the scan must match.
 */
export function getSetupsNeedingOutcomes(resolutionDays = 90): SetupNeedingOutcome[] {
  const db = getDb();

  // Conservative trading-day → calendar-day gate. 90 trading days ≈ 126 calendar
  // days of weekends + ~7 of holidays ≈ 133; 1.5× (135) keeps us safely past that
  // so we don't prematurely resolve. The precise trading-day counting happens on
  // real Tiingo bars inside the replay.
  const calendarDays = Math.ceil(resolutionDays * 1.5);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - calendarDays);
  const cutoffIso = cutoff.toISOString().split("T")[0];

  const rows = db
    .prepare(
      `SELECT s.id, s.ticker, s.handle_low_date, s.entry, s.stop, s.t05_target, s.breakout_level
         FROM setups s
        WHERE s.handle_low_date <= @cutoff
          AND s.breakout_level IS NOT NULL
          AND s.stop           IS NOT NULL
          AND s.t05_target     IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM outcomes o
                 WHERE o.setup_id = s.id AND o.exit_reason IS NOT NULL
              )
        ORDER BY s.handle_low_date ASC`
    )
    .all({ cutoff: cutoffIso }) as Array<{
    id: number;
    ticker: string;
    handle_low_date: string;
    entry: number | null;
    stop: number | null;
    t05_target: number | null;
    breakout_level: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    ticker: r.ticker,
    handleLowDate: r.handle_low_date,
    entry: r.entry,
    stop: r.stop,
    target: r.t05_target,
    breakoutLevel: r.breakout_level,
  }));
}

export function markDecisionUserAction(
  decisionId: number,
  action: "TRADED" | "PASSED" | "WATCHED",
  userNotes?: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE decisions SET user_action = ?, user_action_at = ?, user_notes = ? WHERE id = ?`
  ).run(action, new Date().toISOString(), userNotes ?? null, decisionId);
}
