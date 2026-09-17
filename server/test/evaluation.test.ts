import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  accuracyFromWinPercents,
  classifyMove,
  detectPhase,
  gameAccuracy,
  nonPawnMaterial,
  scoreToCp,
  winPercent,
  MATE_CP,
} from '../src/evaluation.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('scoreToCp', () => {
  it('passes centipawn scores through', () => {
    assert.equal(scoreToCp({ cp: 145, mate: null }), 145);
    assert.equal(scoreToCp({ cp: -30, mate: null }), -30);
  });

  it('folds mate scores into a large signed magnitude', () => {
    assert.ok(scoreToCp({ cp: null, mate: 3 }) > 9000);
    assert.ok(scoreToCp({ cp: null, mate: -3 }) < -9000);
  });

  it('ranks a faster mate above a slower one', () => {
    assert.ok(scoreToCp({ cp: null, mate: 1 }) > scoreToCp({ cp: null, mate: 8 }));
    assert.ok(scoreToCp({ cp: null, mate: -1 }) < scoreToCp({ cp: null, mate: -8 }));
  });
});

describe('winPercent', () => {
  it('is 50 at a dead level position', () => {
    assert.equal(Math.round(winPercent(0)), 50);
  });

  it('is monotonic and saturates at the extremes', () => {
    assert.ok(winPercent(100) > winPercent(0));
    assert.ok(winPercent(-100) < winPercent(0));
    assert.ok(winPercent(MATE_CP) > 96);
    assert.ok(winPercent(-MATE_CP) < 4);
  });

  it('costs more near equality than in a won position', () => {
    const nearLevel = winPercent(0) - winPercent(-300);
    const alreadyWinning = winPercent(900) - winPercent(600);
    assert.ok(nearLevel > alreadyWinning);
  });
});

describe('accuracyFromWinPercents', () => {
  it('gives a perfect score when nothing is lost', () => {
    assert.equal(Math.round(accuracyFromWinPercents(60, 60)), 100);
  });

  it('never rewards a move for improving the eval beyond best', () => {
    assert.equal(accuracyFromWinPercents(60, 90), accuracyFromWinPercents(60, 60));
  });

  it('falls as the drop grows, and stays in range', () => {
    const small = accuracyFromWinPercents(50, 45);
    const large = accuracyFromWinPercents(50, 10);
    assert.ok(small > large);
    assert.ok(large >= 0 && small <= 100);
  });
});

describe('gameAccuracy', () => {
  it('is 100 for a game with no moves', () => {
    assert.equal(gameAccuracy([], []), 100);
  });

  it('weights the volatile moments over a long quiet game', () => {
    const quiet = Array.from({ length: 40 }, () => 99);
    const withOneDisaster = [...quiet.slice(0, 39), 5];
    const steady = Array.from({ length: 40 }, () => 50);
    const swinging = [...Array.from({ length: 39 }, () => 50), 10];

    assert.ok(gameAccuracy(withOneDisaster, swinging) < gameAccuracy(quiet, steady));
  });

  it('stays within 0 and 100', () => {
    const accuracy = gameAccuracy([0, 0, 0], [50, 50, 50]);
    assert.ok(accuracy >= 0 && accuracy <= 100);
  });
});

describe('classifyMove', () => {
  const base = {
    playedUci: 'e2e4',
    bestUci: 'd2d4',
    forced: false,
    sacrifice: false,
    cpAfter: 0,
  };

  it('labels the engine move as best', () => {
    assert.equal(
      classifyMove({ ...base, bestUci: 'e2e4', winPercentBefore: 50, winPercentAfter: 50 }),
      'best',
    );
  });

  it('never blames a forced move', () => {
    assert.equal(
      classifyMove({ ...base, forced: true, winPercentBefore: 80, winPercentAfter: 10 }),
      'best',
    );
  });

  it('uses winning chances, not centipawns, for the thresholds', () => {
    assert.equal(classifyMove({ ...base, winPercentBefore: 50, winPercentAfter: 39 }), 'inaccuracy');
    assert.equal(classifyMove({ ...base, winPercentBefore: 50, winPercentAfter: 28 }), 'mistake');
    assert.equal(classifyMove({ ...base, winPercentBefore: 50, winPercentAfter: 15 }), 'blunder');
  });

  it('calls a sound sacrifice brilliant only when it is the engine move', () => {
    const sacrifice = {
      ...base,
      bestUci: 'e2e4',
      sacrifice: true,
      winPercentBefore: 55,
      winPercentAfter: 55,
      cpAfter: 120,
    };
    assert.equal(classifyMove(sacrifice), 'brilliant');
    assert.equal(classifyMove({ ...sacrifice, bestUci: 'h2h3' }), 'excellent');
  });

  it('does not reward a sacrifice in an already won position', () => {
    assert.equal(
      classifyMove({
        ...base,
        bestUci: 'e2e4',
        sacrifice: true,
        winPercentBefore: 99,
        winPercentAfter: 99,
        cpAfter: 2000,
      }),
      'best',
    );
  });
});

describe('detectPhase', () => {
  it('calls the first dozen moves the opening', () => {
    assert.equal(detectPhase(START, 3), 'opening');
  });

  it('reads the endgame off the board rather than the move number', () => {
    const fourPieces = '4k3/8/8/8/8/8/4P3/R3K2R w KQ - 0 14';
    assert.equal(detectPhase(fourPieces, 14), 'endgame');
    assert.equal(detectPhase(fourPieces, 3), 'endgame');
  });

  it('calls a full board past move 12 the middlegame', () => {
    assert.equal(detectPhase(START, 20), 'middlegame');
  });
});

describe('nonPawnMaterial', () => {
  it('counts the starting army as two rooks, two knights, two bishops and a queen', () => {
    assert.equal(nonPawnMaterial(START, 'white'), 31);
    assert.equal(nonPawnMaterial(START, 'black'), 31);
  });

  it('ignores pawns and kings', () => {
    assert.equal(nonPawnMaterial('4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1', 'white'), 0);
  });
});
