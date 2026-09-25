/**
 * The shape of a game: one number per ply, from the player's point of view.
 *
 * This is the arithmetic behind the advantage graph on the review screen, kept out of
 * the component so it can be tested without a browser. It invents nothing — every
 * point is a stored evaluation run through the same logistic the accuracy figures use,
 * so the curve and the numbers beside the board can never disagree.
 */

import { winPercent } from '../../core/src/evaluation.js';
import type { Classification, Move } from './types.js';

export interface AdvantagePoint {
  /** 0 is the starting position, then one point per move played. */
  ply: number;
  /** The player's winning chances, 0–100. 50 is a dead level game. */
  share: number;
  /** Centipawns from the player's point of view. */
  cp: number;
  /** Moves to mate from the player's point of view, when the engine saw one. */
  mate: number | null;
  /** The move that produced this point — null only at the starting position. */
  move: Move | null;
}

/** Evaluations are stored from the mover's side; the whole screen reads them as yours. */
export function playerEval(move: Move, playerColor: 'white' | 'black'): { cp: number; mate: number | null } {
  const sign = move.color === playerColor ? 1 : -1;
  return {
    cp: move.eval_after * sign,
    mate: move.mate_after === null ? null : move.mate_after * sign,
  };
}

/**
 * The whole game as a line, starting from the level position before move one.
 *
 * The starting point matters: without it a game that opens with a blunder has nothing
 * to fall from, and the drop that is the entire point of the graph is invisible.
 */
export function advantageLine(moves: Move[], playerColor: 'white' | 'black'): AdvantagePoint[] {
  const points: AdvantagePoint[] = [{ ply: 0, share: 50, cp: 0, mate: null, move: null }];
  for (const move of moves) {
    const { cp, mate } = playerEval(move, playerColor);
    points.push({ ply: move.ply, share: winPercent(cp), cp, mate, move });
  }
  return points;
}

/**
 * Verdicts worth a dot on the line.
 *
 * Only the ones you would go looking for. Marking `best` and `good` as well would put
 * a dot on almost every move and the graph would stop pointing at anything.
 */
const MARKED = new Set<Classification>(['blunder', 'mistake', 'inaccuracy', 'brilliant']);

/** True for the player's own moves the graph should mark. */
export function isMarked(point: AdvantagePoint): boolean {
  return point.move !== null && point.move.is_player === 1 && MARKED.has(point.move.classification);
}

/**
 * The curve, in a viewBox that is `plies` wide and 100 tall.
 *
 * Y is inverted so that up is the player ahead — the same direction the eval strip
 * beside the board fills, and the same way round as the board itself, which is always
 * drawn from the player's side.
 */
export function advantageCurve(points: AdvantagePoint[]): string {
  return points.map((point, index) => `${index},${(100 - point.share).toFixed(2)}`).join(' ');
}
