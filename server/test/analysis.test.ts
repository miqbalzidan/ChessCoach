import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parsePgn, parseIncrement, analyseGame } from '../src/analysis.ts';
import { gamesFromPgnText, inferTimeClass, splitPgns } from '../src/importer.ts';
import { EnginePool } from '../src/engine.ts';
import { detectPatterns } from '../src/patterns.ts';
import { migrate } from '../src/db.ts';
import { insertGame, saveAnalysis, upsertPlayer } from '../src/store.ts';
import { dashboard } from '../src/stats.ts';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8');

describe('parsePgn', () => {
  it('reads moves with the position on either side of each one', () => {
    const game = parsePgn(fixture('opera.pgn'));
    assert.equal(game.moves.length, 33);
    assert.equal(game.moves[0]?.san, 'e4');
    assert.equal(game.moves[0]?.color, 'white');
    assert.equal(game.moves[1]?.color, 'black');
    assert.equal(game.moves[0]?.fenAfter, game.moves[1]?.fenBefore);
    assert.equal(game.moves.at(-1)?.san, 'Rd8#');
  });

  it('pulls the headers Chess.com sets', () => {
    const game = parsePgn(fixture('blitz-clocks.pgn'));
    assert.equal(game.headers.ECO, 'C20');
    assert.equal(game.headers.TimeControl, '180+2');
    assert.equal(game.headers.White, 'm_arroyo');
  });

  it('reads per-move clocks out of the comments', () => {
    const game = parsePgn(fixture('blitz-clocks.pgn'));
    assert.equal(game.moves[0]?.clockAfter, 179.1);
    // 3...Nf6 is the long think before the blunder.
    assert.equal(game.moves[5]?.clockAfter, 18.3);
  });

  it('survives a PGN with no clocks at all', () => {
    const game = parsePgn(fixture('opera.pgn'));
    assert.equal(game.moves[0]?.clockAfter, null);
  });
});

describe('parseIncrement', () => {
  it('reads the increment from a live time control', () => {
    assert.equal(parseIncrement('180+2'), 2);
    assert.equal(parseIncrement('600'), 0);
    assert.equal(parseIncrement(undefined), 0);
    assert.equal(parseIncrement('1/86400'), 0);
  });
});

describe('inferTimeClass', () => {
  it('matches the boundaries Chess.com uses', () => {
    assert.equal(inferTimeClass('60+0'), 'bullet');
    // 2+1 estimates to 160s, which is still under the three-minute bullet line.
    assert.equal(inferTimeClass('120+1'), 'bullet');
    assert.equal(inferTimeClass('180+0'), 'blitz');
    assert.equal(inferTimeClass('180+2'), 'blitz');
    assert.equal(inferTimeClass('600+5'), 'rapid');
    assert.equal(inferTimeClass('1/86400'), 'daily');
    assert.equal(inferTimeClass('-'), 'daily');
  });
});

describe('splitPgns', () => {
  it('splits a multi-game export on the Event tag', () => {
    const text = `${fixture('opera.pgn')}\n\n${fixture('blitz-clocks.pgn')}`;
    assert.equal(splitPgns(text).length, 2);
  });

  it('returns a single game unchanged', () => {
    assert.equal(splitPgns(fixture('opera.pgn')).length, 1);
  });

  it('ignores empty input', () => {
    assert.deepEqual(splitPgns('   \n  '), []);
  });
});

describe('gamesFromPgnText', () => {
  it('resolves colour, opening and time class from the headers', () => {
    const games = gamesFromPgnText(fixture('blitz-clocks.pgn'), 'm_arroyo');
    assert.equal(games.length, 1);
    const game = games[0]!;
    assert.equal(game.timeClass, 'blitz');
    assert.equal(game.eco, 'C20');
    assert.equal(game.whiteUsername, 'm_arroyo');
    assert.equal(game.source, 'pgn');
    assert.match(game.ecoName ?? '', /Wayward Queen/);
  });

  it('skips text that is not a game', () => {
    assert.deepEqual(gamesFromPgnText('not a pgn at all', 'someone'), []);
  });
});

describe('analyseGame', () => {
  it('classifies the moves and scores the game', async (t) => {
    const pool = new EnginePool(2, 32, 1);
    t.after(() => pool.close());

    const analysis = await analyseGame(pool, fixture('blitz-clocks.pgn'), { depth: 12 });

    assert.equal(analysis.moves.length, 7);

    // 3...Nf6 walks into Qxf7#.
    const blunder = analysis.moves[5]!;
    assert.equal(blunder.san, 'Nf6');
    assert.equal(blunder.classification, 'blunder');
    assert.ok(blunder.motifs.includes('allowed-mate'));
    assert.ok(blunder.winPercentLoss > 30);

    // The mating move is best, and the mated side is far worse off than the mater.
    const mate = analysis.moves[6]!;
    assert.equal(mate.san, 'Qxf7#');
    assert.equal(mate.classification, 'best');

    assert.ok(analysis.accuracyWhite > analysis.accuracyBlack);
    assert.ok(analysis.accuracyWhite <= 100 && analysis.accuracyBlack >= 0);
  });

  it('derives time spent per move from the clocks and increment', async (t) => {
    const pool = new EnginePool(2, 32, 1);
    t.after(() => pool.close());

    const analysis = await analyseGame(pool, fixture('blitz-clocks.pgn'), { depth: 10 });
    const longThink = analysis.moves[5]!;
    // 2...Nc6 left 175.2s; 3...Nf6 left 18.3s, with 2s increment credited.
    assert.ok(longThink.timeSpent !== null && longThink.timeSpent > 150);
  });

  it('finds the rook sacrifice in the Opera Game', async (t) => {
    const pool = new EnginePool(3, 64, 1);
    t.after(() => pool.close());

    const analysis = await analyseGame(pool, fixture('opera.pgn'), { depth: 16 });
    const rookSac = analysis.moves.find((move) => move.san === 'Rxd7' && move.color === 'white');
    assert.ok(rookSac, 'expected 13. Rxd7 in the move list');
    assert.equal(rookSac!.classification, 'brilliant');
  });

  it('returns an empty analysis for a game with no moves', async (t) => {
    const pool = new EnginePool(1, 16, 1);
    t.after(() => pool.close());

    const analysis = await analyseGame(pool, '[Event "empty"]\n\n*', { depth: 8 });
    assert.deepEqual(analysis.moves, []);
    assert.equal(analysis.accuracyWhite, 100);
  });
});

describe('stats and patterns over a stored game', () => {
  it('aggregates the player side only', async (t) => {
    const pool = new EnginePool(2, 32, 1);
    const db = new Database(':memory:');
    migrate(db);
    t.after(() => {
      pool.close();
      db.close();
    });

    const player = upsertPlayer(db, 'm_arroyo');
    const [imported] = gamesFromPgnText(fixture('blitz-clocks.pgn'), 'm_arroyo');
    const gameId = insertGame(db, player.id, imported!, 'm_arroyo');
    assert.ok(gameId);

    const analysis = await analyseGame(pool, imported!.pgn, { depth: 12 });
    saveAnalysis(db, { id: gameId!, player_color: 'white' }, analysis);

    const stats = dashboard(db, player.id, { scope: 'all' });
    assert.equal(stats.headline.analysedGames, 1);
    assert.equal(stats.headline.record.win, 1);
    // Only White's four moves belong to the player.
    assert.equal(stats.headline.moves, 4);
    assert.equal(stats.headline.blundersPerGame, 0);

    const blitzOnly = dashboard(db, player.id, { scope: 'blitz' });
    assert.equal(blitzOnly.headline.analysedGames, 1);
    const bulletOnly = dashboard(db, player.id, { scope: 'bullet' });
    assert.equal(bulletOnly.headline.analysedGames, 0);

    // Clock data came through, so the pressure buckets have coverage.
    assert.ok(stats.clock.coverage > 0);

    // One game is never enough to name a pattern.
    assert.deepEqual(detectPatterns(db, player.id, { scope: 'all' }), []);
  });
});
