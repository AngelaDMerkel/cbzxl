import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Row = Record<string, unknown>;
export const now = () => new Date().toISOString();
export const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
export const SCHEMA_ID = 1128421942;

export function lockDatabasePath(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const gate = new DatabaseSync(path + ".lock.sqlite3", { timeout: 1000 });
  try {
    const id = Number(
      gate.prepare("PRAGMA application_id").get()!["application_id"],
    );
    const tables = gate
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    if ((id !== 0 && id !== SCHEMA_ID + 1) || (id === 0 && tables.length))
      throw new Error("Unrelated file occupies the database lock path");
    gate.exec(
      "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS gate(id INTEGER); PRAGMA application_id=1128421943; COMMIT;",
    );
    return () => gate.close();
  } catch (error) {
    gate.close();
    throw new Error("Database is in use or its lock cannot be acquired", {
      cause: error,
    });
  }
}

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const application = db.prepare("PRAGMA application_id").get()![
      "application_id"
    ];
    if (tables.length && application !== SCHEMA_ID)
      throw new Error(
        "This is a legacy or unrelated database. Run the migration container first.",
      );
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;",
    );
    // One app process owns this database; SQLite releases the lock after a crash.
    db.exec("BEGIN EXCLUSIVE");
    if (!tables.length)
      db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    else if (db.prepare("PRAGMA user_version").get()!["user_version"] !== 1)
      throw new Error("Unsupported database schema version");
    db.exec("COMMIT");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function rows(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function setting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  return row ? (JSON.parse(String(row["value"])) as T) : fallback;
}

export function setSetting(
  db: DatabaseSync,
  key: string,
  value: unknown,
): void {
  db.prepare(
    "INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, json(value));
}

export function verifyDatabase(db: DatabaseSync): void {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== "ok")
    throw new Error("Database integrity check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Database foreign-key check failed");
}
