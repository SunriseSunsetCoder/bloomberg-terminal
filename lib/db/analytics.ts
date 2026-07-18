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
