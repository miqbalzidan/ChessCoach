import type { Classification, Phase, Score } from './types.js';

/** Mate scores are folded into centipawns so every comparison is one-dimensional. */
export const MATE_CP = 10000;

export function scoreToCp(score: Score): number {
  if (score.mate !== null) {
    const magnitude = MATE_CP - Math.min(Math.abs(score.mate), 50) * 10;
    return score.mate > 0 ? magnitude : -magnitude;
  }
  return score.cp ?? 0;
}

/**
 * Lichess' logistic conversion from centipawns to the chance of winning, which is
 * what actually matters: 300cp costs you far more at 0.0 than at +8.0, and raw
 * centipawn loss cannot express that.
 */
export function winPercent(cp: number): number {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/** Per-move accuracy, from the drop in winning chances the move caused. */
export function accuracyFromWinPercents(before: number, after: number): number {
  const drop = Math.max(0, before - after);
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Game accuracy weights each move by how volatile the position was around it, so a
 * quiet 40-move grind cannot dilute the two moves where the game was actually lost.
 */
export function gameAccuracy(moveAccuracies: number[], winPercentsBefore: number[]): number {
  if (moveAccuracies.length === 0) return 100;

  const windowSize = Math.max(2, Math.min(8, Math.ceil(winPercentsBefore.length / 10)));
  const weights = moveAccuracies.map((_, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const window = winPercentsBefore.slice(start, i + 1);
    return Math.max(0.5, Math.min(12, standardDeviation(window)));
  });

  const weightedSum = moveAccuracies.reduce((sum, a, i) => sum + a * weights[i]!, 0);
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  const weighted = weightedSum / weightTotal;
  const harmonic = harmonicMean(moveAccuracies);

  return round1(Math.max(0, Math.min(100, (weighted + harmonic) / 2)));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0.5;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function harmonicMean(values: number[]): number {
  const safe = values.map((v) => Math.max(v, 1));
  return safe.length / safe.reduce((sum, v) => sum + 1 / v, 0);
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ClassifyInput {
  /** Winning chances before the move, from the mover's point of view. */
  winPercentBefore: number;
  winPercentAfter: number;
  playedUci: string;
  bestUci: string | null;
  /** True when the mover had no choice — a forced move is never a mistake. */
  forced: boolean;
  /** True when the move gives up material that the engine still rates as best. */
  sacrifice: boolean;
  /** Eval after the move in centipawns, mover's point of view. */
  cpAfter: number;
}

/**
 * Thresholds are drops in winning chances rather than centipawn loss, so the same
 * label means the same thing in a sharp middlegame and in a dead-drawn rook ending.
 */
export const THRESHOLDS = {
  inaccuracy: 10,
  mistake: 20,
  blunder: 30,
  excellent: 2,
  good: 5,
} as const;

export function classifyMove(input: ClassifyInput): Classification {
  const loss = Math.max(0, input.winPercentBefore - input.winPercentAfter);
  const isBest = input.bestUci !== null && input.playedUci === input.bestUci;

  if (input.forced) return 'best';

  if (isBest || loss < THRESHOLDS.excellent) {
    // Brilliance is a sacrifice the engine itself would play — and only while the
    // game is still live, since throwing material into a won position is just
    // showing off.
    if (isBest && input.sacrifice && input.cpAfter > -50 && input.cpAfter < 600) {
      return 'brilliant';
    }
    return isBest ? 'best' : 'excellent';
  }

  if (loss >= THRESHOLDS.blunder) return 'blunder';
  if (loss >= THRESHOLDS.mistake) return 'mistake';
  if (loss >= THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (loss < THRESHOLDS.good) return 'excellent';
  return 'good';
}

export const PIECE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

/**
 * Phase is read off the board rather than the move number: a queenless four-piece
 * position is an endgame on move 18 just as much as on move 60.
 */
export function detectPhase(fen: string, moveNumber: number): Phase {
  const placement = fen.split(' ')[0] ?? '';
  let pieces = 0;
  for (const char of placement) {
    const lower = char.toLowerCase();
    if (lower === 'n' || lower === 'b' || lower === 'r' || lower === 'q') pieces += 1;
  }
  if (pieces <= 6) return 'endgame';
  if (moveNumber <= 12) return 'opening';
  return 'middlegame';
}

/** Non-pawn, non-king material for one side, in pawns. */
export function nonPawnMaterial(fen: string, color: 'white' | 'black'): number {
  const placement = fen.split(' ')[0] ?? '';
  let total = 0;
  for (const char of placement) {
    if (!/[a-zA-Z]/.test(char)) continue;
    const isWhite = char === char.toUpperCase();
    if ((color === 'white') !== isWhite) continue;
    const lower = char.toLowerCase();
    if (lower === 'p' || lower === 'k') continue;
    total += PIECE_VALUE[lower] ?? 0;
  }
  return total;
}
