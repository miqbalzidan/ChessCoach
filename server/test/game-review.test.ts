/**
 * Claude's reading of one game: the brief it reads, the answer it gives, and where
 * that answer is kept.
 *
 * The brief is the part worth pinning hardest. Claude explains whatever it is told
 * fluently, so a sign error here does not fail — it produces a confident, readable
 * account of a game the player did not play. These tests use a real game, move by
 * move, so the evaluations, the engine line and the FEN are the ones production sees.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { Chess } from 'chess.js';
import { z } from 'zod';
import { migrate, type DB } from '../../core/src/db.js';
import {
  buildGameBrief,
  evalText,
  GameReviewSchema,
  readGameReview,
  settleReview,
  writeGameReview,
  type GameReviewBody,
} from '../../core/src/game-review.js';
import { deletePlayerData, getGame, getMoves, upsertPlayer, type MoveRow } from '../../core/src/store.js';
import { seedFromSnapshot } from '../../core/src/seed-snapshot.js';
import { buildSnapshot } from '../../web/src/snapshot-build.js';
import { ClaudeUnavailable, mainModel, readResult, schemaArgument } from '../src/claude-code.js';
import { CoachingSchema } from '../../core/src/coach.js';
import type { Pattern } from '../../core/src/patterns.js';

/**
 * 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7# — the player had Black.
 *
 * Evaluations are stored from the mover's side, exactly as the analysis writes them.
 * White's 3. Qh5 is marked a mistake so the brief has an opponent's error to report,
 * with the player's reply — the blunder — as the chance that was not taken.
 */
const LINE: Array<{
  san: string;
  before: number;
  after: number;
  mateBefore?: number;
  mateAfter?: number;
  classification: string;
  best?: [string, string];
  pv?: string;
  motifs?: string;
  loss?: number;
}> = [
  { san: 'e4', before: 20, after: 30, classification: 'best' },
  { san: 'e5', before: -30, after: -25, classification: 'best' },
  { san: 'Bc4', before: 25, after: 30, classification: 'good' },
  { san: 'Nc6', before: -30, after: -28, classification: 'good' },
  { san: 'Qh5', before: 28, after: -40, classification: 'mistake', best: ['g1f3', 'Nf3'] },
  {
    san: 'Nf6',
    before: 40,
    after: -10000,
    mateAfter: -1,
    classification: 'blunder',
    best: ['g7g6', 'g6'],
    pv: 'g7g6 h5f3 g8f6',
    motifs: 'allowed-mate',
    loss: 54,
  },
  { san: 'Qxf7#', before: 10000, after: 10000, mateBefore: 1, mateAfter: 0, classification: 'best' },
];

function freshDb(): DB {
  const db = new Database(':memory:') as unknown as DB;
  migrate(db);
  return db;
}

function seededGame(db: DB): number {
  upsertPlayer(db, 'tester');
  db.prepare(
    `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                        end_time, white_username, black_username, white_rating, black_rating,
                        eco, eco_name, player_color, result, termination, opponent,
                        move_count, accuracy_white, accuracy_black, analysis_depth, engine,
                        analysed_at, created_at)
     VALUES (1, 1, 'g1', 'chess.com', '', 'blitz', '300+0', 1700000000, 'other', 'tester',
             1500, 1480, 'C23', 'Bishop''s Opening', 'black', 'loss', 'checkmate', 'other',
             4, 88.1, 41.7, 16, 'Stockfish 16', 111, 0)`,
  ).run();

  const board = new Chess();
  LINE.forEach((spec, index) => {
    const ply = index + 1;
    const fenBefore = board.fen();
    const move = board.move(spec.san);
    db.prepare(
      `INSERT INTO moves (game_id, ply, move_number, color, is_player, san, uci, fen_before,
                          fen_after, eval_before, eval_after, mate_before, mate_after, cp_loss,
                          win_percent_loss, accuracy, classification, best_move_uci,
                          best_move_san, pv, phase, clock_after, time_spent, motifs)
       VALUES (1, @ply, @number, @color, @isPlayer, @san, @uci, @fenBefore, @fenAfter,
               @before, @after, @mateBefore, @mateAfter, 0, @loss, 50, @classification,
               @bestUci, @bestSan, @pv, 'opening', @clock, @spent, @motifs)`,
    ).run({
      ply,
      number: Math.ceil(ply / 2),
      color: ply % 2 === 1 ? 'white' : 'black',
      isPlayer: ply % 2 === 0 ? 1 : 0,
      san: move.san,
      uci: `${move.from}${move.to}`,
      fenBefore,
      fenAfter: board.fen(),
      before: spec.before,
      after: spec.after,
      mateBefore: spec.mateBefore ?? null,
      mateAfter: spec.mateAfter ?? null,
      loss: spec.loss ?? 0,
      classification: spec.classification,
      bestUci: spec.best?.[0] ?? null,
      bestSan: spec.best?.[1] ?? null,
      pv: spec.pv ?? null,
      clock: ply === 6 ? 12.4 : null,
      spent: ply === 6 ? 8 : null,
      motifs: spec.motifs ?? '',
    });
  });
  return 1;
}

const PATTERN = {
  key: 'allowed-mate:blunder',
  title: 'Allowing a forced mate',
  occurrences: 7,
  gamesAffected: 5,
  mechanism: 'You make a natural developing move without checking what the queen threatens.',
} as unknown as Pattern;

describe('the brief Claude reads', () => {
  test('evaluations are turned round for the opponent’s moves, mates included', () => {
    const db = freshDb();
    seededGame(db);
    const moves = getMoves(db, 1) as MoveRow[];

    // 3. Qh5 is stored as -0.40 for White, the mover: that is +0.4 for the player.
    assert.equal(evalText(moves[4]!, 'black', 'after'), '+0.4');
    assert.equal(evalText(moves[4]!, 'black', 'before'), '-0.3');
    // 3… Nf6 is the player's own move: mated in one, from their side, is -M1.
    assert.equal(evalText(moves[5]!, 'black', 'after'), '-M1');
    // 4. Qxf7# is mate delivered by the mover, which is mate suffered by the player.
    assert.equal(evalText(moves[6]!, 'black', 'after'), '-#');
  });

  test('carries every move, the costly one in full, and the chance that was missed', () => {
    const db = freshDb();
    seededGame(db);
    const game = getGame(db, 1)!;
    const brief = buildGameBrief(game, getMoves(db, 1) as MoveRow[], [PATTERN]);

    assert.match(brief, /The player tester \(1480\) had black against other \(1500\)\./);
    assert.match(brief, /The player lost — checkmate\./);
    assert.match(brief, /Accuracy: player 41\.7%, opponent 88\.1%\./);

    // Every ply is listed, and verdicts only ever sit on the player's own moves.
    for (let ply = 1; ply <= LINE.length; ply += 1) assert.match(brief, new RegExp(`ply ${ply} `));
    assert.match(brief, /ply 6 {2}3… Nf6 {2}-M1 {2}blunder\?\?/);
    assert.match(brief, /ply 5 {2}3\. Qh5 {2}\+0\.4\n/);

    // The engine's line arrives in SAN, converted from the stored UCI.
    assert.match(brief, /Engine's move: g6, with the line g6 Qf3 Nf6\./);
    // What it was answering, and what actually followed, so the explanation is of this
    // game and not a guess — both were missing from the first real run's brief.
    assert.match(brief, /It answered the opponent's 3\. Qh5 \(ply 5\)\./);
    assert.match(brief, /The opponent answered 4\. Qxf7# \(ply 7\), evaluation after it -#\./);
    assert.match(brief, /Position before it \(FEN\): r1bqkbnr\/pppp1ppp\/2n5\/4p2Q\/2B1P3\/8\/PPPP1PPP\/RNB1K1NR b KQkq - 3 3/);
    assert.match(brief, /Detected: Allowed forced mate\. Clock: 0:12 left, after 8s on the move\./);

    // The opponent's error is paired with what the player did about it.
    assert.match(
      brief,
      /ply 5, 3\. Qh5 \(mistake\): evaluation -0\.3 → \+0\.4\. The player replied 3… Nf6 \(ply 6, blunder\), evaluation after it -M1; the engine's move was g6\./,
    );

    assert.match(brief, /"Allowing a forced mate" — 7 times in 5 games\. You make a natural developing move/);
  });
});

describe('Claude’s answer', () => {
  test('a turning point on a ply the game does not have is dropped, the rest put in order', () => {
    const body: GameReviewBody = {
      summary: 's',
      turningPoints: [
        { ply: 6, title: 'b', explanation: 'x' },
        { ply: 99, title: 'nowhere', explanation: 'x' },
        { ply: 5, title: 'a', explanation: 'x' },
        { ply: 6, title: 'again', explanation: 'x' },
      ],
      lesson: 'l',
      recurring: '',
    };
    const settled = settleReview(body, LINE.map((_, index) => ({ ply: index + 1 })));
    assert.deepEqual(
      settled.turningPoints.map((point) => [point.ply, point.title]),
      [
        [5, 'a'],
        [6, 'b'],
      ],
    );
  });

  const Shape = z.object({ answer: z.string() });

  test('reads the structured answer and the model that wrote it', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      structured_output: { answer: 'ok' },
      modelUsage: { 'claude-haiku-4-5': { outputTokens: 40 }, 'claude-sonnet-5-5': { outputTokens: 900 } },
    });
    assert.deepEqual(readResult(stdout, Shape), { value: { answer: 'ok' }, model: 'claude-sonnet-5-5' });
  });

  test('a failure inside Claude Code arrives as its own words', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' });
    assert.throws(
      () => readResult(stdout, Shape),
      (error: unknown) =>
        error instanceof ClaudeUnavailable && error.message === 'Claude Code: Not logged in · Please run /login',
    );
  });

  test('no JSON at all, and JSON of the wrong shape, are both reasons, not crashes', () => {
    assert.throws(
      () => readResult('', Shape, { stderr: 'segfault somewhere\n', code: 139 }),
      (error: unknown) => error instanceof ClaudeUnavailable && /exit 139.*segfault somewhere/.test(error.message),
    );
    assert.throws(
      () => readResult(JSON.stringify({ is_error: false, structured_output: { nope: 1 } }), Shape),
      ClaudeUnavailable,
    );
  });

  test('with no usage reported, the model is still named', () => {
    assert.equal(mainModel(undefined), 'claude');
  });

  // Found by the first real run: Claude Code rejects the 2020-12 meta-schema URI zod
  // stamps on by default, and refuses the whole request over it.
  test('the schema handed to Claude Code carries no meta-schema stamp', () => {
    for (const schema of [GameReviewSchema, CoachingSchema]) {
      const sent = JSON.parse(schemaArgument(schema)) as Record<string, unknown>;
      assert.equal('$schema' in sent, false);
      assert.equal(sent.type, 'object');
    }
  });
});

describe('where a reading is kept', () => {
  const written = {
    summary: 'You lost to the oldest trap there is.',
    turningPoints: [{ ply: 6, title: 'Nf6 ignored the queen', explanation: 'x' }],
    lesson: 'Before developing, ask what the queen attacks.',
    recurring: 'This is your allowed-mate pattern again.',
    model: 'claude-sonnet-5-5',
    generatedAt: 1_800_000_000,
  };

  test('it round-trips, and goes stale when the game is analysed again', () => {
    const db = freshDb();
    seededGame(db);
    const game = getGame(db, 1)!;
    assert.equal(readGameReview(db, game), null);

    writeGameReview(db, game, written);
    const read = readGameReview(db, game)!;
    assert.equal(read.lesson, written.lesson);
    assert.equal(read.model, 'claude-sonnet-5-5');
    assert.equal(read.generatedAt, 1_800_000_000);
    assert.equal(read.stale, false);

    db.prepare('UPDATE games SET analysed_at = 222 WHERE id = 1').run();
    assert.equal(readGameReview(db, getGame(db, 1)!)!.stale, true);
  });

  test('deleting a player’s games deletes their readings, foreign keys or not', () => {
    const db = freshDb();
    seededGame(db);
    writeGameReview(db, getGame(db, 1)!, written);
    deletePlayerData(db, 1);
    const left = db.prepare('SELECT COUNT(*) AS n FROM game_reviews').get() as { n: number };
    assert.equal(left.n, 0);
  });

  test('an export carries it, and a phone seeded from the export has it under its own ids', async () => {
    const computer = freshDb();
    seededGame(computer);
    writeGameReview(computer, getGame(computer, 1)!, written);
    const snapshot = await buildSnapshot(computer, 'tester');
    assert.equal(snapshot.reviews?.['1']?.lesson, written.lesson);

    // A phone that already holds a game, so the seeded one cannot keep id 1.
    const phone = freshDb();
    upsertPlayer(phone, 'someone-else');
    phone
      .prepare(
        `INSERT INTO games (player_id, external_id, source, pgn, time_class, time_control, end_time,
                            white_username, black_username, player_color, result, opponent, created_at)
         VALUES (1, 'x', 'test', '', 'blitz', '60', 1, 'a', 'b', 'white', 'win', 'b', 0)`,
      )
      .run();
    seedFromSnapshot(phone, snapshot as unknown as Parameters<typeof seedFromSnapshot>[1]);

    const seeded = phone.prepare("SELECT id, analysed_at FROM games WHERE external_id = 'g1'").get() as {
      id: number;
      analysed_at: number;
    };
    assert.notEqual(seeded.id, 1);
    const review = readGameReview(phone, seeded)!;
    assert.equal(review.lesson, written.lesson);
    assert.equal(review.stale, false);
  });
});
