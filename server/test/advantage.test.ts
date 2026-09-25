/**
 * The advantage graph draws one line for the whole game, and every claim it makes is
 * arithmetic: which side a stored evaluation belongs to, and which way is up.
 *
 * Both are easy to get backwards and neither fails loudly — a sign error draws a
 * perfectly plausible curve that says the opposite of what happened. So the sign
 * conventions are pinned here rather than read off the picture.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, describe } from 'node:test';
import { advantageCurve, advantageLine, isMarked, playerEval } from '../../web/src/graph.js';
import type { Classification, Move } from '../../web/src/types.js';

/** A move with only the columns the graph reads; the rest are never touched. */
function move(overrides: Partial<Move> & Pick<Move, 'ply' | 'color'>): Move {
  return {
    id: overrides.ply,
    game_id: 1,
    move_number: Math.ceil(overrides.ply / 2),
    is_player: 1,
    san: 'Nf3',
    uci: 'g1f3',
    fen_before: '',
    fen_after: '',
    eval_before: 0,
    eval_after: 0,
    mate_before: null,
    mate_after: null,
    cp_loss: 0,
    win_percent_loss: 0,
    accuracy: 100,
    classification: 'good' as Classification,
    best_move_uci: null,
    best_move_san: null,
    pv: null,
    phase: 'opening',
    clock_after: null,
    time_spent: null,
    motifs: '',
    ...overrides,
  } as Move;
}

describe('playerEval', () => {
  test('keeps the sign on the player own moves and flips it on the opponent', () => {
    // Evaluations are stored from the mover's side. Read straight off the row, a
    // winning opponent move would draw as the player winning.
    const mine = playerEval(move({ ply: 1, color: 'white', eval_after: 300 }), 'white');
    assert.equal(mine.cp, 300);

    const theirs = playerEval(move({ ply: 2, color: 'black', eval_after: 300 }), 'white');
    assert.equal(theirs.cp, -300);
  });

  test('flips mate scores with them', () => {
    // M3 for the opponent has to read as -M3 for the player, or the tooltip on the
    // move that lost the game announces a mate the player is about to be given.
    const theirs = playerEval(
      move({ ply: 2, color: 'black', eval_after: 9970, mate_after: 3 }),
      'white',
    );
    assert.equal(theirs.mate, -3);
    assert.equal(theirs.cp, -9970);
  });
});

describe('advantageLine', () => {
  test('starts level, so a game that opens badly has something to fall from', () => {
    const points = advantageLine(
      [move({ ply: 1, color: 'white', eval_after: -800, classification: 'blunder' })],
      'white',
    );
    assert.equal(points.length, 2);
    assert.equal(points[0]?.ply, 0);
    assert.equal(points[0]?.share, 50);
    assert.ok((points[1]?.share ?? 50) < 15, 'a lost queen should not read as a level game');
  });

  test('is one point per ply, in order, whichever colour the player had', () => {
    const moves = [
      move({ ply: 1, color: 'white', is_player: 0, eval_after: 20 }),
      move({ ply: 2, color: 'black', eval_after: 20 }),
      move({ ply: 3, color: 'white', is_player: 0, eval_after: -450 }),
    ];
    const points = advantageLine(moves, 'black');
    assert.deepEqual(
      points.map((point) => point.ply),
      [0, 1, 2, 3],
    );
    // White is 450 down at ply 3, so the player — Black — is winning there.
    assert.ok((points[3]?.share ?? 0) > 70, 'the player ahead should read as ahead');
  });
});

describe('advantageCurve', () => {
  test('puts the player at the top', () => {
    // The one orientation claim the whole picture rests on: the line rises as the
    // player gains. Y is inverted for SVG, so a winning position is a small y.
    const winning = advantageCurve(
      advantageLine([move({ ply: 1, color: 'white', eval_after: 900 })], 'white'),
    );
    const losing = advantageCurve(
      advantageLine([move({ ply: 1, color: 'white', eval_after: -900 })], 'white'),
    );
    const y = (curve: string) => Number(curve.split(' ')[1]?.split(',')[1]);
    assert.ok(y(winning) < 10, `winning should be near the top, got y=${y(winning)}`);
    assert.ok(y(losing) > 90, `losing should be near the floor, got y=${y(losing)}`);
  });

  test('is one coordinate per point, with ply as the x axis', () => {
    const points = advantageLine(
      [
        move({ ply: 1, color: 'white' }),
        move({ ply: 2, color: 'black' }),
        move({ ply: 3, color: 'white' }),
      ],
      'white',
    );
    const coordinates = advantageCurve(points).split(' ');
    assert.equal(coordinates.length, 4);
    assert.deepEqual(
      coordinates.map((pair) => pair.split(',')[0]),
      ['0', '1', '2', '3'],
    );
  });
});

describe('the dots', () => {
  test('mark the player own leaks and brilliancies, and nothing else', () => {
    const marked = (overrides: Partial<Move>) => {
      const points = advantageLine([move({ ply: 1, color: 'white', ...overrides })], 'white');
      return points.filter(isMarked).length === 1;
    };

    assert.ok(marked({ classification: 'blunder' }));
    assert.ok(marked({ classification: 'mistake' }));
    assert.ok(marked({ classification: 'inaccuracy' }));
    assert.ok(marked({ classification: 'brilliant' }));

    // A dot on every good move is a dot on nothing.
    assert.ok(!marked({ classification: 'best' }));
    assert.ok(!marked({ classification: 'excellent' }));
    assert.ok(!marked({ classification: 'good' }));

    // Vermilion is the player's own mistakes. The opponent's are not the subject.
    assert.ok(!marked({ classification: 'blunder', is_player: 0 }));
  });

  test('never marks the starting position, which nobody played', () => {
    assert.ok(!isMarked({ ply: 0, share: 50, cp: 0, mate: null, move: null }));
  });
});

describe('the graph styles', () => {
  const STYLES = readFileSync(resolve(import.meta.dirname, '../../web/src/styles.css'), 'utf8');

  // The plot picks its two colours from a class built out of the player's colour.
  // Define only one of them and the graph is a blank box for half the games in the
  // library — which the type checker cannot see, because the class is a string.
  for (const colour of ['white', 'black']) {
    test(`a player with ${colour} gets both territories`, () => {
      const rule = new RegExp(`\\.is-you-${colour}(?![\\w-])`, 'g');
      const matches = STYLES.match(rule) ?? [];
      assert.ok(
        matches.length >= 2,
        `is-you-${colour} needs a background and an area fill, found ${matches.length} rules`,
      );
    });
  }
});
