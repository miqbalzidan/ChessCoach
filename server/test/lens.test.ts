import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, type DB } from '../src/db.js';
import { lensClause, lensKey, lensLabel, parseLens } from '../src/lens.js';
import { dashboard, openings } from '../src/stats.js';
import { detectPatterns } from '../src/patterns.js';
import { profile } from '../src/profile.js';
import { listGames } from '../src/store.js';
import { readCachedCoaching, writeCachedCoaching } from '../src/coach.js';
import type { Coaching } from '../src/coach.js';

function freshDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO players (id, username, source, created_at) VALUES (1, 'tester', 'test', 0)`,
  ).run();
  return db;
}

interface GameSpec {
  eco: string;
  name?: string;
  color?: 'white' | 'black';
  timeClass?: string;
  result?: 'win' | 'loss' | 'draw';
  /** A motif on every player move, so patterns have something to cluster. */
  motif?: string;
}

let nextGame = 0;
let nextMove = 0;

function addGame(db: DB, spec: GameSpec): number {
  nextGame += 1;
  const id = nextGame;
  db.prepare(
    `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                        end_time, white_username, black_username, eco, eco_name, player_color,
                        result, opponent, move_count, accuracy_white, accuracy_black,
                        analysed_at, created_at)
     VALUES (@id, 1, @ext, 'test', '', @timeClass, '600+0', @endTime, 'tester', 'other',
             @eco, @name, @color, @result, 'other', 10, 90, 90, 1, 0)`,
  ).run({
    id,
    ext: `g${id}`,
    timeClass: spec.timeClass ?? 'blitz',
    endTime: 1_000_000 + id,
    eco: spec.eco,
    name: spec.name ?? `Opening ${spec.eco}`,
    color: spec.color ?? 'white',
    result: spec.result ?? 'win',
  });

  for (let i = 0; i < 8; i += 1) {
    nextMove += 1;
    db.prepare(
      `INSERT INTO moves (id, game_id, ply, move_number, color, is_player, san, uci,
                          fen_before, fen_after, eval_before, eval_after, cp_loss,
                          win_percent_loss, accuracy, classification, phase, motifs, clock_after)
       VALUES (@id, @game, @ply, @moveNumber, 'white', @isPlayer, 'e4', 'e2e4', '', '',
               0, 0, 120, @loss, 70, @classification, 'middlegame', @motifs, NULL)`,
    ).run({
      id: nextMove,
      game: id,
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      isPlayer: i % 2 === 0 ? 1 : 0,
      loss: i % 2 === 0 ? 22 : 0,
      classification: i % 2 === 0 ? 'blunder' : 'good',
      motifs: i % 2 === 0 ? (spec.motif ?? 'hung-piece') : '',
    });
  }
  return id;
}

/** Two repertoires that share nothing: the Berlin as White, the Caro as Black. */
function twoOpenings(db: DB): void {
  for (let i = 0; i < 10; i += 1) {
    addGame(db, { eco: 'C65', name: 'Ruy Lopez Berlin Defense', color: 'white', result: 'win' });
  }
  for (let i = 0; i < 6; i += 1) {
    addGame(db, { eco: 'B10', name: 'Caro-Kann Defense', color: 'black', result: 'loss' });
  }
}

describe('lens keys', () => {
  test('an unfiltered lens keys as its bare scope', () => {
    // Coaching cached before openings existed is keyed by a plain scope string, and
    // those rows have to keep hitting or every player silently loses their summaries.
    assert.equal(lensKey({ scope: 'all' }), 'all');
    assert.equal(lensKey({ scope: 'blitz' }), 'blitz');
    assert.equal(lensKey({ scope: 'blitz', eco: null, color: null }), 'blitz');
  });

  test('an opening and a side are both part of the key', () => {
    assert.equal(lensKey({ scope: 'all', eco: 'C65' }), 'all:C65');
    assert.equal(lensKey({ scope: 'all', eco: 'C65', color: 'white' }), 'all:C65:white');
    assert.notEqual(
      lensKey({ scope: 'all', eco: 'C65', color: 'white' }),
      lensKey({ scope: 'all', eco: 'C65', color: 'black' }),
    );
  });
});

describe('lens clauses', () => {
  test('colour narrows an opening and never stands alone', () => {
    // A lens carrying a colour but no opening would filter to "every game I had
    // White", which is a different question nobody asked.
    assert.equal(lensClause({ scope: 'all', color: 'white' }), '');
    assert.match(lensClause({ scope: 'all', eco: 'C65', color: 'white' }), /player_color = @color/);
  });

  test('the alias follows the query it is spliced into', () => {
    assert.equal(lensClause({ scope: 'blitz' }), ' AND g.time_class = @scope');
    assert.equal(lensClause({ scope: 'blitz' }, ''), ' AND time_class = @scope');
  });
});

describe('parseLens', () => {
  test('reads a lens out of query parameters', () => {
    assert.deepEqual(parseLens({ scope: 'blitz', eco: 'C65', color: 'white' }), {
      scope: 'blitz',
      eco: 'C65',
      color: 'white',
    });
    assert.deepEqual(parseLens({ scope: 'all', eco: 'c65' }), { scope: 'all', eco: 'C65' });
  });

  test('anything that is not an ECO code widens the lens rather than emptying it', () => {
    // These arrive from a URL anyone can edit. Widening shows the player their games;
    // passing the value through would show them nothing and explain nothing.
    for (const eco of ['Z99', 'C6', 'C655', "'; DROP TABLE games;--", '', 'C65 OR 1=1']) {
      assert.equal(parseLens({ scope: 'all', eco }).eco, undefined, `accepted ${eco}`);
    }
    assert.deepEqual(parseLens({ scope: 'rocket-chess' }), { scope: 'all' });
    assert.equal(parseLens({ scope: 'all', color: 'white' }).color, undefined);
    assert.equal(parseLens({ scope: 'all', eco: 'C65', color: 'green' }).color, undefined);
  });
});

describe('the sheet through an opening', () => {
  test('narrows every number to that opening', () => {
    const db = freshDb();
    twoOpenings(db);

    const all = dashboard(db, 1, { scope: 'all' });
    const berlin = dashboard(db, 1, { scope: 'all', eco: 'C65', color: 'white' });

    assert.equal(all.headline.games, 16);
    assert.equal(berlin.headline.games, 10);
    assert.equal(berlin.headline.record.win, 10);
    assert.equal(berlin.headline.record.loss, 0);
    // The lens is echoed back, so a screen cannot label one lens's figures with another's.
    assert.deepEqual(berlin.lens, { scope: 'all', eco: 'C65', color: 'white' });
    db.close();
  });

  test('the side is part of the filter, not decoration', () => {
    const db = freshDb();
    twoOpenings(db);
    // The Berlin games are all as White, so asking for them as Black is a real question
    // with the answer "none" — not a colour label quietly ignored.
    assert.equal(dashboard(db, 1, { scope: 'all', eco: 'C65', color: 'black' }).headline.games, 0);
    db.close();
  });

  test('the opening menu does not collapse to the opening you picked', () => {
    const db = freshDb();
    twoOpenings(db);

    // Narrowed by its own menu entry, the picker would offer one option and there
    // would be no way back out of the filter.
    const menu = openings(db, 1, { scope: 'all', eco: 'C65', color: 'white' });
    assert.deepEqual(
      menu.map((row) => row.eco).sort(),
      ['B10', 'C65'],
    );
    db.close();
  });

  test('the time-class band counts through the opening', () => {
    const db = freshDb();
    for (let i = 0; i < 4; i += 1) addGame(db, { eco: 'C65', timeClass: 'blitz' });
    for (let i = 0; i < 7; i += 1) addGame(db, { eco: 'C65', timeClass: 'rapid' });
    for (let i = 0; i < 9; i += 1) addGame(db, { eco: 'B10', timeClass: 'rapid' });

    const band = dashboard(db, 1, { scope: 'all', eco: 'C65', color: 'white' }).timeClasses;
    const byClass = new Map(band.map((row) => [row.timeClass, row.games]));
    // Not 16 rapid games: seven of them are the opening being looked at.
    assert.equal(byClass.get('rapid'), 7);
    assert.equal(byClass.get('blitz'), 4);
    db.close();
  });

  test('patterns and the library narrow with it', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i += 1) addGame(db, { eco: 'C65', motif: 'hung-piece' });
    for (let i = 0; i < 5; i += 1) addGame(db, { eco: 'B10', motif: 'allowed-fork', color: 'black' });

    const berlin = detectPatterns(db, 1, { scope: 'all', eco: 'C65', color: 'white' });
    assert.deepEqual(
      berlin.map((pattern) => pattern.motif),
      ['hung-piece'],
    );

    const { total } = listGames(db, 1, { eco: 'C65', color: 'white', limit: 100 });
    assert.equal(total, 5);
    assert.equal(listGames(db, 1, { eco: 'C65', color: 'black', limit: 100 }).total, 0);
    db.close();
  });

  test('the scouting report drops the trait that is just the filter read back', () => {
    const db = freshDb();
    twoOpenings(db);

    const report = profile(db, 1, { scope: 'all', eco: 'C65', color: 'white' });
    const traits = [...report.strengths, ...report.weaknesses];
    assert.ok(traits.length >= 0);
    assert.equal(
      traits.some((trait) => trait.key.startsWith('opening-')),
      false,
      '"comfortable in the Berlin" is not a finding when the Berlin is the filter',
    );
    db.close();
  });
});

describe('coaching cache', () => {
  test('an opening does not overwrite the time class it came from', () => {
    const db = freshDb();
    const body = (headline: string): Coaching => ({
      headline,
      diagnosis: headline,
      patterns: [],
      studyPlan: [],
      model: 'offline',
      generatedAt: 1,
    });

    writeCachedCoaching(db, 1, { scope: 'blitz' }, body('every blitz game'));
    writeCachedCoaching(db, 1, { scope: 'blitz', eco: 'C65', color: 'white' }, body('the Berlin'));

    assert.equal(readCachedCoaching(db, 1, { scope: 'blitz' })?.headline, 'every blitz game');
    assert.equal(
      readCachedCoaching(db, 1, { scope: 'blitz', eco: 'C65', color: 'white' })?.headline,
      'the Berlin',
    );
    // A lens that was never summarised is a miss, not somebody else's summary.
    assert.equal(readCachedCoaching(db, 1, { scope: 'blitz', eco: 'B10' }), null);
    db.close();
  });
});

describe('lensLabel', () => {
  test('reads as a sentence, because it goes into one', () => {
    assert.equal(lensLabel({ scope: 'all' }), 'all time controls');
    assert.equal(lensLabel({ scope: 'blitz' }), 'blitz');
    assert.equal(lensLabel({ scope: 'blitz', eco: 'C65', color: 'black' }), 'C65 as black, blitz');
  });
});
