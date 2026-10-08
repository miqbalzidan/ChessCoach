/**
 * What analysing one game may and may not write.
 *
 * Found by tapping "analyse this game" on a phone seeded from an export: the game had
 * no moves (exports carry results, not PGNs), the analysis came back empty at 100%
 * for both sides, and it was saved — a flawless game that never happened, averaged
 * into the sheet. These pin the three halves of the fix: such a game is refused, a
 * batch says so instead of saving it, and a database it already happened to is
 * repaired the next time it opens.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, type DB } from '../../core/src/db.ts';
import { analysePending, createJob, getJob } from '../../core/src/importer.ts';
import { getGame, getMoves, saveAnalysis, upsertPlayer } from '../../core/src/store.ts';
import { dashboard } from '../../core/src/stats.ts';
import type { EnginePool } from '../../core/src/engine.ts';
import type { AnalysedMove, GameAnalysis } from '../../core/src/types.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  upsertPlayer(db, 'tester');
  return db;
}

function addGame(db: DB, id: number, pgn: string, analysedAt: number | null = null): void {
  db.prepare(
    `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control, end_time,
                        white_username, black_username, player_color, result, opponent,
                        move_count, analysed_at, analysis_depth, engine, accuracy_white,
                        accuracy_black, created_at)
     VALUES (?, 1, ?, 'chess.com', ?, 'blitz', '300+0', ?, 'tester', 'other', 'white', 'win',
             'other', 1, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id, `g${id}`, pgn, 1_700_000_000 + id,
    analysedAt, analysedAt ? 16 : null, analysedAt ? 'Stockfish 16' : null,
    analysedAt ? 100 : null, analysedAt ? 100 : null,
  );
}

function oneMove(overrides: Partial<AnalysedMove> = {}): GameAnalysis {
  const move: AnalysedMove = {
    ply: 1, moveNumber: 1, color: 'white', san: 'e4', uci: 'e2e4',
    fenBefore: START, fenAfter: AFTER_E4,
    evalBefore: 20, evalAfter: 30, mateBefore: null, mateAfter: null,
    centipawnLoss: 0, winPercentLoss: 0, accuracy: 100, classification: 'best',
    bestMoveUci: 'e2e4', bestMoveSan: 'e4', pv: ['e2e4'], phase: 'opening',
    clockAfter: null, timeSpent: null, motifs: [],
    ...overrides,
  };
  return { moves: [move], accuracyWhite: 90, accuracyBlack: 90, depth: 16, engine: 'Stockfish 16' };
}

/** Nothing here should reach the engine; if it does, the test says so. */
const engineThatMustNotRun = {
  engineName: 'unused',
  size: 1,
  search: () => Promise.reject(new Error('the engine was asked about a game with no moves')),
} as unknown as EnginePool;

describe('a game with no moves', () => {
  test('"analyse pending" leaves it waiting and says why, once', async () => {
    const db = freshDb();
    addGame(db, 1, '');
    addGame(db, 2, '');
    const job = createJob(db, 'tester');

    await analysePending(db, engineThatMustNotRun, job.id, 1, 8);

    assert.equal(getGame(db, 1)!.analysed_at, null);
    assert.equal(getGame(db, 2)!.analysed_at, null);
    assert.match(getJob(db, job.id)!.message ?? '', /^2 games came from the computer without their moves/);
  });

  test('one already saved as a flawless game is put back when the database opens', () => {
    const db = freshDb();
    addGame(db, 1, '', 1_800_000_000); // what the bug left behind
    addGame(db, 2, '1. e4 *', 1_800_000_000); // a real analysed game
    saveAnalysis(db, getGame(db, 2)!, oneMove());
    const stamped = getGame(db, 2)!.analysed_at;

    assert.equal(dashboard(db, 1, { scope: 'all' }).headline.analysedGames, 2);
    migrate(db);

    const repaired = getGame(db, 1)!;
    assert.equal(repaired.analysed_at, null);
    assert.equal(repaired.accuracy_white, null);
    assert.equal(repaired.engine, null);
    assert.equal(getGame(db, 2)!.analysed_at, stamped, 'a real analysed game is left alone');
    assert.equal(dashboard(db, 1, { scope: 'all' }).headline.analysedGames, 1);
  });
});

describe('analysing a game again', () => {
  // The upsert refreshed every number but the mate columns, so a deeper search that
  // found (or lost) a mate left the old "M3" beside the new evaluation.
  test('refreshes the mate columns along with the evaluation', () => {
    const db = freshDb();
    addGame(db, 1, '1. e4 *');
    saveAnalysis(db, getGame(db, 1)!, oneMove({ evalAfter: 9997, mateAfter: 3 }));
    saveAnalysis(db, getGame(db, 1)!, oneMove({ evalAfter: 120, mateAfter: null }));

    const [move] = getMoves(db, 1);
    assert.equal(move!.eval_after, 120);
    assert.equal(move!.mate_after, null);
  });
});
