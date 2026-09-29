/**
 * Claude's reading of one game.
 *
 * Stockfish says what every move was worth. It does not say which of a dozen
 * imperfect moves actually lost the game, what you were probably thinking when you
 * played it, or what the better move was *for*. This is the brief that asks Claude
 * those questions, the shape it answers in, and the cache that keeps the answer, so
 * a game is read once rather than every time it is opened.
 *
 * Claude is handed the engine's work and asked to explain it, never to redo it: every
 * evaluation, verdict and engine line in the brief is fact it must not contradict.
 * That division is the point. The engine is right about the numbers and has nothing
 * to say about people; Claude is good at people and should not be trusted to count.
 *
 * Portable like the rest of core: the brief and the cache run anywhere, and only the
 * asking needs Claude Code on a computer.
 */
import { Chess } from 'chess.js';
import { z } from 'zod';
import type { DB } from './db.js';
import type { GameRow, MoveRow } from './store.js';
import type { Pattern } from './patterns.js';
import { MOTIF_LABELS } from './motifs.js';

export const GameReviewSchema = z.object({
  summary: z
    .string()
    .describe('Two or three sentences on how this game was won, lost or drawn, told to the player from their side.'),
  turningPoints: z
    .array(
      z.object({
        ply: z.number().int().describe('The ply of the move, exactly as numbered in the brief.'),
        title: z
          .string()
          .describe(
            'A few words naming what happened, without the move itself, which is shown beside it — like "left the knight on e5 undefended".',
          ),
        explanation: z
          .string()
          .describe(
            'Two or three sentences: what the move did, what it overlooked, and the idea behind the better move.',
          ),
      }),
    )
    .describe('The two to four moments that decided the game, in the order they happened.'),
  lesson: z.string().describe('The one habit to carry from this game into the next, in one sentence.'),
  recurring: z
    .string()
    .describe(
      'If a turning point is one of the recurring patterns listed in the brief, one sentence naming it; otherwise an empty string.',
    ),
});

export type GameReviewBody = z.infer<typeof GameReviewSchema>;

export type GameReview = GameReviewBody & {
  model: string;
  generatedAt: number;
  /** The game was re-analysed after this was written, so its numbers may have moved. */
  stale: boolean;
};

export const GAME_REVIEW_PROMPT = `You are a chess coach going over one game with the player who played it, after an engine has analysed every move.

The engine's evaluations, verdicts and lines are given to you as fact. Never contradict them and never invent variations or evaluations of your own; where you describe a better move, use the engine's move and line from the brief. When you say why a move failed, say it with the reply the opponent actually played and the engine's line from there — do not describe a capture or threat the brief does not show. Your job is what the engine cannot do: explain what the numbers mean for a human, what the player most likely overlooked, and the idea behind the better move.

Pick the moments that actually decided the game — usually the largest swings, sometimes a chance the player missed after an opponent's error — not every inaccuracy. Speak to the player as "you". Be direct and specific: name pieces and squares, no praise padding, no hedging.`;

/** Everything the brief reads off a game. An exported game has no PGN, and needs none. */
export type BriefGame = Omit<GameRow, 'pgn' | 'created_at'>;

const COSTLY = new Set(['blunder', 'mistake', 'inaccuracy']);
const SEVERE = new Set(['blunder', 'mistake']);
const MARK: Record<string, string> = { blunder: '??', mistake: '?', inaccuracy: '?!', brilliant: '!!' };

export function buildGameBrief(game: BriefGame, moves: MoveRow[], patterns: Pattern[] = []): string {
  const side = game.player_color;
  const opponentSide = side === 'white' ? 'black' : 'white';
  const rating = (value: number | null) => (value === null ? '' : ` (${value})`);
  const accuracy = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);
  const lines: string[] = [];

  lines.push(
    `The player ${game[`${side}_username`]}${rating(game[`${side}_rating`])} had ${side} against ` +
      `${game[`${opponentSide}_username`]}${rating(game[`${opponentSide}_rating`])}.`,
  );
  lines.push(
    `${game.time_class} ${game.time_control}${game.eco ? `, ${game.eco_name ?? 'opening'} (${game.eco})` : ''}. ` +
      `The player ${RESULT_VERB[game.result]}${game.termination ? ` — ${game.termination}` : ''}.`,
  );
  lines.push(
    `Analysed by ${game.engine ?? 'Stockfish'}${game.analysis_depth ? ` at depth ${game.analysis_depth}` : ''}. ` +
      `Accuracy: player ${accuracy(game[`accuracy_${side}`])}, opponent ${accuracy(game[`accuracy_${opponentSide}`])}.`,
  );
  lines.push('');
  lines.push(
    "Evaluations are in pawns from the player's side: +1.5 means the player is a pawn and a half better, " +
      "-1.5 that they are worse. M3 means the player mates in 3, -M3 that they are mated in 3; # is mate delivered, -# mate suffered.",
  );

  lines.push('');
  lines.push("Every move — ply, move, evaluation after it, and the engine's verdict on the player's own moves:");
  for (const move of moves) {
    const verdict = move.is_player === 1 ? `  ${move.classification}${MARK[move.classification] ?? ''}` : '';
    lines.push(`  ply ${move.ply}  ${label(move)}  ${evalText(move, side, 'after')}${verdict}`);
  }

  const costly = moves
    .filter((move) => move.is_player === 1 && COSTLY.has(move.classification))
    .sort((a, b) => b.win_percent_loss - a.win_percent_loss)
    .slice(0, 12)
    .sort((a, b) => a.ply - b.ply);
  if (costly.length > 0) {
    lines.push('');
    lines.push("The player's costly moves, in detail:");
    for (const move of costly) {
      lines.push(
        `  ply ${move.ply}, ${label(move)}${MARK[move.classification]} (${move.classification}, lost ${move.win_percent_loss.toFixed(0)}% of their winning chances): ` +
          `evaluation ${evalText(move, side, 'before')} → ${evalText(move, side, 'after')}.`,
      );
      // The move it answered. A mistake is usually a failure to respond to something,
      // and a line like "Rxd6 wins the queen" means something quite different when the
      // queen was just traded off — then it is a recapture the player forgot.
      const previous = moves.find((candidate) => candidate.ply === move.ply - 1);
      if (previous) lines.push(`    It answered the opponent's ${label(previous)} (ply ${previous.ply}).`);
      lines.push(`    Position before it (FEN): ${move.fen_before}`);
      const line = sanLine(move.fen_before, move.pv);
      if (move.best_move_san) {
        lines.push(`    Engine's move: ${move.best_move_san}${line ? `, with the line ${line}` : ''}.`);
      }
      // What actually happened next. Without it Claude has only the position and the
      // score, and fills the gap with a plausible punishment the opponent never
      // played; with it, the explanation is of the game on the board. The reply's own
      // engine line, read from after the mistake, is the refutation spelled out.
      const reply = moves.find((candidate) => candidate.ply === move.ply + 1);
      if (reply) {
        const refutation = sanLine(reply.fen_before, reply.pv);
        lines.push(
          `    The opponent answered ${label(reply)} (ply ${reply.ply}), evaluation after it ${evalText(reply, side, 'after')}` +
            (refutation ? `; the engine's line from there: ${refutation}.` : '.'),
        );
      }
      const motifs = move.motifs
        .split(',')
        .filter(Boolean)
        .map((motif) => MOTIF_LABELS[motif] ?? motif);
      const clock = clockText(move);
      if (motifs.length > 0 || clock) {
        lines.push(`    ${motifs.length > 0 ? `Detected: ${motifs.join(', ')}.` : ''}${motifs.length > 0 && clock ? ' ' : ''}${clock}`);
      }
    }
  }

  // An opponent's error is only half an event; the other half is whether it was
  // punished. The reply is what turns "they blundered" into "you had a win and let
  // it go", which is often the real story of a lost game.
  const chances = moves.filter((move) => move.is_player === 0 && SEVERE.has(move.classification)).slice(0, 6);
  if (chances.length > 0) {
    lines.push('');
    lines.push("The opponent's errors — chances the player had:");
    for (const move of chances) {
      const reply = moves.find((candidate) => candidate.ply === move.ply + 1);
      let answer = ' The game ended there.';
      if (reply) {
        const punished = reply.classification === 'best' || reply.classification === 'brilliant';
        answer =
          ` The player replied ${label(reply)} (ply ${reply.ply}, ${reply.classification}), evaluation after it ${evalText(reply, side, 'after')}` +
          (punished || !reply.best_move_san ? '.' : `; the engine's move was ${reply.best_move_san}.`);
      }
      lines.push(
        `  ply ${move.ply}, ${label(move)} (${move.classification}): evaluation ${evalText(move, side, 'before')} → ${evalText(move, side, 'after')}.${answer}`,
      );
    }
  }

  const brilliant = moves.filter((move) => move.is_player === 1 && move.classification === 'brilliant');
  if (brilliant.length > 0) {
    lines.push('');
    lines.push(
      `Brilliant moves by the player (a sacrifice the engine also chose): ${brilliant.map((move) => `ply ${move.ply} ${label(move)}`).join(', ')}.`,
    );
  }

  if (patterns.length > 0) {
    lines.push('');
    lines.push("The player's recurring patterns across all their analysed games, worst first:");
    for (const pattern of patterns.slice(0, 5)) {
      lines.push(
        `  "${pattern.title}" — ${pattern.occurrences} times in ${pattern.gamesAffected} games. ${pattern.mechanism}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Claude's answer, held to the game it describes.
 *
 * A turning point is a link the page follows to a position, so one that names a ply
 * this game does not have is dropped rather than shown pointing nowhere. The rest are
 * put in game order and de-duplicated, which is what the prompt asked for anyway.
 */
export function settleReview(body: GameReviewBody, moves: Array<{ ply: number }>): GameReviewBody {
  const plies = new Set(moves.map((move) => move.ply));
  const seen = new Set<number>();
  const turningPoints = body.turningPoints
    .filter((point) => plies.has(point.ply) && !seen.has(point.ply) && seen.add(point.ply))
    .sort((a, b) => a.ply - b.ply);
  return { ...body, turningPoints };
}

export function readGameReview(
  db: DB,
  game: { id: number; analysed_at: number | null },
): GameReview | null {
  const row = db
    .prepare('SELECT body, model, analysed_at, created_at FROM game_reviews WHERE game_id = ?')
    .get(game.id) as { body: string; model: string; analysed_at: number | null; created_at: number } | undefined;
  if (!row) return null;
  try {
    return {
      ...(JSON.parse(row.body) as GameReviewBody),
      model: row.model,
      generatedAt: row.created_at,
      stale: row.analysed_at !== game.analysed_at,
    };
  } catch {
    return null;
  }
}

export function writeGameReview(
  db: DB,
  game: { id: number; analysed_at: number | null },
  review: GameReviewBody & { model: string; generatedAt: number },
): void {
  db.prepare(
    `INSERT INTO game_reviews (game_id, body, model, analysed_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (game_id) DO UPDATE SET
       body = excluded.body, model = excluded.model,
       analysed_at = excluded.analysed_at, created_at = excluded.created_at`,
  ).run(
    game.id,
    JSON.stringify({
      summary: review.summary,
      turningPoints: review.turningPoints,
      lesson: review.lesson,
      recurring: review.recurring,
    }),
    review.model,
    game.analysed_at,
    review.generatedAt,
  );
}

const RESULT_VERB: Record<string, string> = { win: 'won', loss: 'lost', draw: 'drew' };

function label(move: Pick<MoveRow, 'move_number' | 'color' | 'san'>): string {
  return `${move.move_number}${move.color === 'white' ? '.' : '…'} ${move.san}`;
}

/**
 * An evaluation read from the player's side.
 *
 * Stored evaluations belong to whoever moved, so the opponent's moves are turned
 * round — mates included. Get this backwards and Claude is told the player was
 * winning the positions they were losing, and will explain the game fluently and
 * wrongly.
 */
export function evalText(
  move: Pick<MoveRow, 'color' | 'eval_before' | 'eval_after' | 'mate_before' | 'mate_after'>,
  playerColor: 'white' | 'black',
  when: 'before' | 'after',
): string {
  const sign = move.color === playerColor ? 1 : -1;
  const cp = (when === 'before' ? move.eval_before : move.eval_after) * sign;
  const rawMate = when === 'before' ? move.mate_before : move.mate_after;
  if (rawMate !== null) {
    const mate = rawMate * sign;
    if (mate === 0) return cp > 0 ? '#' : '-#';
    return mate > 0 ? `M${mate}` : `-M${-mate}`;
  }
  const pawns = cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

/** The engine's line in SAN, which is what a person — or Claude — can read. */
function sanLine(fen: string, pv: string | null): string | null {
  if (!pv) return null;
  const board = new Chess(fen);
  const played: string[] = [];
  for (const uci of pv.split(' ').filter(Boolean).slice(0, 6)) {
    try {
      played.push(board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return played.length > 0 ? played.join(' ') : null;
}

function clockText(move: Pick<MoveRow, 'clock_after' | 'time_spent'>): string {
  if (move.clock_after === null) return '';
  const left = `${Math.floor(move.clock_after / 60)}:${String(Math.floor(move.clock_after % 60)).padStart(2, '0')}`;
  const spent = move.time_spent === null ? '' : `, after ${Math.round(move.time_spent)}s on the move`;
  return `Clock: ${left} left${spent}.`;
}
