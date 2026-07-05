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

  const schemaSql = readFileSync(resolveSchemaPath(), "utf-8");
  newDb.exec(schemaSql);

  db = newDb;
  return newDb;
}

export function closeDb(): void {
  if (db !== null) {
    db.close();
    db = null;
  }
}
