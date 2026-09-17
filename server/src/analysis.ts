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
import type { AnalysedMove, Color, GameAnalysis } from './types.js';

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
  const depth = options.depth ?? Number(process.env.ANALYSIS_DEPTH ?? 16);
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

    const classification = classifyMove({
      winPercentBefore: wpBefore,
      winPercentAfter: wpAfter,
      playedUci: move.uci,
      bestUci,
      forced,
      sacrifice: isSacrifice(move.fenBefore, move.fenAfter, move.uci),
      cpAfter: evalAfter,
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

/** True when the move leaves material the opponent can simply take. */
function isSacrifice(fenBefore: string, fenAfter: string, uci: string): boolean {
  const before = safeChess(fenBefore);
  const after = safeChess(fenAfter);
  if (!before || !after) return false;

  const probe = safeChess(fenBefore);
  if (!probe) return false;
  const played = applyUci(probe, uci);
  if (!played || played.piece === 'k') return false;

  const mover = played.color;
  const opponent = mover === 'w' ? 'b' : 'w';
  const captured = played.captured ? (PIECE_VALUE[played.captured] ?? 0) : 0;
  const risked = PIECE_VALUE[played.piece] ?? 0;

  const attackers = after.attackers(played.to, opponent);
  if (attackers.length === 0) return false;
  const cheapestAttacker = Math.min(
    ...attackers.map((square) => PIECE_VALUE[after.get(square)?.type ?? 'p'] ?? 1),
  );
  const defenders = after.attackers(played.to, mover).length;
  const recovered = defenders > 0 ? cheapestAttacker : 0;

  return risked - captured - recovered >= 2;
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
