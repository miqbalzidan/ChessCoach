/**
 * The phone's database has to answer exactly what the desktop's does.
 *
 * These are not new assertions about SQLite — they are core's own queries, the ones
 * the sheet is actually built from, run against the WASM binding instead of the
 * native one. If the two disagree about a number, the phone would quietly show a
 * different leak sheet from the computer that exported it, which is the one failure
 * mode this port cannot have.
 *
 * It runs in Node against an in-memory database. The browser adds OPFS on top, which
 * changes where the bytes live and nothing about what the queries return.
 */
import { strict as assert } from 'node:assert';
import { test, describe, before } from 'node:test';
import Database from 'better-sqlite3';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { wrapOo1Db } from '../../web/src/engine/db-wasm.js';
import { migrate, type DB } from '../../core/src/db.js';
import { dashboard, openings } from '../../core/src/stats.js';
import { detectPatterns } from '../../core/src/patterns.js';
import { profile } from '../../core/src/profile.js';
import { listGames, findPlayer, upsertPlayer } from '../../core/src/store.js';
import { readCachedCoaching, writeCachedCoaching } from '../../core/src/coach.js';

let sqlite3: any;

before(async () => {
  sqlite3 = await sqlite3InitModule();
});

function wasmDb(): DB {
  const raw = new sqlite3.oo1.DB(':memory:');
  return wrapOo1Db(raw, {
    lastInsertRowid: (db: any) => Number(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer ?? db)),
  });
}

function nativeDb(): DB {
  return new Database(':memory:') as unknown as DB;
}

/** The same games, written through whichever binding is under test. */
function seed(db: DB): void {
  migrate(db);
  upsertPlayer(db, 'tester');

  const rows: Array<[string, string, string, string]> = [
    ['C65', 'white', 'blitz', 'win'],
    ['C65', 'white', 'blitz', 'win'],
    ['C65', 'white', 'rapid', 'loss'],
    ['C65', 'white', 'rapid', 'win'],
    ['B10', 'black', 'blitz', 'loss'],
    ['B10', 'black', 'blitz', 'loss'],
    ['A04', 'black', 'daily', 'draw'],
    ['A04', 'black', 'daily', 'win'],
    ['B20', 'white', 'bullet', 'loss'],
    ['B20', 'white', 'bullet', 'win'],
  ];

  rows.forEach(([eco, color, timeClass, result], index) => {
    const id = index + 1;
    db.prepare(
      `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                          end_time, white_username, black_username, eco, eco_name, player_color,
                          result, opponent, move_count, accuracy_white, accuracy_black,
                          analysis_depth, engine, analysed_at, created_at)
       VALUES (@id, 1, @ext, 'test', '', @timeClass, '600+0', @endTime, 'tester', 'other',
               @eco, @name, @color, @result, 'other', 12, 82.5, 79.5, 14, 'Stockfish 16', 1, 0)`,
    ).run({
      id,
      ext: `g${id}`,
      timeClass,
      endTime: 1_700_000_000 + id * 3600,
      eco,
      name: `Opening ${eco}`,
      color,
      result,
    });

    for (let ply = 1; ply <= 12; ply += 1) {
      const isPlayer = ply % 2 === 1;
      const blunder = isPlayer && ply === 5;
      db.prepare(
        `INSERT INTO moves (game_id, ply, move_number, color, is_player, san, uci,
                            fen_before, fen_after, eval_before, eval_after, cp_loss,
                            win_percent_loss, accuracy, classification, phase, motifs, clock_after)
         VALUES (@game, @ply, @moveNumber, @color, @isPlayer, 'e4', 'e2e4', 'fen', 'fen',
                 @evalBefore, 0, @cpLoss, @loss, @accuracy, @classification, @phase, @motifs, @clock)`,
      ).run({
        game: id,
        ply,
        moveNumber: Math.ceil(ply / 2),
        color: isPlayer ? color : color === 'white' ? 'black' : 'white',
        isPlayer: isPlayer ? 1 : 0,
        evalBefore: ply === 1 ? 300 : 20,
        cpLoss: blunder ? 240 : 8,
        loss: blunder ? 34 : 1.5,
        accuracy: blunder ? 22 : 93,
        classification: blunder ? 'blunder' : 'good',
        phase: ply <= 6 ? 'opening' : 'middlegame',
        motifs: blunder ? 'hung-piece' : '',
        clock: 45 - ply,
      });
    }
  });
}

describe('the WASM binding answers like the native one', () => {
  test('every number on the sheet matches, through every lens', () => {
    const native = nativeDb();
    const wasm = wasmDb();
    seed(native);
    seed(wasm);

    const lenses = [
      { scope: 'all' as const },
      { scope: 'blitz' as const },
      { scope: 'rapid' as const },
      { scope: 'all' as const, eco: 'C65', color: 'white' as const },
      { scope: 'blitz' as const, eco: 'B10', color: 'black' as const },
      { scope: 'daily' as const, eco: 'A04', color: 'black' as const },
    ];

    for (const lens of lenses) {
      const key = JSON.stringify(lens);
      assert.deepEqual(
        JSON.parse(JSON.stringify(dashboard(wasm, 1, lens))),
        JSON.parse(JSON.stringify(dashboard(native, 1, lens))),
        `dashboard differs for ${key}`,
      );
      assert.deepEqual(
        detectPatterns(wasm, 1, lens, { minOccurrences: 2 }),
        detectPatterns(native, 1, lens, { minOccurrences: 2 }),
        `patterns differ for ${key}`,
      );
      assert.deepEqual(profile(wasm, 1, lens), profile(native, 1, lens), `profile differs for ${key}`);
      assert.deepEqual(openings(wasm, 1, lens), openings(native, 1, lens), `openings differ for ${key}`);
    }

    native.close();
    wasm.close();
  });

  test('the game list filters and paginates identically', () => {
    const native = nativeDb();
    const wasm = wasmDb();
    seed(native);
    seed(wasm);

    const filters = [
      {},
      { timeClass: 'blitz' as const },
      { result: 'win' as const },
      { eco: 'C65', color: 'white' as const },
      { opponent: 'oth' },
      { limit: 3, offset: 2 },
      { analysedOnly: true },
    ];

    for (const filter of filters) {
      assert.deepEqual(
        listGames(wasm, 1, filter),
        listGames(native, 1, filter),
        `game list differs for ${JSON.stringify(filter)}`,
      );
    }

    native.close();
    wasm.close();
  });

  test('named parameters bind, which is the thing that would silently break', () => {
    // core writes `@player` and passes `{ player: 1 }`. sqlite-wasm rejects the bare
    // key outright — it does not bind null and carry on — so this is the assertion
    // that catches the shim forgetting to add the prefix.
    const db = wasmDb();
    seed(db);

    const row = db
      .prepare('SELECT COUNT(*) AS n FROM games WHERE player_id = @player AND eco = @eco')
      .get({ player: 1, eco: 'C65' }) as { n: number };
    assert.equal(row.n, 4);

    // Positional binding is the other style core uses, and must keep working.
    const positional = db
      .prepare('SELECT COUNT(*) AS n FROM games WHERE player_id = ? AND result = ?')
      .get(1, 'win') as { n: number };
    assert.equal(positional.n, 5);

    db.close();
  });

  test('writes report their row id, and roll back together', () => {
    const db = wasmDb();
    migrate(db);

    const player = upsertPlayer(db, 'tester');
    assert.ok(player.id > 0, 'insert did not report a row id');
    assert.equal(findPlayer(db, 'tester')?.id, player.id);

    // store.ts wraps the per-move insert in one of these; a transaction that does not
    // roll back would leave half a game in the database after any failure.
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const write = db.transaction((values: string[]) => {
      for (const value of values) {
        if (value === 'boom') throw new Error('boom');
        insert.run(value, value);
      }
    });

    assert.throws(() => write(['a', 'b', 'boom']));
    const left = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    assert.equal(left.n, 0, 'rolled-back rows survived');

    write(['a', 'b']);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n, 2);
    db.close();
  });

  test('the coaching cache round-trips per lens', () => {
    const db = wasmDb();
    migrate(db);
    upsertPlayer(db, 'tester');

    writeCachedCoaching(db, 1, { scope: 'blitz' }, {
      headline: 'every blitz game',
      diagnosis: 'd',
      patterns: [],
      studyPlan: [],
      model: 'offline',
      generatedAt: 1,
    });

    assert.equal(readCachedCoaching(db, 1, { scope: 'blitz' })?.headline, 'every blitz game');
    assert.equal(readCachedCoaching(db, 1, { scope: 'rapid' }), null);
    db.close();
  });

  test('migrate is idempotent, because a phone reopens the same file every launch', () => {
    const db = wasmDb();
    migrate(db);
    migrate(db);
    migrate(db);
    upsertPlayer(db, 'tester');
    assert.equal(findPlayer(db, 'tester')?.username, 'tester');
    db.close();
  });
});
