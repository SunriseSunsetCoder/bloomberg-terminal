import { getDb } from "./init";

// =============================================================================
// JACK Session C — read-only analytics query layer.
//
// The decision_outcomes view doesn't carry the columns Session C needs
// (jack_decision_at_mark, user_R_realized, user fills, MFE/MAE, geometry), so we
// join setups + decisions + outcomes directly here. READ-ONLY — no writes, no
// schema changes. One row per setup that has an outcome row.
// =============================================================================

export interface AnalyticsRow {
  setupId: number;
  ticker: string;
  handleLowDate: string; // YYYY-MM-DD — the setup date (used for quarterly bucketing)
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakout: number | null;
  // theoretical replay outcome
  fired: number; // 0/1
  exitReason: string | null; // target/stop/timeout/never_fired/still_open/null
  rRealized: number | null; // THEORETICAL R
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  // handle_score signal — the setup's handle-quality score + sizing directive.
  // Prefer the value FROZEN on the marked decision (the directive live when the
  // trade was decided); fall back to the setup's current value for unmarked
  // resolved setups (so the bucket quintile check still sees every resolved setup).
  handleScore: number | null;
  sizeBucket: string | null; // 'full' | 'half' | 'skip' | null
  // actual user execution
  userAction: "TRADED" | "PASSED" | "WATCHED" | null; // the MARKED action (latest non-null)
  jackDecisionAtMark: string | null; // JACK's verdict frozen at mark time
  userRRealized: number | null; // ACTUAL R
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
}

// =============================================================================
// SCORECARD read (separate from getAnalyticsRows on purpose — Session C's shape is
// load-bearing for the JANLY view and must not shift underneath it).
//
// One row per setup that has an outcomes row, carrying what the performance
// scorecard needs on top of the Session C columns: the scanner classification
// (tier / priority / sector), and the setup's LATEST AI decision with the run it
// came from — so the AI-overlay analysis can group paper outcomes by what the AI
// actually called, and P-rank can be recomputed per run.
// =============================================================================

export interface ScorecardRow {
  setupId: number;
  ticker: string;
  handleLowDate: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakout: number | null;
  // scanner classification
  tier: string | null; // 'Q3' | 'Q4' | 'Q5' | null
  priority: number | null; // raw float; the displayed P-rank is an ordinal (recomputed)
  sector: string | null;
  // theoretical (PAPER) outcome — present for every resolvable setup, traded or not
  fired: number;
  exitReason: string | null;
  rRealized: number | null;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  // handle-score signal (frozen at mark where available)
  handleScore: number | null;
  sizeBucket: string | null;
  // the user's execution
  userAction: "TRADED" | "PASSED" | "WATCHED" | null;
  jackDecisionAtMark: string | null;
  userRRealized: number | null;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
  // LATEST AI decision for this setup (any run) + where it came from
  latestDecision: string | null;
  latestSection: "live" | "pending" | null;
  latestRunId: number | null;
}

/**
 * Scorecard universe: every setup with an outcomes row, plus classification and
 * latest-AI-decision context. Read-only.
 *
 * "Latest AI decision" = the setup's highest decision id (its most recent run).
 * A setup carried across several weekly runs therefore counts ONCE, under the call
 * JACK made most recently — the rule the scorecard states on screen.
 */
export function getScorecardRows(): ScorecardRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         s.id                    AS setupId,
         s.ticker                AS ticker,
         s.handle_low_date       AS handleLowDate,
         s.entry                 AS entry,
         s.stop                  AS stop,
         s.t05_target            AS target,
         s.breakout_level        AS breakout,
         s.tier                  AS tier,
         s.priority              AS priority,
         s.sector                AS sector,
         o.fired                 AS fired,
         o.exit_reason           AS exitReason,
         o.R_realized            AS rRealized,
         o.max_favorable_pct     AS maxFavorablePct,
         o.max_adverse_pct       AS maxAdversePct,
         o.user_R_realized       AS userRRealized,
         o.user_entry_price      AS userEntryPrice,
         o.user_entry_date       AS userEntryDate,
         o.user_exit_price       AS userExitPrice,
         o.user_exit_date        AS userExitDate,
         m.user_action           AS userAction,
         m.jack_decision_at_mark AS jackDecisionAtMark,
         COALESCE(m.handle_score_at_mark, s.handle_score) AS handleScore,
         COALESCE(m.size_bucket_at_mark,  s.size_bucket)  AS sizeBucket,
         ld.decision             AS latestDecision,
         ld.section              AS latestSection,
         ld.validation_run_id    AS latestRunId
       FROM setups s
       JOIN outcomes o ON o.setup_id = s.id
       -- the setup's canonical user mark (latest non-null user_action)
       LEFT JOIN (
         SELECT d.setup_id, d.user_action, d.jack_decision_at_mark,
                d.handle_score_at_mark, d.size_bucket_at_mark
           FROM decisions d
           JOIN (
                  SELECT setup_id, MAX(id) AS max_id
                    FROM decisions
                   WHERE user_action IS NOT NULL
                   GROUP BY setup_id
                ) latest ON d.id = latest.max_id
       ) m ON m.setup_id = s.id
       -- the setup's LATEST AI decision (any run, marked or not)
       LEFT JOIN (
         SELECT d.setup_id, d.decision, d.section, d.validation_run_id
           FROM decisions d
           JOIN (
                  SELECT setup_id, MAX(id) AS max_id
                    FROM decisions
                   GROUP BY setup_id
                ) l ON d.id = l.max_id
       ) ld ON ld.setup_id = s.id
       ORDER BY s.handle_low_date ASC, s.ticker ASC`
    )
    .all() as ScorecardRow[];
}

/**
 * Priority ordinals ("P-rank") recomputed per validation run.
 *
 * The P-rank shown on the board is a RENDER-TIME ordinal — only the raw priority
 * float is persisted — so the scorecard rebuilds it: within each run, LIVE decisions
 * with a non-null priority, ranked by priority DESC (ties broken by ticker for
 * determinism), numbered from 1. The live board additionally skipped rows already
 * marked TRADED, which it cannot do retroactively without rewriting history, so a
 * rank here can sit one or two above what was on screen at the time. Stated on screen.
 *
 * Returns setup_id → rank, keyed by the run that produced the rank (a setup in
 * several runs keeps its rank from its LATEST run, matching latestDecision).
 */
export function getPriorityRanks(): Map<number, number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.validation_run_id AS runId, d.setup_id AS setupId, s.priority AS priority, s.ticker AS ticker
         FROM decisions d
         JOIN setups s ON s.id = d.setup_id
        WHERE d.section = 'live' AND s.priority IS NOT NULL
        ORDER BY d.validation_run_id ASC, s.priority DESC, s.ticker ASC`
    )
    .all() as Array<{ runId: number; setupId: number; priority: number; ticker: string }>;

  const ranks = new Map<number, number>();
  let currentRun = -1;
  let n = 0;
  for (const r of rows) {
    if (r.runId !== currentRun) {
      currentRun = r.runId;
      n = 0;
    }
    n += 1;
    // Later runs overwrite earlier ones → the setup keeps its LATEST run's rank.
    ranks.set(r.setupId, n);
  }
  return ranks;
}

/**
 * One row per setup that has an outcomes row. The marked-decision fields
 * (user_action, jack_decision_at_mark) come from the MOST RECENT decision that
 * carries a non-null user_action for that setup — matching how the v2 UI marks
 * (one canonical mark per setup). Unmarked setups get NULL user_action (they
 * count in the universe, are excluded from selection math downstream).
 */
export function getAnalyticsRows(): AnalyticsRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         s.id                    AS setupId,
         s.ticker                AS ticker,
         s.handle_low_date       AS handleLowDate,
         s.entry                 AS entry,
         s.stop                  AS stop,
         s.t05_target            AS target,
         s.breakout_level        AS breakout,
         o.fired                 AS fired,
         o.exit_reason           AS exitReason,
         o.R_realized            AS rRealized,
         o.max_favorable_pct     AS maxFavorablePct,
         o.max_adverse_pct       AS maxAdversePct,
         o.user_R_realized       AS userRRealized,
         o.user_entry_price      AS userEntryPrice,
         o.user_entry_date       AS userEntryDate,
         o.user_exit_price       AS userExitPrice,
         o.user_exit_date        AS userExitDate,
         m.user_action           AS userAction,
         m.jack_decision_at_mark AS jackDecisionAtMark,
         COALESCE(m.handle_score_at_mark, s.handle_score) AS handleScore,
         COALESCE(m.size_bucket_at_mark,  s.size_bucket)  AS sizeBucket
       FROM setups s
       JOIN outcomes o ON o.setup_id = s.id
       LEFT JOIN (
         SELECT d.setup_id, d.user_action, d.jack_decision_at_mark,
                d.handle_score_at_mark, d.size_bucket_at_mark
           FROM decisions d
           JOIN (
                  SELECT setup_id, MAX(id) AS max_id
                    FROM decisions
                   WHERE user_action IS NOT NULL
                   GROUP BY setup_id
                ) latest
             ON d.id = latest.max_id
       ) m ON m.setup_id = s.id
       ORDER BY s.handle_low_date ASC, s.ticker ASC`
    )
    .all() as AnalyticsRow[];
  return rows;
}
