import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  HANDLE_SCORE_REFERENCE_KIND,
  handleScoreReferenceJson,
} from "@/lib/jack/handle-score";

let db: Database.Database | null = null;

function resolveDbPath(): string {
  const envPath = process.env.JACK_DB_PATH;
  if (envPath && envPath.length > 0) return envPath;
  return join(process.cwd(), "data", "jack.db");
}

function resolveSchemaPath(): string {
  return join(process.cwd(), "lib", "db", "schema.sql");
}

export function getDb(): Database.Database {
  if (db !== null) return db;

  const dbPath = resolveDbPath();
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  // Assign to local first, then module-level — helps TS narrow correctly.
  const newDb = new Database(dbPath);
  newDb.pragma("journal_mode = WAL");
  newDb.pragma("synchronous = NORMAL");
  newDb.pragma("foreign_keys = ON");
  // busy_timeout: when the write lock is momentarily held by another connection
  // (a second dev-server worker's own better-sqlite3 handle, an external DBeaver
  // session, or a WAL checkpoint), wait up to 5s for it to free instead of
  // throwing SQLITE_BUSY immediately. Without this, a concurrent write — e.g. a
  // JACK fill-save landing while a validation run is mid-write — fails outright
  // and the fill silently doesn't persist. WAL (above) already lets readers not
  // block the writer; busy_timeout is what makes competing WRITES queue.
  newDb.pragma("busy_timeout = 5000");

  const schemaSql = readFileSync(resolveSchemaPath(), "utf-8");
  newDb.exec(schemaSql);

  // Additive migrations for DBs created before a column existed. schema.sql uses
  // CREATE TABLE IF NOT EXISTS, so new columns added to an existing table's CREATE
  // are NOT applied to an already-created DB (e.g. the live VPS jack.db). SQLite has
  // no "ADD COLUMN IF NOT EXISTS", so we introspect and ALTER only what's missing.
  // Additive-only: never drops or alters existing columns.
  runMigrations(newDb);

  db = newDb;
  return newDb;
}

/**
 * Idempotent additive migrations. Safe to run on every open.
 */
function runMigrations(database: Database.Database): void {
  ensureColumns(database, "outcomes", [
    { name: "user_entry_price", def: "REAL" },
    { name: "user_entry_date", def: "TEXT" },
    { name: "user_exit_price", def: "REAL" },
    { name: "user_exit_date", def: "TEXT" },
    { name: "user_R_realized", def: "REAL" },
  ]);
  ensureColumns(database, "decisions", [
    { name: "jack_decision_at_mark", def: "TEXT" },
    // Frozen entry THESIS — JACK's analysis text as it was when the user marked
    // TRADED. The "why I entered" note, immutable across later re-VALIDATEs. The
    // live re-read (position management) is computed fresh and never overwrites this.
    { name: "jack_analysis_at_mark", def: "TEXT" },
    // handle_score forward-validation: the setup's handle_score + size_bucket
    // FROZEN at the moment the user marked this decision (mirrors
    // jack_decision_at_mark). Lets the forward-test analytics join a REALIZED
    // outcome to the sizing directive that was live when the trade was decided —
    // even if the setup is later re-ingested with a refreshed score.
    { name: "handle_score_at_mark", def: "REAL" },
    { name: "size_bucket_at_mark", def: "TEXT" },
  ]);
  // handle_score signal (additive): the validated CwH handle-quality score + its
  // sizing directive, carried on every setup. Read from the weekly watchlist CSV
  // (primary) or recomputed from frozen thresholds (fallback).
  ensureColumns(database, "setups", [
    { name: "handle_score", def: "REAL" },
    { name: "size_bucket", def: "TEXT" },
    // Scanner classification columns (additive): GICS sector name, handle quintile
    // tier (Q3/Q4/Q5), and a float priority rank (higher = take first).
    { name: "sector", def: "TEXT" },
    { name: "tier", def: "TEXT" },
    { name: "priority", def: "REAL" },
  ]);
  // Reference-row support on validation_runs: a non-run bookkeeping row that stores
  // the FROZEN hscore_edges + size map as auditable JSON, so the thresholds behind
  // any sizing decision can be recovered from the DB alone. reference_kind is NULL
  // on real validation runs and set on reference rows.
  ensureColumns(database, "validation_runs", [
    { name: "reference_kind", def: "TEXT" },
    { name: "reference_json", def: "TEXT" },
  ]);
  ensureHandleScoreReferenceRow(database);
}

// Idempotently insert the frozen handle_score reference row. All the run-metric
// NOT NULL columns get 0 (this is not a real run); reference_kind marks it so
// getLatestRunSummary and analytics can exclude it. Re-issued only by a fresh
// re-validation freeze — here we just guarantee the current frozen edges exist.
function ensureHandleScoreReferenceRow(database: Database.Database): void {
  const existing = database
    .prepare(`SELECT id, reference_json FROM validation_runs WHERE reference_kind = ? LIMIT 1`)
    .get(HANDLE_SCORE_REFERENCE_KIND) as { id: number; reference_json: string | null } | undefined;

  const json = handleScoreReferenceJson();
  if (existing) {
    // Keep the stored edges in sync if the frozen constants ever change (a freeze
    // re-issue). Additive, single reference row — never accumulates duplicates.
    if (existing.reference_json !== json) {
      database
        .prepare(`UPDATE validation_runs SET reference_json = ? WHERE id = ?`)
        .run(json, existing.id);
    }
    return;
  }

  database
    .prepare(
      `INSERT INTO validation_runs (
         timestamp, input_row_count, total_final_count,
         live_final_count, pending_final_count,
         live_dropped_stale, pending_dropped_stale,
         live_dropped_over_cap, pending_dropped_over_cap,
         tiingo_attempted, tiingo_succeeded,
         risk_per_trade, parse_success,
         model, reference_kind, reference_json
       ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ?, ?, ?)`
    )
    .run(
      "handle_score_freeze",
      "handle_score_freeze",
      HANDLE_SCORE_REFERENCE_KIND,
      json
    );
}

/** ALTER TABLE ADD COLUMN for any of `columns` not already present on `table`. */
function ensureColumns(
  database: Database.Database,
  table: string,
  columns: Array<{ name: string; def: string }>
): void {
  const existing = new Set(
    (database.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  );
  for (const col of columns) {
    if (!existing.has(col.name)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.def}`);
    }
  }
}

export function closeDb(): void {
  if (db !== null) {
    db.close();
    db = null;
  }
}
