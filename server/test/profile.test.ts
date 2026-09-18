import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, type DB } from '../src/db.js';
import { profile } from '../src/profile.js';

/** A database with one player and nothing else. */
function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO players (id, username, source, created_at) VALUES (1, 'tester', 'test', 0)`,
  ).run();
  return db;
}

interface GameSpec {
  result: 'win' | 'loss' | 'draw';
  eco?: string;
  timeClass?: string;
  /** Player accuracy per move, and the opponent's, for the phase given. */
  mine?: number;
  theirs?: number;
  phase?: 'opening' | 'middlegame' | 'endgame';
  /** Best and worst eval reached from the player's point of view. */
  best?: number;
  worst?: number;
  moves?: number;
}

let nextGame = 0;
let nextMove = 0;

function addGame(db: DB, spec: GameSpec): void {
  nextGame += 1;
  const id = nextGame;
  db.prepare(
    `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                        end_time, white_username, black_username, eco, player_color, result,
                        opponent, move_count, analysed_at, created_at)
     VALUES (@id, 1, @ext, 'test', '', @timeClass, '600+0', @endTime, 'tester', 'other',
             @eco, 'white', @result, 'other', 10, 1, 0)`,
  ).run({
    id,
    ext: `g${id}`,
    timeClass: spec.timeClass ?? 'blitz',
    endTime: 1_000_000 + id,
    eco: spec.eco ?? null,
    result: spec.result,
  });

  const count = spec.moves ?? 20;
  for (let i = 0; i < count; i += 1) {
    nextMove += 1;
    const isPlayer = i % 2 === 0;
    // The swing is put on the first pair of moves so best/worst are exactly as asked.
    const evalAfter = i === 0 ? (spec.best ?? 0) : i === 1 ? -(spec.worst ?? 0) : 0;
    db.prepare(
      `INSERT INTO moves (id, game_id, ply, move_number, color, is_player, san, uci,
                          fen_before, fen_after, eval_before, eval_after, cp_loss,
                          win_percent_loss, accuracy, classification, phase, clock_after)
       VALUES (@id, @game, @ply, @moveNumber, @color, @isPlayer, 'e4', 'e2e4', '', '',
               0, @evalAfter, 0, 0, @accuracy, 'good', @phase, NULL)`,
    ).run({
      id: nextMove,
      game: id,
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      color: isPlayer ? 'white' : 'black',
      isPlayer: isPlayer ? 1 : 0,
      evalAfter,
      accuracy: isPlayer ? (spec.mine ?? 90) : (spec.theirs ?? 90),
      phase: spec.phase ?? 'middlegame',
    });
  }
}

describe('scouting report', () => {
  test('says nothing at all from a handful of games', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i += 1) addGame(db, { result: 'win' });

    const report = profile(db, 1, 'all');
    // Five games describe five games. Refusing to profile is the correct answer.
    assert.equal(report.thin, true);
    assert.deepEqual(report.strengths, []);
    assert.deepEqual(report.weaknesses, []);
    db.close();
  });

  test('measures a phase against the opponents in the same games', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: 'win', phase: 'endgame', mine: 95, theirs: 80 });
    }

    const report = profile(db, 1, 'all');
    const trait = report.strengths.find((t) => t.key === 'phase-endgame');
    assert.ok(trait, 'expected an endgame strength');
    assert.match(trait.title, /endgame/);
    // The evidence must carry both sides, or the claim cannot be checked.
    assert.match(trait.evidence, /95/);
    assert.match(trait.evidence, /80/);
    assert.equal(
      report.weaknesses.some((t) => t.key === 'phase-endgame'),
      false,
    );
    db.close();
  });

  test('the same gap the other way round is a weakness', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: 'loss', phase: 'opening', mine: 78, theirs: 92 });
    }

    const report = profile(db, 1, 'all');
    assert.ok(report.weaknesses.some((t) => t.key === 'phase-opening'));
    db.close();
  });

  test('a phase within a couple of points of the field is not a finding', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: 'draw', phase: 'middlegame', mine: 90, theirs: 89 });
    }

    const report = profile(db, 1, 'all');
    assert.equal(
      [...report.strengths, ...report.weaknesses].some((t) => t.key.startsWith('phase-')),
      false,
      'a one-point difference should not be called a strength or a weakness',
    );
    db.close();
  });

  test('notices winning positions being thrown away', () => {
    const db = freshDb();
    // Ten games reached +300 and only two were won.
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: i < 2 ? 'win' : 'loss', best: 300 });
    }

    const report = profile(db, 1, 'all');
    const trait = report.weaknesses.find((t) => t.key === 'conversion');
    assert.ok(trait, 'expected a conversion weakness');
    assert.match(trait.evidence, /2 of 10/);
    db.close();
  });

  test('and notices them being finished off', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) addGame(db, { result: 'win', best: 300 });

    const report = profile(db, 1, 'all');
    assert.ok(report.strengths.some((t) => t.key === 'conversion'));
    db.close();
  });

  test('names the opening to steer you into, and the one to avoid', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i += 1) addGame(db, { result: 'win', eco: 'C65' });
    for (let i = 0; i < 5; i += 1) addGame(db, { result: 'loss', eco: 'A04' });

    const report = profile(db, 1, 'all');
    assert.ok(report.strengths.some((t) => t.key === 'opening-C65'));
    assert.ok(report.weaknesses.some((t) => t.key === 'opening-A04'));
    db.close();
  });

  test('an opening seen three times is not a pattern', () => {
    const db = freshDb();
    for (let i = 0; i < 3; i += 1) addGame(db, { result: 'win', eco: 'B10' });
    for (let i = 0; i < 7; i += 1) addGame(db, { result: 'draw' });

    const report = profile(db, 1, 'all');
    assert.equal(
      [...report.strengths, ...report.weaknesses].some((t) => t.key === 'opening-B10'),
      false,
    );
    db.close();
  });

  test('every trait carries its evidence', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: 'win', eco: 'C65', best: 300, mine: 96, theirs: 78 });
    }

    const report = profile(db, 1, 'all');
    const all = [...report.strengths, ...report.weaknesses];
    assert.ok(all.length > 0);
    for (const trait of all) {
      assert.ok(trait.evidence.length > 0, `${trait.key} has no evidence`);
      assert.ok(trait.detail.length > 0, `${trait.key} has no detail`);
      assert.ok(/\d/.test(trait.evidence), `${trait.key}'s evidence has no number in it`);
    }
    db.close();
  });

  test('scope narrows the report to one time class', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: 'loss', timeClass: 'bullet', phase: 'opening', mine: 70, theirs: 92 });
    }
    for (let i = 0; i < 10; i += 1) {
      addGame(db, { result: 'win', timeClass: 'rapid', phase: 'opening', mine: 95, theirs: 80 });
    }

    const bullet = profile(db, 1, 'bullet');
    const rapid = profile(db, 1, 'rapid');
    assert.ok(bullet.weaknesses.some((t) => t.key === 'phase-opening'));
    assert.ok(rapid.strengths.some((t) => t.key === 'phase-opening'));
    db.close();
  });
});
