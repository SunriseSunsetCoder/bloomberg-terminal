import { getDb } from "./init";

export interface SetupSeen {
  ticker: string;
  handleLowDate: string;
  signalDate?: string;
  status: string;
  entry?: number;
  stop?: number;
  t05Target?: number;
  breakoutLevel?: number;
  cupDepthPct?: number;
  handleRetrPct?: number;
  // handle_score signal — the validated CwH handle-quality score (0..1) and its
  // sizing directive (full/half/skip). Read from the weekly CSV or recomputed from
  // frozen thresholds. Additive; a setup without them just isn't score-ranked.
  handleScore?: number;
  sizeBucket?: string;
  // Scanner classification columns — additive, persisted on the setup row.
  sector?: string; // GICS sector name
  tier?: string; // handle quintile Q3/Q4/Q5
  priority?: number; // scanner rank, higher = take first
  // Phase 3 entry-freshness stamp. TIME-DERIVED, so these REFRESH on every
  // ingest — see the idiom note in upsertSetup. Undefined when the CSV was not
  // stamped (a manual paste), which clears the column rather than preserving a
  // stale label.
  entryStatus?: string;
  confirmedCloseDate?: string;
  daysSinceConfirm?: number;
}

export interface ValidationRunRow {
  timestamp: string;
  inputRowCount: number;
  totalFinalCount: number;
  liveFinalCount: number;
  pendingFinalCount: number;
  liveDroppedStale: number;
  pendingDroppedStale: number;
  liveDroppedOverCap: number;
  pendingDroppedOverCap: number;
  tiingoAttempted: number;
  tiingoSucceeded: number;
  riskPerTrade: number;
  tokensInput?: number;
  tokensOutput?: number;
  model?: string;
  rawMarkdown?: string;
  parseSuccess: boolean;
  errorMsg?: string;
}

export interface DecisionRow {
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending";
  decision: string;
  shares?: number;
  notional?: number;
  earningsFlag?: string;
  liveCloseDeltaPct?: number;
  pctToBreakout?: number;
  newsClass?: string;
  sectorRs?: string;
  crossAsset?: string;
  notes?: string;
}

// Normalize status string to schema allowed values, defaulting to 'unknown'
function normalizeStatus(s: string): string {
  const clean = (s ?? "").toLowerCase().trim();
  if (clean === "just_fired" || clean === "pending" || clean === "recent_breakout") return clean;
  return "unknown";
}

export function upsertSetup(setup: SetupSeen, seenAt: string): number {
  const db = getDb();
  const status = normalizeStatus(setup.status);

  const existing = db
    .prepare(`SELECT id FROM setups WHERE ticker = ? AND handle_low_date = ?`)
    .get(setup.ticker, setup.handleLowDate) as { id: number } | undefined;

  if (existing) {
    // Refresh last-seen, and backfill geometry where it's still NULL. Geometry
    // (entry/stop/target/breakout) is what the Session B outcome replay needs; a
    // setup first seen before geometry was captured gets it filled here on a later
    // sighting. COALESCE(existing, new) is additive — never overwrites a real value.
    db.prepare(
      `UPDATE setups SET
         last_seen_at     = ?,
         last_seen_status = ?,
         entry            = COALESCE(entry, ?),
         stop             = COALESCE(stop, ?),
         t05_target       = COALESCE(t05_target, ?),
         breakout_level   = COALESCE(breakout_level, ?),
         cup_depth_pct    = COALESCE(cup_depth_pct, ?),
         handle_retr_pct  = COALESCE(handle_retr_pct, ?),
         handle_score     = COALESCE(?, handle_score),
         size_bucket      = COALESCE(?, size_bucket),
         sector           = COALESCE(?, sector),
         tier             = COALESCE(?, tier),
         priority         = COALESCE(?, priority),
         -- ------------------------------------------------------------------
         -- FRESHNESS COLUMNS: PLAIN OVERWRITE. Three idioms live in this one
         -- statement and the difference is load-bearing:
         --
         --   COALESCE(existing, ?)  geometry — WRITE-ONCE. The stored rim/stop
         --                          wins; a new value only backfills a NULL.
         --   COALESCE(?, existing)  score/sector — new wins WHEN NON-NULL, the
         --                          old value survives a null.
         --   = ?                    freshness — NEW ALWAYS WINS, null included.
         --
         -- entry_status is time-derived: a setup that was FRESH last night is
         -- AGING tonight (the capital-deferral case — a fire you could not fund
         -- stays joinable-as-pullback). Either COALESCE would break that. The
         -- write-once idiom would freeze the first stamp forever, so every row
         -- would read FRESH until it fell off the watchlist. The
         -- COALESCE(?, existing) idiom looks right and is subtly wrong: it
         -- preserves the OLD stamp whenever the new value is null, which is
         -- exactly what a manually pasted UNSTAMPED csv produces — leaving a
         -- days-old FRESH on the board reading as "takeable at the next open".
         --
         -- A plain overwrite makes an unstamped ingest clear the label to NULL.
         -- NULL is honest ("not stamped"); a stale FRESH is a false actionable.
         -- On the nightly path the distinction never arises: the stamper is
         -- total and always supplies a label for every row.
         entry_status         = ?,
         confirmed_close_date = ?,
         days_since_confirm   = ?
       WHERE id = ?`
    ).run(
      seenAt,
      status,
      setup.entry ?? null,
      setup.stop ?? null,
      setup.t05Target ?? null,
      setup.breakoutLevel ?? null,
      setup.cupDepthPct ?? null,
      setup.handleRetrPct ?? null,
      setup.handleScore ?? null,
      setup.sizeBucket ?? null,
      setup.sector ?? null,
      setup.tier ?? null,
      setup.priority ?? null,
      setup.entryStatus ?? null,
      setup.confirmedCloseDate ?? null,
      setup.daysSinceConfirm ?? null,
      existing.id
    );
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO setups (
         ticker, handle_low_date, signal_date,
         first_seen_at, last_seen_at,
         first_seen_status, last_seen_status,
         entry, stop, t05_target, breakout_level,
         cup_depth_pct, handle_retr_pct,
         handle_score, size_bucket,
         sector, tier, priority,
         entry_status, confirmed_close_date, days_since_confirm
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      setup.ticker,
      setup.handleLowDate,
      setup.signalDate ?? null,
      seenAt,
      seenAt,
      status,
      status,
      setup.entry ?? null,
      setup.stop ?? null,
      setup.t05Target ?? null,
      setup.breakoutLevel ?? null,
      setup.cupDepthPct ?? null,
      setup.handleRetrPct ?? null,
      setup.handleScore ?? null,
      setup.sizeBucket ?? null,
      setup.sector ?? null,
      setup.tier ?? null,
      setup.priority ?? null,
      setup.entryStatus ?? null,
      setup.confirmedCloseDate ?? null,
      setup.daysSinceConfirm ?? null
    );

  return Number(result.lastInsertRowid);
}

export function insertValidationRun(row: ValidationRunRow): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO validation_runs (
         timestamp, input_row_count, total_final_count,
         live_final_count, pending_final_count,
         live_dropped_stale, pending_dropped_stale,
         live_dropped_over_cap, pending_dropped_over_cap,
         tiingo_attempted, tiingo_succeeded,
         risk_per_trade,
         tokens_input, tokens_output, model,
         raw_markdown, parse_success, error_msg
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.timestamp,
      row.inputRowCount,
      row.totalFinalCount,
      row.liveFinalCount,
      row.pendingFinalCount,
      row.liveDroppedStale,
      row.pendingDroppedStale,
      row.liveDroppedOverCap,
      row.pendingDroppedOverCap,
      row.tiingoAttempted,
      row.tiingoSucceeded,
      row.riskPerTrade,
      row.tokensInput ?? null,
      row.tokensOutput ?? null,
      row.model ?? null,
      row.rawMarkdown ?? null,
      row.parseSuccess ? 1 : 0,
      row.errorMsg ?? null
    );
  return Number(result.lastInsertRowid);
}

export interface InsertedDecisionId {
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending";
  decisionId: number;
  setupId: number;
}

export function insertDecisions(
  decisions: DecisionRow[],
  validationRunId: number,
  setupIdMap: Map<string, number>
): { inserted: number; skipped: number; ids: InsertedDecisionId[] } {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO decisions (
       setup_id, validation_run_id, section,
       decision, shares, notional,
       earnings_flag, live_close_delta_pct, pct_to_breakout,
       news_class, sector_rs, cross_asset, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let inserted = 0;
  let skipped = 0;
  const ids: InsertedDecisionId[] = [];
  const insertMany = db.transaction((rows: DecisionRow[]) => {
    for (const d of rows) {
      const key = `${d.ticker}|${d.handleLowDate}`;
      const setupId = setupIdMap.get(key);
      if (setupId === undefined) {
        skipped++;
        continue;
      }
      const res = stmt.run(
        setupId,
        validationRunId,
        d.section,
        d.decision,
        d.shares ?? null,
        d.notional ?? null,
        d.earningsFlag ?? null,
        d.liveCloseDeltaPct ?? null,
        d.pctToBreakout ?? null,
        d.newsClass ?? null,
        d.sectorRs ?? null,
        d.crossAsset ?? null,
        d.notes ?? null
      );
      // Surface the decision_id + setup_id so the interactive table can bind row
      // writes (user_action → decisions, user fills → outcomes) to real DB rows.
      ids.push({
        ticker: d.ticker,
        handleLowDate: d.handleLowDate,
        section: d.section,
        decisionId: Number(res.lastInsertRowid),
        setupId,
      });
      inserted++;
    }
  });
  insertMany(decisions);

  return { inserted, skipped, ids };
}

// ============================================================================
// Close-confirmed FIRE flag — board display status, NOT scoping
// ============================================================================

export type FiredStatus = "confirmed" | "late" | "resolved";

export interface FiredMark {
  /** ET date the fire was FIRST detected. */
  firedAt: string;
  fireClose: number;
  /** 1-based bar index within the 15-bar confirm window. */
  fireBar: number;
  firedStatus: FiredStatus;
}

/**
 * Stamp a decision row with the close-confirmed fire detected by the 18:00 EOD pass.
 *
 * SET-ONCE: the `fired_at IS NULL` guard makes this idempotent — the first detection
 * wins and every later pass is a no-op. Returns the number of rows changed (0 when
 * already stamped), so callers can log without re-reading.
 *
 * CRITICAL: this writes DISPLAY STATUS only. `decisions.section` is the scoping key
 * behind getPendingSetups() → the intraday price refresh, the alert ticker batch, and
 * the EOD entry/earnings passes. It is deliberately NOT touched here: flipping a fired
 * setup to 'live' would silently drop it out of the refresh + alert-eligible set.
 */
export function markDecisionFired(decisionId: number, mark: FiredMark): number {
  const db = getDb();
  const apply = db.transaction(() =>
    db
      .prepare(
        `UPDATE decisions
            SET fired_at     = @firedAt,
                fire_close   = @fireClose,
                fire_bar     = @fireBar,
                fired_status = @firedStatus
          WHERE id = @decisionId
            AND fired_at IS NULL`
      )
      .run({ decisionId, ...mark }).changes
  );
  return apply();
}

/**
 * Clear the fire/promotion flag on EVERY decision row of a setup.
 *
 * The counterpart to markDecisionFired, and the mechanism behind the promoter's
 * current-geometry re-derivation: fired state is resolved per SETUP across runs (see
 * getCurrentBoard), so a stamp left by an earlier run keeps a setup in the LIVE display
 * group even after a re-scan revises its rim upward past the close that fired it. That
 * would be a stale fire masquerading as a live idea — off-parity, and exactly what the
 * "re-derive against the CURRENT run's geometry" rule exists to prevent.
 *
 * SAFE TO CLEAR: fired_at/fire_close/fire_bar/fired_status are DISPLAY STATUS ONLY
 * (markDecisionFired's own contract). No outcome, R, or user fill is touched — the
 * paper replay recomputes from bars, and `outcomes` is a separate table. The next pass
 * re-stamps the setup the moment it qualifies again, so this is reversible, not
 * destructive. Returns rows changed (0 when nothing was stamped).
 */
export function clearDecisionFired(setupId: number): number {
  const db = getDb();
  const apply = db.transaction(() =>
    db
      .prepare(
        `UPDATE decisions
            SET fired_at = NULL, fire_close = NULL, fire_bar = NULL, fired_status = NULL
          WHERE setup_id = ?
            AND fired_at IS NOT NULL`
      )
      .run(setupId).changes
  );
  return apply();
}

// ============================================================================
// Watchlist retirement — keeps the pending set from accumulating stale ideas
// ============================================================================

export interface RetireResult {
  retired: number;
  unretired: number;
  /** Setups NOT in this scan that were left alone because they were ever TRADED. */
  protectedTraded: number;
}

/**
 * Retire every setup the new weekly scan no longer carries, so prior watchlist
 * ideas drop out of the pending set (and therefore out of alerts) instead of
 * accumulating forever.
 *
 * Rules:
 *   · UN-RETIRE first — anything present in this scan is live again, so a ticker
 *     that returns after a few quiet weeks comes back cleanly.
 *   · RETIRE the rest, but ONLY setups that were NEVER marked TRADED. An open
 *     position, or a closed (exited) one, is never touched — there is no code path
 *     here by which a real position can be retired.
 *   · Writes to the `setups` table ONLY. decisions.user_action, the outcomes
 *     user-fill columns, and every frozen at-mark column are untouched, so TRADED /
 *     exited state cannot be clobbered by an ingest.
 *
 * Idempotent. Callers should only invoke this for a run that actually produced
 * decisions — a parse-failed run is not the board (see getCurrentRunId), so it must
 * not retire anything either.
 */
export function retireSupersededSetups(
  seenSetupIds: number[],
  runId: number,
  timestamp: string
): RetireResult {
  const db = getDb();
  const seen = [...new Set(seenSetupIds)];
  const placeholders = seen.map(() => "?").join(",");
  // Empty scan → nothing to key retirement off; do nothing rather than retire the
  // whole book.
  if (seen.length === 0) return { retired: 0, unretired: 0, protectedTraded: 0 };

  const everTraded = `NOT EXISTS (
        SELECT 1 FROM decisions d
         WHERE d.setup_id = setups.id AND d.user_action = 'TRADED'
      )`;

  let result: RetireResult = { retired: 0, unretired: 0, protectedTraded: 0 };
  const apply = db.transaction(() => {
    const unretired = db
      .prepare(
        `UPDATE setups
            SET retired_at = NULL, retired_reason = NULL
          WHERE retired_at IS NOT NULL
            AND id IN (${placeholders})`
      )
      .run(...seen).changes;

    const retired = db
      .prepare(
        `UPDATE setups
            SET retired_at = ?, retired_reason = ?
          WHERE retired_at IS NULL
            AND id NOT IN (${placeholders})
            AND ${everTraded}`
      )
      .run(timestamp, `superseded_by_run:${runId}`, ...seen).changes;

    const protectedTraded = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM setups
            WHERE id NOT IN (${placeholders}) AND NOT (${everTraded})`
        )
        .get(...seen) as { c: number }
    ).c;

    result = { retired, unretired, protectedTraded };
  });
  apply();

  return result;
}

// ============================================================================
// Session B (v1.4) — outcome tracking + user fills
// ============================================================================

export interface OutcomeRow {
  setupId: number;
  fired: boolean;
  fireDate?: string | null;
  entryPriceActual?: number | null;
  entryDateActual?: string | null;
  exitPrice?: number | null;
  exitDate?: string | null;
  exitReason?: "target" | "stop" | "timeout" | "still_open" | "never_fired" | null;
  rRealized?: number | null;
  maxFavorablePct?: number | null;
  maxAdversePct?: number | null;
  outcomeSource: string;
}

/**
 * Upsert the THEORETICAL outcome for a setup (from the Tiingo replay).
 *
 * One outcomes row per setup (setup_id UNIQUE). This writes only the theoretical
 * columns; on conflict it updates them in place and PRESERVES any user-fill
 * columns already logged (a trader may have entered fills before the tracker ran).
 * Re-running the tracker refreshes the theoretical outcome without clobbering fills.
 */
export function insertOutcome(o: OutcomeRow): number {
  const db = getDb();
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO outcomes (
         setup_id, fired, fire_date,
         entry_price_actual, entry_date_actual,
         exit_price, exit_date, exit_reason, R_realized,
         max_favorable_pct, max_adverse_pct,
         outcome_computed_at, outcome_source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(setup_id) DO UPDATE SET
         fired               = excluded.fired,
         fire_date           = excluded.fire_date,
         entry_price_actual  = excluded.entry_price_actual,
         entry_date_actual   = excluded.entry_date_actual,
         exit_price          = excluded.exit_price,
         exit_date           = excluded.exit_date,
         exit_reason         = excluded.exit_reason,
         R_realized          = excluded.R_realized,
         max_favorable_pct   = excluded.max_favorable_pct,
         max_adverse_pct     = excluded.max_adverse_pct,
         outcome_computed_at = excluded.outcome_computed_at,
         outcome_source      = excluded.outcome_source`
    )
    .run(
      o.setupId,
      o.fired ? 1 : 0,
      o.fireDate ?? null,
      o.entryPriceActual ?? null,
      o.entryDateActual ?? null,
      o.exitPrice ?? null,
      o.exitDate ?? null,
      o.exitReason ?? null,
      o.rRealized ?? null,
      o.maxFavorablePct ?? null,
      o.maxAdversePct ?? null,
      now,
      o.outcomeSource
    );
  return Number(res.lastInsertRowid);
}

export interface UserFillsResult {
  userRRealized: number | null;
  stop: number | null;
}

/**
 * Upsert the USER-FILL columns for a setup's outcome row (what the trader
 * actually got). Computes user_R_realized = (exit - entry) / (entry - stop)
 * using the setup's stop when entry+exit+stop are all present and entry != stop.
 *
 * UPSERT because fills may be logged BEFORE the theoretical tracker has run for
 * this setup (no outcomes row yet). On a fresh insert we set fired=1 (the trader
 * traded it) and outcome_source='user_fill'; a later theoretical replay overwrites
 * those theoretical fields via insertOutcome() while these user columns persist.
 */
export function updateUserFills(
  setupId: number,
  entry: number | null,
  entryDate: string | null,
  exit: number | null,
  exitDate: string | null
): UserFillsResult {
  const db = getDb();

  const setup = db.prepare(`SELECT stop FROM setups WHERE id = ?`).get(setupId) as
    | { stop: number | null }
    | undefined;
  const stop = setup?.stop ?? null;

  let userR: number | null = null;
  if (entry != null && exit != null && stop != null && entry !== stop) {
    userR = (exit - entry) / (entry - stop);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO outcomes (
       setup_id, fired,
       user_entry_price, user_entry_date, user_exit_price, user_exit_date, user_R_realized,
       outcome_computed_at, outcome_source
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'user_fill')
     ON CONFLICT(setup_id) DO UPDATE SET
       user_entry_price = excluded.user_entry_price,
       user_entry_date  = excluded.user_entry_date,
       user_exit_price  = excluded.user_exit_price,
       user_exit_date   = excluded.user_exit_date,
       user_R_realized  = excluded.user_R_realized`
  ).run(setupId, entry, entryDate, exit, exitDate, userR, now);

  return { userRRealized: userR, stop };
}
