import { Chess } from 'chess.js';
import type { EnginePool } from './engine.js';
import {
  MATE_CP,
  accuracyFromWinPercents,
  classifyMove,
  detectPhase,
  gameAccuracy,
  round1,
  scoreToCp,
  winPercent,
} from './evaluation.js';
import { applyUci, detectMotifs, safeChess } from './motifs.js';
import { PIECE_VALUE } from './evaluation.js';
import type { AnalysedMove, Classification, Color, GameAnalysis } from './types.js';

export interface ParsedMove {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  clockAfter: number | null;
}

export interface ParsedGame {
  headers: Record<string, string>;
  moves: ParsedMove[];
  /** Increment in seconds, read from the PGN time control. */
  increment: number;
}

const CLOCK_PATTERN = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/;

export function parsePgn(pgn: string): ParsedGame {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });

  const headers = chess.getHeaders();
  const clocksByFen = new Map<string, number>();
  for (const { fen, comment } of chess.getComments()) {
    const match = CLOCK_PATTERN.exec(comment);
    if (!match) continue;
    const seconds =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    clocksByFen.set(fen, seconds);
  }

  const history = chess.history({ verbose: true });
  const moves: ParsedMove[] = history.map((move, index) => ({
    ply: index + 1,
    moveNumber: Math.floor(index / 2) + 1,
    color: move.color === 'w' ? 'white' : 'black',
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ''}`,
    fenBefore: move.before,
    fenAfter: move.after,
    clockAfter: clocksByFen.get(move.after) ?? null,
  }));

  return { headers, moves, increment: parseIncrement(headers.TimeControl) };
}

export function parseIncrement(timeControl: string | undefined): number {
  if (!timeControl) return 0;
  const match = /\+(\d+)/.exec(timeControl);
  return match ? Number(match[1]) : 0;
}

/** Where the depth lands when a caller does not say. Hosts override it from their
 *  own settings — the server from the database, the phone from a lower default. */
export const DEFAULT_DEPTH = 16;

export interface AnalyseOptions {
  depth?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Every position in the game is evaluated exactly once. The eval after a move is
 * simply the negated eval of the position the opponent inherits, which halves the
 * engine work compared with searching before and after each move separately.
 */
export async function analyseGame(
  pool: EnginePool,
  pgn: string,
  options: AnalyseOptions = {},
): Promise<GameAnalysis> {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const parsed = parsePgn(pgn);
  if (parsed.moves.length === 0) {
    return { moves: [], accuracyWhite: 100, accuracyBlack: 100, depth, engine: pool.engineName };
  }

  const positions = [parsed.moves[0]!.fenBefore, ...parsed.moves.map((m) => m.fenAfter)];
  let done = 0;

  const evaluations = await Promise.all(
    positions.map(async (fen) => {
      const terminal = terminalScore(fen);
      if (terminal) {
        done += 1;
        options.onProgress?.(done, positions.length);
        return terminal;
      }
      const lines = await pool.search(fen, depth, 1);
      done += 1;
      options.onProgress?.(done, positions.length);
      const best = lines[0];
      if (!best) return { cp: 0, mate: null as number | null, pv: [] as string[] };
      return { cp: scoreToCp(best.score), mate: best.score.mate, pv: best.pv };
    }),
  );

  const moves: AnalysedMove[] = [];
  const winPercentsBefore: Record<Color, number[]> = { white: [], black: [] };
  const accuracies: Record<Color, number[]> = { white: [], black: [] };

  for (const [index, move] of parsed.moves.entries()) {
    const before = evaluations[index]!;
    const after = evaluations[index + 1]!;

    // Both evals are reported from the side to move, so the position the opponent
    // inherits has to be flipped back into the mover's frame.
    const evalBefore = before.cp;
    const evalAfter = -after.cp;
    const mateBefore = before.mate;
    const mateAfter = after.mate === null ? null : -after.mate;

    const wpBefore = winPercent(evalBefore);
    const wpAfter = winPercent(evalAfter);
    const winPercentLoss = Math.max(0, wpBefore - wpAfter);
    const accuracy = accuracyFromWinPercents(wpBefore, wpAfter);

    const bestUci = before.pv[0] ?? null;
    const forced = countLegalMoves(move.fenBefore) === 1;

    const classification = classifyStoredMove({
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      uci: move.uci,
      evalBefore,
      evalAfter,
      bestUci,
    });

    // Only genuine mistakes get a motive. A best move that happens to sit in a
    // lost position has nothing to teach, and clustering on it would bury the
    // patterns that do.
    const isMistake =
      classification === 'inaccuracy' ||
      classification === 'mistake' ||
      classification === 'blunder';

    const motifs = isMistake
      ? detectMotifs({
          fenBefore: move.fenBefore,
          fenAfter: move.fenAfter,
          playedUci: move.uci,
          pvBefore: before.pv,
          pvAfter: after.pv,
          mateBefore,
          mateAfter,
          winPercentLoss,
          forced,
        })
      : [];

    winPercentsBefore[move.color].push(wpBefore);
    accuracies[move.color].push(accuracy);

    moves.push({
      ply: move.ply,
      moveNumber: move.moveNumber,
      color: move.color,
      san: move.san,
      uci: move.uci,
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      evalBefore: clampEval(evalBefore),
      evalAfter: clampEval(evalAfter),
      mateBefore,
      mateAfter,
      centipawnLoss: Math.max(0, Math.min(1000, evalBefore - evalAfter)),
      winPercentLoss: round1(winPercentLoss),
      accuracy: round1(accuracy),
      classification,
      bestMoveUci: bestUci,
      bestMoveSan: bestUci ? uciToSan(move.fenBefore, bestUci) : null,
      pv: before.pv.slice(0, 6),
      phase: detectPhase(move.fenBefore, move.moveNumber),
      clockAfter: move.clockAfter,
      timeSpent: null,
      motifs,
    });
  }

  fillTimeSpent(moves, parsed.increment);

  return {
    moves,
    accuracyWhite: gameAccuracy(accuracies.white, winPercentsBefore.white),
    accuracyBlack: gameAccuracy(accuracies.black, winPercentsBefore.black),
    depth,
    engine: pool.engineName,
  };
}

function clampEval(cp: number): number {
  return Math.max(-MATE_CP, Math.min(MATE_CP, Math.round(cp)));
}

function terminalScore(fen: string): { cp: number; mate: number | null; pv: string[] } | null {
  const position = safeChess(fen);
  if (!position || !position.isGameOver()) return null;
  // Scores are always from the side to move: being mated is the worst case.
  if (position.isCheckmate()) return { cp: -MATE_CP, mate: 0, pv: [] };
  return { cp: 0, mate: null, pv: [] };
}

function countLegalMoves(fen: string): number {
  const position = safeChess(fen);
  return position ? position.moves().length : 0;
}

/**
 * What the classifier needs about one move — and nothing the engine has to be run
 * again to learn.
 *
 * Every field here is a column the database already holds, which makes the verdict a
 * pure function of stored analysis rather than a by-product of the search that
 * produced it. That is what lets a change to the rules reach games analysed months
 * ago in a second, instead of an afternoon of re-running Stockfish over them.
 *
 * `analyseGame` calls this too, so the live path and the rewrite path cannot drift.
 */
export interface MoveFacts {
  fenBefore: string;
  fenAfter: string;
  uci: string;
  /** Centipawns from the mover's point of view, exactly as stored. */
  evalBefore: number;
  evalAfter: number;
  bestUci: string | null;
}

export function classifyStoredMove(facts: MoveFacts): Classification {
  return classifyMove({
    winPercentBefore: winPercent(facts.evalBefore),
    winPercentAfter: winPercent(facts.evalAfter),
    playedUci: facts.uci,
    bestUci: facts.bestUci,
    forced: countLegalMoves(facts.fenBefore) === 1,
    sacrifice: isSacrifice(facts.fenBefore, facts.fenAfter, facts.uci),
    cpAfter: facts.evalAfter,
  });
}

/**
 * Static exchange evaluation: what the side to move nets by starting a capture
 * sequence on one square, in pawns, assuming both sides always take with their
 * cheapest piece and stop as soon as taking stops paying.
 *
 * Reading it off `moves()` rather than `attackers()` is the point. `attackers()` is
 * pseudo-legal — it counts pinned pieces, and it counts a king standing beside a
 * defended square, which cannot capture into check. Legal moves answer the question
 * that was actually being asked, and pins and illegal king captures fall out for
 * free rather than needing cases of their own.
 *
 * Promotions during an exchange are valued as the pawn they start as, which
 * understates a rare tactic in the direction of calling fewer moves sacrifices.
 */
function exchangeValue(board: Chess, square: string): number {
  const takes = board
    .moves({ verbose: true })
    .filter((move) => move.to === square && move.captured);
  if (takes.length === 0) return 0;

  let cheapest = takes[0]!;
  for (const take of takes) {
    if ((PIECE_VALUE[take.piece] ?? 0) < (PIECE_VALUE[cheapest.piece] ?? 0)) cheapest = take;
  }

  const gain = PIECE_VALUE[cheapest.captured ?? 'p'] ?? 0;
  board.move({ from: cheapest.from, to: cheapest.to, promotion: cheapest.promotion });
  const reply = exchangeValue(board, square);
  board.undo();

  // Standing pat is always allowed: nobody is obliged to continue a losing trade.
  return Math.max(0, gain - reply);
}

/**
 * True when the move leaves material the opponent can profitably take.
 *
 * This used to be a two-ply guess — the piece's own value, less what it captured,
 * less one recapture — driven by `attackers()`. It was wrong at both ends.
 *
 * It called moves sacrifices that risked nothing. `PIECE_VALUE.k` is 0, so an enemy
 * king beside the square came out as the cheapest attacker and set the recapture
 * value to zero, even when the king was forbidden to enter. Five of the nine moves
 * labelled brilliant in the development database were that shape: three of them a
 * bishop giving check from a square the king could not take on, evaluation unmoved
 * at 0.00 either side of the "sacrifice".
 *
 * And, reading only one recapture deep, it could not see a real sacrifice through to
 * the end of the exchange. Morphy's 13. Rxd7 in the Opera Game is two pawns down
 * once the swap finishes, and four ply are needed to find that out.
 *
 * A full exchange evaluation answers both, so the rule is now simply: after the move,
 * does the opponent come out at least two pawns ahead by taking?
 */
function isSacrifice(fenBefore: string, fenAfter: string, uci: string): boolean {
  const after = safeChess(fenAfter);
  if (!after) return false;

  const probe = safeChess(fenBefore);
  if (!probe) return false;
  const played = applyUci(probe, uci);
  // A king cannot be given up, so it cannot be sacrificed.
  if (!played || played.piece === 'k') return false;

  const captured = played.captured ? (PIECE_VALUE[played.captured] ?? 0) : 0;
  return exchangeValue(after, played.to) - captured >= 2;
}

function uciToSan(fen: string, uci: string): string | null {
  const position = safeChess(fen);
  if (!position) return null;
  const move = applyUci(position, uci);
  return move?.san ?? null;
}

/**
 * Clock readings are per player, so time spent on a move is the drop since that
 * player's previous move, with the increment they were just credited removed.
 */
function fillTimeSpent(moves: AnalysedMove[], increment: number): void {
  const previous: Record<Color, number | null> = { white: null, black: null };
  for (const move of moves) {
    if (move.clockAfter === null) continue;
    const last = previous[move.color];
    if (last !== null) {
      const spent = last - move.clockAfter + increment;
      move.timeSpent = spent >= 0 ? round1(spent) : null;
    }
    previous[move.color] = move.clockAfter;
  }
}
