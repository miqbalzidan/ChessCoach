/**
 * A phone seeded from a computer's export must show the computer's sheet.
 *
 * This builds a real snapshot from a real database — the same `buildSnapshot` the
 * export command runs — seeds a second, empty database from it, and asserts the two
 * produce identical numbers through every lens. That is the promise the whole
 * seeding idea rests on: the games arrive already analysed, and nothing is quietly
 * recomputed or rounded on the way in.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, type DB } from '../../core/src/db.js';
import { seedFromSnapshot } from '../../core/src/seed-snapshot.js';
import { dashboard, openings } from '../../core/src/stats.js';
import { detectPatterns } from '../../core/src/patterns.js';
import { profile } from '../../core/src/profile.js';
import { listGames, upsertPlayer } from '../../core/src/store.js';
import { buildSnapshot } from '../src/export.js';
import type { Lens } from '../../core/src/types.js';

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  return db;
}

/** A history with two engines in it, because that is what a seeded phone really has. */
function source(): DB {
  const db = freshDb();
  upsertPlayer(db, 'tester');

  const rows: Array<[string, string, string, string, string, number]> = [
    ['C65', 'white', 'blitz', 'win', 'Stockfish 16', 16],
    ['C65', 'white', 'blitz', 'loss', 'Stockfish 16', 16],
    ['C65', 'white', 'rapid', 'win', 'Stockfish 16', 16],
    ['B10', 'black', 'blitz', 'loss', 'Stockfish 16', 16],
    ['B10', 'black', 'rapid', 'draw', 'Stockfish 16', 16],
    ['A04', 'black', 'daily', 'win', 'Stockfish 19 Lite WASM', 12],
    ['A04', 'black', 'daily', 'loss', 'Stockfish 19 Lite WASM', 12],
  ];

  rows.forEach(([eco, color, timeClass, result, engine, depth], index) => {
    const id = index + 1;
    db.prepare(
      `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                          end_time, white_username, black_username, eco, eco_name, player_color,
                          result, opponent, move_count, accuracy_white, accuracy_black,
                          analysis_depth, engine, analysed_at, created_at)
       VALUES (@id, 1, @ext, 'chess.com', @pgn, @timeClass, '600+0', @endTime, 'tester', 'other',
               @eco, @name, @color, @result, 'other', 10, 81.5, 78.25, @depth, @engine, 1, 0)`,
    ).run({
      id,
      ext: `game-${id}`,
      pgn: '[Event "x"]\n\n1. e4 e5',
      timeClass,
      endTime: 1_700_000_000 + id * 3600,
      eco,
      name: `Opening ${eco}`,
      color,
      result,
      depth,
      engine,
    });

    for (let ply = 1; ply <= 10; ply += 1) {
      const isPlayer = ply % 2 === 1;
      const blunder = isPlayer && ply === 3;
      db.prepare(
        `INSERT INTO moves (game_id, ply, move_number, color, is_player, san, uci,
                            fen_before, fen_after, eval_before, eval_after, mate_before,
                            mate_after, cp_loss, win_percent_loss, accuracy, classification,
                            best_move_uci, best_move_san, pv, phase, clock_after, time_spent, motifs)
         VALUES (@game, @ply, @moveNumber, @color, @isPlayer, @san, 'e2e4', 'fen-b', 'fen-a',
                 @evalBefore, 5, NULL, NULL, @cpLoss, @loss, @accuracy, @classification,
                 'd2d4', 'd4', 'd2d4 d7d5', @phase, @clock, 4, @motifs)`,
      ).run({
        game: id,
        ply,
        moveNumber: Math.ceil(ply / 2),
        color: isPlayer ? color : color === 'white' ? 'black' : 'white',
        isPlayer: isPlayer ? 1 : 0,
        san: `m${ply}`,
        evalBefore: ply === 1 ? 250 : 15,
        cpLoss: blunder ? 260 : 6,
        loss: blunder ? 36 : 1.25,
        accuracy: blunder ? 19.5 : 94.25,
        classification: blunder ? 'blunder' : 'good',
        phase: ply <= 4 ? 'opening' : 'middlegame',
        clock: 60 - ply,
        motifs: blunder ? 'hung-piece' : '',
      });
    }
  });

  return db;
}

/**
 * Row ids are not part of the answer.
 *
 * A seeded database assigns its own — it must, since it may already hold games — so
 * the trend points at the same games under different numbers. Comparing through
 * `external_id` asserts the stronger thing: not just that the figures match, but
 * that they are about the same games.
 */
function comparable(db: DB, value: unknown): unknown {
  const externalIds = new Map(
    (
      db.prepare('SELECT id, external_id FROM games').all() as Array<{
        id: number;
        external_id: string;
      }>
    ).map((row) => [row.id, row.external_id]),
  );
  return JSON.parse(JSON.stringify(value), (key, entry) =>
    key === 'gameId' || key === 'game_id' || key === 'id'
      ? (externalIds.get(entry as number) ?? entry)
      : entry,
  );
}

const LENSES: Lens[] = [
  { scope: 'all' },
  { scope: 'blitz' },
  { scope: 'daily' },
  { scope: 'all', eco: 'C65', color: 'white' },
  { scope: 'blitz', eco: 'B10', color: 'black' },
];

describe('seeding a phone from an export', () => {
  test('reproduces the exporting machine\'s sheet exactly', async () => {
    const pc = source();
    const snapshot = await buildSnapshot(pc, 'tester');

    const phone = freshDb();
    const result = seedFromSnapshot(phone, snapshot);

    assert.equal(result.games, 7);
    assert.equal(result.moves, 70);
    assert.equal(result.duplicates, 0);

    for (const lens of LENSES) {
      const key = JSON.stringify(lens);
      assert.deepEqual(
        comparable(phone, dashboard(phone, 1, lens)),
        comparable(pc, dashboard(pc, 1, lens)),
        `dashboard differs for ${key}`,
      );
      assert.deepEqual(
        comparable(phone, detectPatterns(phone, 1, lens, { minOccurrences: 2 })),
        comparable(pc, detectPatterns(pc, 1, lens, { minOccurrences: 2 })),
        `patterns differ for ${key}`,
      );
      assert.deepEqual(profile(phone, 1, lens), profile(pc, 1, lens), `profile differs for ${key}`);
      assert.deepEqual(openings(phone, 1, lens), openings(pc, 1, lens), `openings differ for ${key}`);
    }

    pc.close();
    phone.close();
  });

  test('keeps the engine and depth each game was analysed at', async () => {
    // The whole point of the split: the archive was done properly on a computer, and
    // saying so is what lets the sheet warn that it mixes two instruments.
    const pc = source();
    const snapshot = await buildSnapshot(pc, 'tester');
    const phone = freshDb();
    const result = seedFromSnapshot(phone, snapshot);

    assert.equal(result.mixedAnalysis, true, 'two engines went in and it did not notice');

    const signatures = (
      phone
        .prepare('SELECT DISTINCT engine, analysis_depth AS depth FROM games ORDER BY engine')
        .all() as Array<{ engine: string; depth: number }>
    ).map((row) => `${row.engine}@${row.depth}`);
    assert.deepEqual(signatures, ['Stockfish 16@16', 'Stockfish 19 Lite WASM@12']);

    pc.close();
    phone.close();
  });

  test('re-seeding adds what is new and duplicates nothing', async () => {
    // Someone exports again after a week. The phone should gain that week's games,
    // not a second copy of the year.
    const pc = source();
    const phone = freshDb();

    const first = seedFromSnapshot(phone, await buildSnapshot(pc, 'tester'));
    assert.equal(first.games, 7);

    // A new game appears on the computer.
    pc.prepare(
      `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                          end_time, white_username, black_username, eco, eco_name, player_color,
                          result, opponent, move_count, accuracy_white, accuracy_black,
                          analysis_depth, engine, analysed_at, created_at)
       VALUES (99, 1, 'game-99', 'chess.com', '', 'blitz', '600+0', 1800000000, 'tester',
               'other', 'C50', 'Italian Game', 'white', 'win', 'other', 10, 80, 80, 16,
               'Stockfish 16', 1, 0)`,
    ).run();

    const second = seedFromSnapshot(phone, await buildSnapshot(pc, 'tester'));
    assert.equal(second.games, 1, 'should have added only the new game');
    assert.equal(second.duplicates, 7, 'should have recognised the seven it already had');

    assert.equal(listGames(phone, 1, { limit: 200 }).total, 8);
    pc.close();
    phone.close();
  });

  test('seeds into a database that already has its own games', async () => {
    // The other order: someone imported on the phone first, then seeded from a PC.
    // Neither history should overwrite the other, and ids must not collide.
    const phone = freshDb();
    upsertPlayer(phone, 'tester');
    phone
      .prepare(
        `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                            end_time, white_username, black_username, player_color, result,
                            opponent, move_count, created_at)
         VALUES (1, 1, 'phone-only', 'pgn', '', 'blitz', '600+0', 1700000001, 'tester',
                 'other', 'white', 'win', 'other', 10, 0)`,
      )
      .run();

    const pc = source();
    const result = seedFromSnapshot(phone, await buildSnapshot(pc, 'tester'));

    assert.equal(result.games, 7);
    assert.equal(listGames(phone, 1, { limit: 200 }).total, 8, 'the phone\'s own game survived');

    const ids = (
      phone.prepare('SELECT id FROM games ORDER BY id').all() as Array<{ id: number }>
    ).map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, 'ids collided');

    pc.close();
    phone.close();
  });
});

describe('saying which instrument produced which games', () => {
  test('a seeded phone reports both engines, per lens', async () => {
    const pc = source();
    const phone = freshDb();
    seedFromSnapshot(phone, await buildSnapshot(pc, 'tester'));

    // Everything: the desktop's five and the phone's two.
    const all = dashboard(phone, 1, { scope: 'all' }).sources;
    assert.deepEqual(
      all.map((s) => `${s.engine}@${s.depth}×${s.games}`),
      ['Stockfish 16@16×5', 'Stockfish 19 Lite WASM@12×2'],
    );

    // Narrowed to a segment that only one of them touched, there is nothing to warn
    // about — and a warning shown where it does not apply is noise that gets ignored
    // where it does.
    const daily = dashboard(phone, 1, { scope: 'daily' }).sources;
    assert.equal(daily.length, 1);
    assert.equal(daily[0]!.engine, 'Stockfish 19 Lite WASM');

    const blitz = dashboard(phone, 1, { scope: 'blitz' }).sources;
    assert.equal(blitz.length, 1);
    assert.equal(blitz[0]!.depth, 16);

    pc.close();
    phone.close();
  });

  test('unanalysed games are not an instrument', async () => {
    const pc = source();
    pc.prepare(
      `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                          end_time, white_username, black_username, player_color, result,
                          opponent, move_count, created_at)
       VALUES (50, 1, 'pending', 'chess.com', '', 'blitz', '600+0', 1800000000, 'tester',
               'other', 'white', 'win', 'other', 10, 0)`,
    ).run();

    const sources = dashboard(pc, 1, { scope: 'all' }).sources;
    assert.equal(
      sources.reduce((sum, s) => sum + s.games, 0),
      7,
      'a game waiting to be analysed was counted as analysed by something',
    );
    pc.close();
  });
});
