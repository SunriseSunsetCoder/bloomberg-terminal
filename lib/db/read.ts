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

export interface UserMark {
  userAction: "TRADED" | "PASSED" | "WATCHED" | null;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
}

/**
 * Existing user marks (action + fills) for a set of setups, so the interactive
 * table can re-hydrate them after a re-VALIDATE (Bug A). Read-only.
 *
 * user_action is per-decision (one row per run); we take the MOST RECENT non-null
 * user_action across all of a setup's decision rows. Fills live once per setup on
 * the outcomes row. Returns a map keyed by setup_id; setups with no marks are absent.
 */
export function getUserMarksForSetups(setupIds: number[]): Map<number, UserMark> {
  const marks = new Map<number, UserMark>();
  if (setupIds.length === 0) return marks;

  const db = getDb();
  const placeholders = setupIds.map(() => "?").join(",");

  // Latest non-null user_action per setup (highest decision id wins).
  const actionRows = db
    .prepare(
      `SELECT d.setup_id AS setup_id, d.user_action AS user_action
         FROM decisions d
         JOIN (
                SELECT setup_id, MAX(id) AS max_id
                  FROM decisions
                 WHERE user_action IS NOT NULL AND setup_id IN (${placeholders})
                 GROUP BY setup_id
              ) latest
           ON d.id = latest.max_id`
    )
    .all(...setupIds) as Array<{ setup_id: number; user_action: UserMark["userAction"] }>;

  for (const r of actionRows) {
    marks.set(r.setup_id, {
      userAction: r.user_action,
      userEntryPrice: null,
      userEntryDate: null,
      userExitPrice: null,
      userExitDate: null,
    });
  }

  // User fills from the (single) outcomes row per setup.
  const fillRows = db
    .prepare(
      `SELECT setup_id, user_entry_price, user_entry_date, user_exit_price, user_exit_date
         FROM outcomes
        WHERE setup_id IN (${placeholders})`
    )
    .all(...setupIds) as Array<{
    setup_id: number;
    user_entry_price: number | null;
    user_entry_date: string | null;
    user_exit_price: number | null;
    user_exit_date: string | null;
  }>;

  for (const r of fillRows) {
    const existing = marks.get(r.setup_id) ?? {
      userAction: null,
      userEntryPrice: null,
      userEntryDate: null,
      userExitPrice: null,
      userExitDate: null,
    };
    marks.set(r.setup_id, {
      ...existing,
      userEntryPrice: r.user_entry_price,
      userEntryDate: r.user_entry_date,
      userExitPrice: r.user_exit_price,
      userExitDate: r.user_exit_date,
    });
  }

  return marks;
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
