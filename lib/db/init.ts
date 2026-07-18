import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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
  ]);
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
