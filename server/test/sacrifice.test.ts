/**
 * What counts as a sacrifice, and therefore what counts as brilliant.
 *
 * These run on stored positions rather than through the engine, because
 * `classifyStoredMove` is a pure function of facts the database already holds. That
 * is what makes them fast enough to cover the awkward cases, and it is the same
 * function `analyseGame` calls, so nothing here can pass while the live path differs.
 *
 * Every position below is a real one: four from games in the development database
 * that were labelled brilliant and should not have been, and Morphy's Opera Game,
 * which must survive any rule claiming to recognise a sacrifice.
 */
import { strict as assert } from 'node:assert';
import { Chess } from 'chess.js';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { classifyStoredMove } from '../../core/src/analysis.js';
import { migrate, type DB } from '../../core/src/db.js';
import { upsertPlayer } from '../../core/src/store.js';
import { reclassify } from '../src/reclassify.js';
import type { Classification } from '../../core/src/types.js';

/**
 * Play `san` and ask what it was.
 *
 * The move played is handed in as the engine's choice as well, so `best` is the only
 * verdict available if the position is not a sacrifice — which isolates the one rule
 * under test instead of letting a win-percentage threshold decide the outcome.
 */
function verdictFor(fen: string, san: string, evals = { before: 20, after: 20 }): Classification {
  const board = new Chess(fen);
  const fenBefore = board.fen();
  const move = board.move(san);
  const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
  return classifyStoredMove({
    fenBefore,
    fenAfter: board.fen(),
    uci,
    evalBefore: evals.before,
    evalAfter: evals.after,
    bestUci: uci,
  });
}

describe('a piece the opponent cannot legally take is not a sacrifice', () => {
  // The bug these cover: `attackers()` is pseudo-legal, so an enemy king beside the
  // square counted as an attacker even when its own side covered that square and the
  // king was forbidden to enter. `PIECE_VALUE.k` being 0 then made the recapture look
  // free, and a piece that was never in danger read as material thrown away.

  test('a bishop checking from a square the king may not enter', () => {
    // m_arroyo vs bright_rook, move 43. Bxd3+ is safe: Kxd3 would walk into the c4
    // pawn. The evaluation says so too — 0.00 before and 0.00 after — and the engine
    // line is a repetition, not a breakthrough.
    assert.equal(
      verdictFor('6k1/5p2/p3r2B/b1p2p2/2p3p1/3P4/1PK1b3/2R4Q b - - 3 43', 'Bxd3+', {
        before: 0,
        after: 0,
      }),
      'best',
    );
  });

  test('the same bishop, one move later, from the other square', () => {
    // Be2+ is covered by the rook on e6, so again the king cannot take.
    assert.equal(
      verdictFor('6k1/5p2/p3r2B/b1p2p2/2p3p1/3b4/1P6/2RK3Q b - - 1 44', 'Be2+', {
        before: 0,
        after: 0,
      }),
      'best',
    );
  });

  test('a knight forking two pieces that nothing can capture', () => {
    // Nxf7 forks the queen and the rook. It wins material outright; the king cannot
    // take because the bishop on c4 covers f7. Winning a piece is not giving one up.
    assert.equal(
      verdictFor('r1bqkb1r/pp1p1ppp/2n2n2/2p1N3/2B1P3/8/PPPP1PPP/RNBQK2R w KQkq - 3 5', 'Nxf7', {
        before: 371,
        after: 378,
      }),
      'best',
    );
  });

  test('a rook on a square with no capture available at all', () => {
    assert.equal(
      verdictFor('3r1rk1/1p3pp1/p3p2p/P6P/1b6/nPp4P/2P1PPBB/2R1K2R b K - 4 23', 'Rd2', {
        before: 197,
        after: 218,
      }),
      'best',
    );
  });
});

describe('a real sacrifice is still a sacrifice', () => {
  test('Morphy, Opera Game 1858, 13. Rxd7', () => {
    // The case a one-recapture rule cannot see. Rxd7 takes a knight and is met by
    // Nxd7; White takes back with the bishop, and Black takes the bishop. Four ply
    // in, White is two pawns down — which is the whole point of the move.
    assert.equal(
      verdictFor('r2qkb1r/pp1n1ppp/2n1b3/1B2p1B1/4P3/1QN5/PPP2PPP/2KR3R w kq - 0 13', 'Rxd7', {
        before: 190,
        after: 210,
      }),
      'brilliant',
    );
  });

  test('a knight left where only a pawn can take it', () => {
    assert.equal(
      verdictFor('rnbqkb1r/ppp1pppp/8/3p4/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 0 3', 'Nd5'),
      'brilliant',
    );
  });
});

describe('ordinary moves are not sacrifices', () => {
  test('an even trade: a knight taken back by a pawn', () => {
    assert.equal(
      verdictFor('r1bqkb1r/ppp2ppp/2n5/3n4/3P4/2N2N2/PPP1PPPP/R1BQKB1R w KQkq - 0 6', 'Nxd5'),
      'best',
    );
  });

  test('a quiet developing move', () => {
    assert.equal(
      verdictFor('rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3', 'Be2'),
      'best',
    );
  });

  test('taking a free pawn', () => {
    assert.equal(
      verdictFor('rnbqkb1r/pppp1ppp/5n2/4p3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 3', 'Nxe5'),
      'best',
    );
  });
});

describe('rewriting verdicts already on disk', () => {
  // The fix above is worthless if it only reaches games analysed after it lands. It
  // does not have to: every input to a verdict is a stored column, so the archive can
  // be re-judged without the engine. These cover the two properties that make that
  // safe — it settles, and it touches nothing but the verdict.

  /** One real move, stored with a verdict the current rules disagree with. */
  function archiveWithOneBadVerdict(): DB {
    const db = new Database(':memory:') as unknown as DB;
    migrate(db);
    upsertPlayer(db, 'tester');
    db.prepare(
      `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                          end_time, white_username, black_username, player_color, result,
                          opponent, move_count, accuracy_white, accuracy_black,
                          analysis_depth, engine, analysed_at, created_at)
       VALUES (1, 1, 'g1', 'chess.com', '', 'blitz', '600+0', 0, 'other', 'tester', 'black',
               'draw', 'other', 1, 70.5, 80.25, 16, 'Stockfish 16', 1, 0)`,
    ).run();
    // The bishop check from a square the enemy king is forbidden to enter.
    db.prepare(
      `INSERT INTO moves (game_id, ply, move_number, color, is_player, san, uci, fen_before,
                          fen_after, eval_before, eval_after, cp_loss, win_percent_loss,
                          accuracy, classification, best_move_uci, best_move_san, pv, phase,
                          motifs)
       VALUES (1, 86, 43, 'black', 1, 'Bxd3+', 'e2d3',
               '6k1/5p2/p3r2B/b1p2p2/2p3p1/3P4/1PK1b3/2R4Q b - - 3 43',
               '6k1/5p2/p3r2B/b1p2p2/2p3p1/3b4/1PK5/2R4Q w - - 0 44',
               0, 0, 0, 0, 100, 'brilliant', 'e2d3', 'Bxd3+', '', 'endgame', '')`,
    ).run();
    return db;
  }

  test('a second run has nothing left to do, and accuracy is never touched', () => {
    const db = archiveWithOneBadVerdict();
    const accuracyBefore = db.prepare('SELECT accuracy_white, accuracy_black FROM games').all();

    const first = reclassify(db, true);
    assert.equal(first.changes.get('brilliant → best'), 1, 'the bad verdict should be rewritten');

    const second = reclassify(db, true);
    assert.equal(second.changes.size, 0, 'a settled archive must not keep changing');

    assert.deepEqual(
      db.prepare('SELECT accuracy_white, accuracy_black FROM games').all(),
      accuracyBefore,
      'accuracy comes from win-percentage loss, not the verdict, and must not move',
    );
  });

  test('reporting is the default: nothing is written without being asked', () => {
    const db = archiveWithOneBadVerdict();

    const report = reclassify(db, false);
    assert.equal(report.changes.get('brilliant → best'), 1, 'it should still say what would change');
    assert.equal(
      (db.prepare('SELECT classification FROM moves').get() as { classification: string })
        .classification,
      'brilliant',
      'but the database must be untouched',
    );
  });
});
