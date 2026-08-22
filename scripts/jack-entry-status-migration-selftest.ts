/*
 * JACK Phase 3 — schema migration self-test.
 *
 * Run:  npx tsx scripts/jack-entry-status-migration-selftest.ts
 *
 * Proves, against REAL throwaway SQLite databases, that adding entry_status /
 * confirmed_close_date / days_since_confirm to `setups`:
 *
 *   1. lands on a FRESH database (schema.sql path),
 *   2. lands on an OLD database created before the columns existed (the live VPS
 *      jack.db path — ALTER TABLE ADD COLUMN, since schema.sql is
 *      CREATE TABLE IF NOT EXISTS and would otherwise be a no-op),
 *   3. does NOT disturb existing rows — every pre-migration value survives byte
 *      for byte and the new columns read NULL,
 *   4. does NOT touch the first_seen_status / last_seen_status CHECK enum, which
 *      still rejects an out-of-enum status exactly as before,
 *   5. is idempotent across repeated opens.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `   ${detail}` : ""}`);
  }
}

const NEW_COLUMNS = ["entry_status", "confirmed_close_date", "days_since_confirm"];

/** The `setups` table AS IT WAS before Phase 3 — the live VPS shape. */
const OLD_SETUPS = `
CREATE TABLE IF NOT EXISTS setups (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker                TEXT    NOT NULL,
    handle_low_date       TEXT    NOT NULL,
    signal_date           TEXT,
    first_seen_at         TEXT    NOT NULL,
    last_seen_at          TEXT    NOT NULL,
    first_seen_status     TEXT    NOT NULL,
    last_seen_status      TEXT    NOT NULL,
    entry                 REAL,
    stop                  REAL,
    t05_target            REAL,
    breakout_level        REAL,
    cup_depth_pct         REAL,
    handle_retr_pct       REAL,
    retired_at            TEXT,
    retired_reason        TEXT,
    handle_score          REAL,
    size_bucket           TEXT,
    sector                TEXT,
    tier                  TEXT,
    priority              REAL,
    CHECK (first_seen_status IN ('just_fired', 'pending', 'recent_breakout', 'unknown')),
    CHECK (last_seen_status  IN ('just_fired', 'pending', 'recent_breakout', 'unknown')),
    UNIQUE (ticker, handle_low_date)
);`;

/** Mirrors ensureColumns() in lib/db/init.ts. */
function ensureColumns(db: Database.Database, table: string, cols: Array<{ name: string; def: string }>): number {
  const existing = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  );
  let added = 0;
  for (const col of cols) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.def}`);
      added++;
    }
  }
  return added;
}

const MIGRATION = [
  { name: "entry_status", def: "TEXT" },
  { name: "confirmed_close_date", def: "TEXT" },
  { name: "days_since_confirm", def: "INTEGER" },
];

const dir = mkdtempSync(join(tmpdir(), "jack-p3-mig-"));
try {
  console.log("\n=== OLD database (the live VPS jack.db path) ===\n");
  const dbPath = join(dir, "old.db");
  const db = new Database(dbPath);
  db.exec(OLD_SETUPS);

  // Populate with rows that must survive untouched.
  const insert = db.prepare(
    `INSERT INTO setups (ticker, handle_low_date, first_seen_at, last_seen_at,
       first_seen_status, last_seen_status, entry, stop, t05_target, breakout_level,
       handle_score, size_bucket, sector, tier, priority)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insert.run("TTE", "2026-08-03", "2026-08-04T00:00:00Z", "2026-08-10T00:00:00Z",
    "pending", "just_fired", 61.5, 58.2, 66.0, 61.4, 0.71, "full", "Energy", "Q5", 0.88);
  insert.run("CNQ", "2026-07-28", "2026-07-29T00:00:00Z", "2026-08-10T00:00:00Z",
    "pending", "pending", 41.1, 39.0, 44.3, 41.0, 0.49, "half", "Energy", "Q3", 0.51);

  const before = db.prepare("SELECT * FROM setups ORDER BY ticker").all() as Array<Record<string, unknown>>;
  const beforeCols = (db.pragma("table_info(setups)") as Array<{ name: string }>).map((c) => c.name);
  check("pre-migration DB lacks the new columns",
    NEW_COLUMNS.every((c) => !beforeCols.includes(c)));

  const added = ensureColumns(db, "setups", MIGRATION);
  check("migration added exactly 3 columns", added === 3, String(added));

  const afterCols = (db.pragma("table_info(setups)") as Array<{ name: string }>).map((c) => c.name);
  check("all three columns present after migration",
    NEW_COLUMNS.every((c) => afterCols.includes(c)), afterCols.join(","));
  check("no pre-existing column was dropped or renamed",
    beforeCols.every((c) => afterCols.includes(c)),
    beforeCols.filter((c) => !afterCols.includes(c)).join(","));

  const after = db.prepare("SELECT * FROM setups ORDER BY ticker").all() as Array<Record<string, unknown>>;
  check("row count unchanged", after.length === before.length);

  let identical = true;
  for (let i = 0; i < before.length; i++) {
    for (const k of Object.keys(before[i])) {
      if (before[i][k] !== after[i][k]) {
        identical = false;
        console.log(`       drift: row ${i} col ${k}: ${before[i][k]} -> ${after[i][k]}`);
      }
    }
  }
  check("every pre-existing value survived byte for byte", identical);
  check("new columns read NULL on existing rows",
    after.every((r) => r.entry_status === null && r.confirmed_close_date === null && r.days_since_confirm === null),
    JSON.stringify(after.map((r) => r.entry_status)));

  console.log("\n=== the status CHECK enum is untouched ===\n");
  const badStatus = () =>
    insert.run("BAD", "2026-08-01", "x", "y", "FRESH", "pending", 1, 1, 1, 1, 0.5, "full", "S", "Q5", 0.1);
  let threw = false;
  try { badStatus(); } catch { threw = true; }
  check("first_seen_status='FRESH' is STILL rejected by the CHECK (enum not extended)", threw);

  let enumOk = true;
  try {
    insert.run("GOOD", "2026-08-01", "x", "y", "pending", "recent_breakout", 1, 1, 1, 1, 0.5, "full", "S", "Q5", 0.1);
  } catch { enumOk = false; }
  check("a valid enum status still inserts fine", enumOk);

  db.prepare("UPDATE setups SET entry_status=?, confirmed_close_date=?, days_since_confirm=? WHERE ticker=?")
    .run("FRESH", "2026-08-10", 0, "TTE");
  const tte = db.prepare("SELECT * FROM setups WHERE ticker='TTE'").get() as Record<string, unknown>;
  check("entry_status accepts FRESH while last_seen_status keeps its own value",
    tte.entry_status === "FRESH" && tte.last_seen_status === "just_fired",
    `${tte.entry_status}/${tte.last_seen_status}`);
  check("confirmed_close_date + days_since_confirm round-trip",
    tte.confirmed_close_date === "2026-08-10" && tte.days_since_confirm === 0);

  console.log("\n=== idempotence ===\n");
  const again = ensureColumns(db, "setups", MIGRATION);
  check("re-running the migration adds nothing", again === 0, String(again));
  const third = ensureColumns(db, "setups", MIGRATION);
  check("and again", third === 0);
  const tteAfter = db.prepare("SELECT * FROM setups WHERE ticker='TTE'").get() as Record<string, unknown>;
  check("values survive repeated migration runs", tteAfter.entry_status === "FRESH");
  db.close();

  console.log("\n=== FRESH database (schema.sql path) ===\n");
  const freshPath = join(dir, "fresh.db");
  const fresh = new Database(freshPath);
  const schemaSql = require("node:fs").readFileSync(
    join(__dirname, "..", "lib", "db", "schema.sql"), "utf-8"
  );
  fresh.exec(schemaSql);
  const freshCols = (fresh.pragma("table_info(setups)") as Array<{ name: string }>).map((c) => c.name);
  check("schema.sql alone creates all three columns",
    NEW_COLUMNS.every((c) => freshCols.includes(c)), freshCols.join(","));
  const freshAdded = ensureColumns(fresh, "setups", MIGRATION);
  check("migration is a no-op on a fresh DB", freshAdded === 0, String(freshAdded));

  let freshEnum = false;
  try {
    fresh.prepare(
      `INSERT INTO setups (ticker, handle_low_date, first_seen_at, last_seen_at,
        first_seen_status, last_seen_status) VALUES (?,?,?,?,?,?)`
    ).run("X", "2026-01-01", "a", "b", "AGING", "pending");
  } catch { freshEnum = true; }
  check("fresh DB also still rejects a non-enum status", freshEnum);
  fresh.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
