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
 * Note: resolutionDays is the ELIGIBILITY gate ONLY (default DEFAULT_RESOLUTION_DAYS
 * = 130). It does NOT bound anything inside replaySetup: the fire search is
 * CONFIRM_WINDOW_BARS (15) and the exit scan is TIME_STOP_BARS (120), both frozen for
 * backtest parity. 130 > 120 is deliberate — it guarantees the full 120 exit bars
 * exist before a setup is ever considered resolvable.
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
  // DISPLAY ONLY — the combined-book sector cap counts OPEN positions too, so the
  // basket sizer needs the sector of what you already hold.
  sector: string | null;
  tier: string | null;
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
         s.sector                AS sector,
         s.tier                  AS tier,
         o.user_entry_price      AS userEntryPrice,
         o.user_entry_date       AS userEntryDate,
         o.user_exit_price       AS userExitPrice,
         o.user_exit_date        AS userExitDate
       FROM setups s
       -- LEFT JOIN: a setup marked TRADED may have NO outcomes row yet (no fill
       -- logged, replay not run) — it's still an owned position to manage.
       LEFT JOIN outcomes o ON o.setup_id = s.id
       JOIN (
              SELECT setup_id, MAX(id) AS max_id
                FROM decisions
               WHERE user_action = 'TRADED'
               GROUP BY setup_id
            ) latest ON latest.setup_id = s.id
       JOIN decisions dm ON dm.id = latest.max_id
       -- Owned = latest mark TRADED + no logged EXIT. Fill-agnostic: entry fill NOT
       -- required (was: user_entry_price IS NOT NULL). With the LEFT JOIN, a missing
       -- outcomes row leaves user_exit_price NULL → still surfaces as open.
       WHERE o.user_exit_price IS NULL
       ORDER BY o.user_entry_date ASC, s.ticker ASC`
    )
    .all() as OpenPositionRow[];
}

// ============================================================================
// The CURRENT BOARD — the single source of truth for "what JACK is watching now"
//
// The terminal's LIVE/PENDING list is the decisions of the LAST validation run
// (jack-view.tsx renders data.decisions from the last VALIDATE, routed through
// combineJackDecisions). Everything that must agree with the on-screen board —
// above all the alert monitor — reads it from here, run-scoped the same way.
//
// Before this existed, getPendingSetups() took each setup's own MAX(decision id)
// with no run filter, so a setup last seen in a scan weeks ago stayed "pending"
// forever: the terminal never showed it, the alert monitor always did. That was
// the stale-alert bug.
// ============================================================================

export interface CurrentBoardRow {
  decisionId: number;
  setupId: number;
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending";
  decision: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakout: number | null;
  // Latest user mark for the setup (across all runs) + its recorded exit, so
  // callers can apply the SAME owned rule the UI uses (isOwnedPosition in
  // lib/jack/combine-decisions.ts): TRADED and no recorded exit.
  userAction: "TRADED" | "PASSED" | "WATCHED" | null;
  userExitPrice: number | null;
  retiredAt: string | null;
  // DISPLAY ONLY — scanner classification carried through for alert/UI text. These
  // NEVER affect eligibility, scoping, or the owned/retired rules above.
  tier: string | null;
  priority: number | null;
  sizeBucket: string | null;
  sector: string | null;
  handleScore: number | null;
  // Close-confirmed FIRE flag (display status; `section` is unchanged by a fire).
  firedAt: string | null;
  fireClose: number | null;
  fireBar: number | null;
  firedStatus: "confirmed" | "late" | "resolved" | null;
}

/**
 * The validation run the board is showing: the most recent real run that actually
 * INSERTED decisions.
 *
 * Not simply MAX(id): a run whose LLM output failed to parse still writes a
 * validation_runs row with zero decisions. Scoping to it strictly would blank the
 * pending set — and so silence pending alerts — on a fluke parse failure. Falling
 * back to the last good list is the deliberate choice (the terminal shows an error
 * banner + empty board in exactly that case, so nothing is being contradicted).
 * Reference rows (frozen handle_score edges) are excluded, as in getLatestRunSummary.
 */
export function getCurrentRunId(): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT r.id AS id
         FROM validation_runs r
        WHERE r.reference_kind IS NULL
          AND EXISTS (SELECT 1 FROM decisions d WHERE d.validation_run_id = r.id)
        ORDER BY r.id DESC
        LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Every decision row of the current run, split by section — i.e. exactly the rows
 * the terminal is displaying as LIVE/PENDING (before combineJackDecisions moves the
 * owned ones into CURRENT POSITIONS). Empty when no run has produced decisions yet.
 */
export function getCurrentBoard(): { runId: number | null; live: CurrentBoardRow[]; pending: CurrentBoardRow[] } {
  const runId = getCurrentRunId();
  if (runId === null) return { runId: null, live: [], pending: [] };

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         d.id               AS decisionId,
         s.id               AS setupId,
         s.ticker           AS ticker,
         s.handle_low_date  AS handleLowDate,
         d.section          AS section,
         d.decision         AS decision,
         s.entry            AS entry,
         s.stop             AS stop,
         s.t05_target       AS target,
         s.breakout_level   AS breakout,
         s.tier             AS tier,
         s.priority         AS priority,
         s.size_bucket      AS sizeBucket,
         s.sector           AS sector,
         s.handle_score     AS handleScore,
         d.fired_at         AS firedAt,
         d.fire_close       AS fireClose,
         d.fire_bar         AS fireBar,
         d.fired_status     AS firedStatus,
         um.user_action     AS userAction,
         o.user_exit_price  AS userExitPrice,
         s.retired_at       AS retiredAt
       FROM decisions d
       JOIN setups s ON s.id = d.setup_id
       -- outcomes.setup_id is UNIQUE, so this can't fan out the row count.
       LEFT JOIN outcomes o ON o.setup_id = s.id
       -- Latest non-null user mark per setup, across ALL runs (markDecisionUserAction
       -- keeps exactly one marked row per setup, but MAX(id) is the same rule the
       -- other readers use).
       LEFT JOIN (
              SELECT d2.setup_id AS setup_id, d2.user_action AS user_action
                FROM decisions d2
                JOIN (
                       SELECT setup_id, MAX(id) AS max_id
                         FROM decisions
                        WHERE user_action IS NOT NULL
                        GROUP BY setup_id
                     ) l ON l.max_id = d2.id
            ) um ON um.setup_id = s.id
       WHERE d.validation_run_id = ?
       ORDER BY s.ticker ASC`
    )
    .all(runId) as CurrentBoardRow[];

  return {
    runId,
    live: rows.filter((r) => r.section === "live"),
    pending: rows.filter((r) => r.section === "pending"),
  };
}

export interface PendingSetupRow {
  setupId: number;
  /** The CURRENT RUN's decision row for this setup — the row markDecisionFired stamps. */
  decisionId: number;
  ticker: string;
  handleLowDate: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakout: number | null;
  // DISPLAY ONLY (see CurrentBoardRow) — used by the EOD entry alert's message text.
  tier: string | null;
  priority: number | null;
  sizeBucket: string | null;
  sector: string | null;
  handleScore: number | null;
  // Close-confirmed FIRE flag (display status only — never a scoping input).
  firedAt: string | null;
  fireClose: number | null;
  fireBar: number | null;
  firedStatus: "confirmed" | "late" | "resolved" | null;
}

/**
 * The alert-eligible PENDING set — BY CONSTRUCTION the same rows the terminal is
 * showing in its PENDING section. Used by the intraday monitor (entry-trigger +
 * big-move + the IEX ticker batch) and the EOD earnings check.
 *
 *   current run's pending decisions
 *     − currently-OWNED setups (latest mark TRADED and NO recorded exit — the same
 *       rule as isOwnedPosition, which routes those rows to CURRENT POSITIONS)
 *     − retired setups (belt-and-braces; a current-run setup is always un-retired
 *       by retireSupersededSetups, so this can only ever be a no-op)
 *
 * Note the owned rule is *currently owned*, not *ever traded*: a setup that was
 * traded, exited, and is firing again this week is back on the board and back in
 * alerts, matching the display.
 *
 * INTENDED BEHAVIOUR — do not "fix" this as a regression: because the set is scoped
 * to the last run, an ad-hoc small VALIDATE (pasting a 3-ticker CSV to re-check
 * something) shrinks the alert pending-set to those 3 tickers. That is the point —
 * alerts observe exactly what the board shows, whatever the board shows. Re-running
 * the full weekly CSV restores the full set. Open positions are unaffected either
 * way; they come from getOpenPositions(), which is deliberately NOT run-scoped.
 *
 * Geometry may be null (CSVs without levels) — callers that need a level skip those.
 */
export function getPendingSetups(): PendingSetupRow[] {
  const { pending } = getCurrentBoard();
  return pending
    .filter((r) => !(r.userAction === "TRADED" && r.userExitPrice == null))
    .filter((r) => r.retiredAt == null)
    .map((r) => ({
      setupId: r.setupId,
      decisionId: r.decisionId,
      ticker: r.ticker,
      handleLowDate: r.handleLowDate,
      entry: r.entry,
      stop: r.stop,
      target: r.target,
      breakout: r.breakout,
      tier: r.tier,
      priority: r.priority,
      sizeBucket: r.sizeBucket,
      sector: r.sector,
      handleScore: r.handleScore,
      firedAt: r.firedAt,
      fireClose: r.fireClose,
      fireBar: r.fireBar,
      firedStatus: r.firedStatus,
    }));
}

export interface FiredFlag {
  firedAt: string;
  fireClose: number | null;
  fireBar: number | null;
  firedStatus: "confirmed" | "late" | "resolved";
}

/**
 * Fire flags for the board's re-hydration path, keyed by setup_id. Read-only.
 *
 * Resolved PER SETUP (latest non-null fired_at across all of the setup's decision
 * rows), NOT per current-run decision row. That matters: a weekly re-VALIDATE inserts
 * FRESH decision rows with fired_at NULL, and the EOD entry loop's once-per-setup Redis
 * marker stops it from re-stamping — so a per-row read would drop the badge every
 * Friday. The flag belongs to the setup's lifetime, so it is read that way.
 *
 * Display only — never an input to scoping, eligibility, or the owned/retired rules.
 */
export function getFiredFlagsForSetups(setupIds: number[]): Map<number, FiredFlag> {
  const flags = new Map<number, FiredFlag>();
  if (setupIds.length === 0) return flags;

  const db = getDb();
  const placeholders = setupIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT d.setup_id AS setupId, d.fired_at AS firedAt, d.fire_close AS fireClose,
              d.fire_bar AS fireBar, d.fired_status AS firedStatus
         FROM decisions d
         JOIN (
                SELECT setup_id, MAX(id) AS max_id
                  FROM decisions
                 WHERE fired_at IS NOT NULL AND setup_id IN (${placeholders})
                 GROUP BY setup_id
              ) latest ON latest.max_id = d.id`
    )
    .all(...setupIds) as Array<{ setupId: number } & FiredFlag>;

  for (const r of rows) {
    flags.set(r.setupId, {
      firedAt: r.firedAt,
      fireClose: r.fireClose,
      fireBar: r.fireBar,
      firedStatus: r.firedStatus,
    });
  }
  return flags;
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

/**
 * Setup identity (ticker + handle low date) for a setup id.
 *
 * Alert markers are keyed on setup IDENTITY, not on the numeric id, so any caller that
 * needs to touch one — e.g. the fill-write reconciliation that clears a stale
 * `ran_to_target` when a setup flips not-owned → owned — has to resolve it first.
 * Read-only, single row, no joins.
 */
export function getSetupIdentity(setupId: number): { ticker: string; handleLowDate: string } | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT ticker AS ticker, handle_low_date AS handleLowDate FROM setups WHERE id = ?`)
    .get(setupId) as { ticker: string; handleLowDate: string } | undefined;
  return row ?? null;
}
