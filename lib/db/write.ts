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
    db.prepare(
      `UPDATE setups SET last_seen_at = ?, last_seen_status = ? WHERE id = ?`
    ).run(seenAt, status, existing.id);
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO setups (
         ticker, handle_low_date, signal_date,
         first_seen_at, last_seen_at,
         first_seen_status, last_seen_status,
         entry, stop, t05_target, breakout_level,
         cup_depth_pct, handle_retr_pct
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      setup.handleRetrPct ?? null
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

export function insertDecisions(
  decisions: DecisionRow[],
  validationRunId: number,
  setupIdMap: Map<string, number>
): { inserted: number; skipped: number } {
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
  const insertMany = db.transaction((rows: DecisionRow[]) => {
    for (const d of rows) {
      const key = `${d.ticker}|${d.handleLowDate}`;
      const setupId = setupIdMap.get(key);
      if (setupId === undefined) {
        skipped++;
        continue;
      }
      stmt.run(
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
      inserted++;
    }
  });
  insertMany(decisions);

  return { inserted, skipped };
}
