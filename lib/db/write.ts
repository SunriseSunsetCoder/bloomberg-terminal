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
         priority         = COALESCE(?, priority)
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
         sector, tier, priority
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      setup.priority ?? null
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
