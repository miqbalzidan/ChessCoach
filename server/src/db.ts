import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = Database.Database;

let instance: DB | null = null;

export function getDb(): DB {
  if (instance) return instance;
  const file = resolve(process.env.DATABASE_PATH ?? 'data/chesscoach.db');
  mkdirSync(dirname(file), { recursive: true });
  instance = new Database(file);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  migrate(instance);
  return instance;
}

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id             INTEGER PRIMARY KEY,
      username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      source         TEXT NOT NULL DEFAULT 'chess.com',
      created_at     INTEGER NOT NULL,
      last_synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS games (
      id              INTEGER PRIMARY KEY,
      player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      external_id     TEXT NOT NULL,
      source          TEXT NOT NULL,
      url             TEXT,
      pgn             TEXT NOT NULL,
      time_class      TEXT NOT NULL,
      time_control    TEXT NOT NULL,
      end_time        INTEGER NOT NULL,
      rated           INTEGER NOT NULL DEFAULT 1,
      white_username  TEXT NOT NULL,
      black_username  TEXT NOT NULL,
      white_rating    INTEGER,
      black_rating    INTEGER,
      eco             TEXT,
      eco_name        TEXT,
      player_color    TEXT NOT NULL,
      result          TEXT NOT NULL,
      termination     TEXT,
      opponent        TEXT NOT NULL,
      player_rating   INTEGER,
      opponent_rating INTEGER,
      move_count      INTEGER NOT NULL DEFAULT 0,
      analysed_at     INTEGER,
      analysis_depth  INTEGER,
      engine          TEXT,
      accuracy_white  REAL,
      accuracy_black  REAL,
      created_at      INTEGER NOT NULL,
      UNIQUE (player_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_games_player_time  ON games (player_id, time_class);
    CREATE INDEX IF NOT EXISTS idx_games_player_end   ON games (player_id, end_time DESC);
    CREATE INDEX IF NOT EXISTS idx_games_analysed     ON games (player_id, analysed_at);
    CREATE INDEX IF NOT EXISTS idx_games_eco          ON games (player_id, eco);

    CREATE TABLE IF NOT EXISTS moves (
      id               INTEGER PRIMARY KEY,
      game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      ply              INTEGER NOT NULL,
      move_number      INTEGER NOT NULL,
      color            TEXT NOT NULL,
      is_player        INTEGER NOT NULL,
      san              TEXT NOT NULL,
      uci              TEXT NOT NULL,
      fen_before       TEXT NOT NULL,
      fen_after        TEXT NOT NULL,
      eval_before      INTEGER NOT NULL,
      eval_after       INTEGER NOT NULL,
      mate_before      INTEGER,
      mate_after       INTEGER,
      cp_loss          INTEGER NOT NULL,
      win_percent_loss REAL NOT NULL,
      accuracy         REAL NOT NULL,
      classification   TEXT NOT NULL,
      best_move_uci    TEXT,
      best_move_san    TEXT,
      pv               TEXT,
      phase            TEXT NOT NULL,
      clock_after      REAL,
      time_spent       REAL,
      motifs           TEXT NOT NULL DEFAULT '',
      UNIQUE (game_id, ply)
    );

    CREATE INDEX IF NOT EXISTS idx_moves_game    ON moves (game_id, ply);
    CREATE INDEX IF NOT EXISTS idx_moves_player  ON moves (is_player, classification);

    CREATE TABLE IF NOT EXISTS import_jobs (
      id          INTEGER PRIMARY KEY,
      player_id   INTEGER REFERENCES players(id) ON DELETE CASCADE,
      username    TEXT NOT NULL,
      status      TEXT NOT NULL,
      stage       TEXT NOT NULL DEFAULT 'queued',
      imported    INTEGER NOT NULL DEFAULT 0,
      analysed    INTEGER NOT NULL DEFAULT 0,
      total       INTEGER NOT NULL DEFAULT 0,
      message     TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coaching (
      id         INTEGER PRIMARY KEY,
      player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      scope      TEXT NOT NULL,
      body       TEXT NOT NULL,
      model      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (player_id, scope)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getSetting(db: DB, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
