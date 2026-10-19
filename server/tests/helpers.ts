/** A database file of versions up to 1.2 (SQLite), built with the migrations of those versions. */
import Database from 'better-sqlite3';
import { migrations as sqliteMigrations } from '../src/db/legacy/sqliteMigrations.js';

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ς/g, 'σ');

export function makeLegacyDb(file: string, upTo = 4): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.function('ims_norm', { deterministic: true }, (v: unknown) => (v == null ? null : norm(String(v))));
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  for (const m of sqliteMigrations.filter((m) => m.version <= upTo)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
  }
  return db;
}
