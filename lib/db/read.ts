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
    .prepare(
      // Exclude bookkeeping reference rows (frozen handle_score edges) — those are
      // not real validation runs and must never surface as "the latest run".
      `SELECT id, timestamp, parse_success FROM validation_runs
         WHERE reference_kind IS NULL
         ORDER BY id DESC LIMIT 1`
    )
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
  // Frozen decision-time context (from the marked decision row) — JACK's verdict
  // and share size AS THEY WERE when the user marked, independent of later re-runs.
  jackDecisionAtMark: string | null;
  sharesAtMark: number | null;
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

  // Latest non-null user_action per setup (highest decision id wins). Also pull
  // the frozen decision-time context (jack_decision_at_mark, shares) from that row.
  const actionRows = db
    .prepare(
      `SELECT d.setup_id AS setup_id, d.user_action AS user_action,
              d.jack_decision_at_mark AS jack_decision_at_mark, d.shares AS shares
         FROM decisions d
         JOIN (
                SELECT setup_id, MAX(id) AS max_id
                  FROM decisions
                 WHERE user_action IS NOT NULL AND setup_id IN (${placeholders})
                 GROUP BY setup_id
              ) latest
           ON d.id = latest.max_id`
    )
    .all(...setupIds) as Array<{
    setup_id: number;
    user_action: UserMark["userAction"];
    jack_decision_at_mark: string | null;
    shares: number | null;
  }>;

  for (const r of actionRows) {
    marks.set(r.setup_id, {
      userAction: r.user_action,
      userEntryPrice: null,
      userEntryDate: null,
      userExitPrice: null,
      userExitDate: null,
      jackDecisionAtMark: r.jack_decision_at_mark,
      sharesAtMark: r.shares,
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
      jackDecisionAtMark: null,
      sharesAtMark: null,
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

export interface OpenPositionRow {
  setupId: number;
  decisionId: number;
  ticker: string;
  handleLowDate: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakout: number | null;
  shares: number | null;
  jackDecisionAtMark: string | null;
  jackAnalysisAtMark: string | null;
  handleScore: number | null;
  sizeBucket: string | null;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
}

/**
 * Every open position — a setup marked TRADED with an entry logged but NO exit yet
 * — REGARDLESS of whether it appears in the current validation run. Lets an open
 * trade (e.g. GLNG marked TRADED weeks ago, not firing this week) stay reachable so
 * the user can still record its exit. Read-only. Fill writes reuse updateUserFills.
 *
 * Uses the setup's LATEST TRADED decision (frozen verdict + shares) + its outcomes
 * user-fill columns. Open = user_entry_price present AND user_exit_price NULL.
 */
export function getOpenPositions(): OpenPositionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         s.id                    AS setupId,
         dm.id                   AS decisionId,
         s.ticker                AS ticker,
         s.handle_low_date       AS handleLowDate,
         s.entry                 AS entry,
         s.stop                  AS stop,
         s.t05_target            AS target,
         s.breakout_level        AS breakout,
         dm.shares               AS shares,
         dm.jack_decision_at_mark AS jackDecisionAtMark,
         dm.jack_analysis_at_mark AS jackAnalysisAtMark,
         s.handle_score          AS handleScore,
         s.size_bucket           AS sizeBucket,
         o.user_entry_price      AS userEntryPrice,
         o.user_entry_date       AS userEntryDate,
         o.user_exit_price       AS userExitPrice,
         o.user_exit_date        AS userExitDate
       FROM setups s
       JOIN outcomes o ON o.setup_id = s.id
       JOIN (
              SELECT setup_id, MAX(id) AS max_id
                FROM decisions
               WHERE user_action = 'TRADED'
               GROUP BY setup_id
            ) latest ON latest.setup_id = s.id
       JOIN decisions dm ON dm.id = latest.max_id
       WHERE o.user_entry_price IS NOT NULL AND o.user_exit_price IS NULL
       ORDER BY o.user_entry_date ASC, s.ticker ASC`
    )
    .all() as OpenPositionRow[];
}

export function markDecisionUserAction(
  decisionId: number,
  action: "TRADED" | "PASSED" | "WATCHED",
  userNotes?: string
): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Re-mark = UPDATE per setup (JACK UI v2 §3 data contract). Each VALIDATE inserts
  // a fresh decision row per run, so marking across runs could otherwise leave
  // several marked rows for one setup (the duplicate-GLNG behaviour). Guarantee
  // exactly ONE marked decision per setup by clearing any prior marks on the
  // setup's other rows, then setting this one. This is an UPDATE, never an INSERT.
  const row = db.prepare(`SELECT setup_id FROM decisions WHERE id = ?`).get(decisionId) as
    | { setup_id: number }
    | undefined;

  const apply = db.transaction(() => {
    if (row) {
      db.prepare(
        `UPDATE decisions SET user_action = NULL, user_action_at = NULL
           WHERE setup_id = ? AND id != ? AND user_action IS NOT NULL`
      ).run(row.setup_id, decisionId);
    }
    // Freeze JACK's verdict AND its analysis text as they were at mark time (this
    // row's live `decision` + `notes`), so a later re-VALIDATE flipping the verdict
    // or reasoning doesn't rewrite the decision-time context. jack_analysis_at_mark
    // is the immutable "why I entered" thesis shown on the Current Positions row;
    // the live position-management re-read is computed separately and never touches
    // it. Session C reads jack_decision_at_mark.
    db.prepare(
      `UPDATE decisions
          SET user_action = ?, user_action_at = ?, user_notes = ?,
              jack_decision_at_mark = decision,
              jack_analysis_at_mark = notes,
              -- Freeze the setup's handle_score + size_bucket AS THEY ARE at mark
              -- time. Unlike jack_decision_at_mark (frozen from this row's own live
              -- decision column), the score lives on the setup, so freeze from there.
              -- This is the forward-test anchor: the sizing directive that was live
              -- when the trade was decided, immune to later re-ingest re-scoring.
              handle_score_at_mark = (SELECT handle_score FROM setups WHERE id = decisions.setup_id),
              size_bucket_at_mark  = (SELECT size_bucket  FROM setups WHERE id = decisions.setup_id)
        WHERE id = ?`
    ).run(action, now, userNotes ?? null, decisionId);
  });
  apply();
}
