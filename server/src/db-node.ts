/**
 * The desktop database: SQLite as a native binding, in a file on disk.
 *
 * better-sqlite3 satisfies core's `DB` interface as it comes — the interface was
 * drawn around what the queries already used — so this file is only about finding
 * the file, opening it and setting the pragmas a long-lived server wants.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrate, type DB } from '../../core/src/db.js';

export type { DB };
export { migrate, getSetting, setSetting } from '../../core/src/db.js';

let instance: DB | null = null;

export function getDb(): DB {
  if (instance) return instance;
  const file = resolve(process.env.DATABASE_PATH ?? 'data/chesscoach.db');
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  instance = db;
  return instance;
}
